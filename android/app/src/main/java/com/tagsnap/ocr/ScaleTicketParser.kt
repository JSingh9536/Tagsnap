package com.tagsnap.ocr

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The scale ticket parser.
 *
 * A port of `packages/shared/src/parse/parse.ts`, which is canonical and
 * carries the conformance suite. This is what replaced the vision model: it
 * runs on the phone in a few tens of milliseconds, on text ML Kit already
 * produced for free.
 *
 * The design constraint that shapes everything below: **it must be worse than
 * the model in a visible way rather than a plausible one.** A vision model that
 * misreads a ticket hands back a confident, well-formed, wrong number. A parser
 * that misreads one usually finds no label, or finds a value that fails a shape
 * test, and says null — which routes to a person. So every rule here prefers
 * "I did not find it" to "here is my best effort", and confidence is built up
 * from evidence rather than assumed and then discounted.
 *
 * How a field gets a value, in order of preference:
 *
 *   1. a label on the same line, value after it   — "NET WT 21.34"
 *   2. a label with the value to its right        — two columns
 *   3. a label with the value directly beneath it — a column header
 *   4. a shape heuristic with no label at all     — capped at 0.70, so it can
 *                                                   never clear the floors
 *
 * The ceiling comes from `PAY_CRITICAL_FLOOR` in validation.ts, which is 0.95.
 * A field that reaches that had a strong label, a clean numeric token, no
 * character repairs, and — for the weights — three numbers that agree.
 */
object ScaleTicketParser {

    // MARK: Output

    data class Field<T>(val value: T?, val confidence: Double)

    /**
     * Why a field ended up with the value it has.
     *
     * Rides along in `model_raw`, so that when a reviewer corrects a field the
     * office can see which line on the ticket the wrong value came from — a bad
     * label and a bad OCR read need different fixes.
     */
    data class Trace(
        val field: String,
        val label: String?,
        val source: String?,
        val how: String,
        val confidence: Double,
        val parts: Map<String, Double>,
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("field", field)
            put("label", label ?: JSONObject.NULL)
            put("source", source ?: JSONObject.NULL)
            put("how", how)
            put("confidence", confidence)
            put("parts", JSONObject(parts as Map<*, *>))
        }
    }

    data class Output(
        val ticketNumber: Field<String>,
        val tagDate: Field<String>,
        val tagTime: Field<String>,
        val quarryText: Field<String>,
        val materialText: Field<String>,
        val jobText: Field<String>,
        val truckNumber: Field<String>,
        val grossTons: Field<Double>,
        val tareTons: Field<Double>,
        val netTons: Field<Double>,
        val notes: Field<String>,
        val isScaleTicket: Boolean,
        val text: String,
        val trace: List<Trace>,
        val weightUnit: String?,
    ) {
        /** The `extracted` jsonb exactly as `apply_extraction()` reads it. */
        fun extractedJson(): JSONObject {
            fun <T> cell(f: Field<T>) = JSONObject().apply {
                put("value", f.value ?: JSONObject.NULL)
                put("confidence", f.confidence)
            }
            return JSONObject().apply {
                put("ticket_number", cell(ticketNumber))
                put("tag_date", cell(tagDate))
                put("tag_time", cell(tagTime))
                put("quarry_text", cell(quarryText))
                put("material_text", cell(materialText))
                put("job_text", cell(jobText))
                put("truck_number", cell(truckNumber))
                put("gross_tons", cell(grossTons))
                put("tare_tons", cell(tareTons))
                put("net_tons", cell(netTons))
                put("notes", cell(notes))
                put("is_scale_ticket", isScaleTicket)
            }
        }

        fun confidenceJson(): JSONObject = JSONObject().apply {
            put("ticket_number", ticketNumber.confidence)
            put("tag_date", tagDate.confidence)
            put("tag_time", tagTime.confidence)
            put("quarry_text", quarryText.confidence)
            put("material_text", materialText.confidence)
            put("job_text", jobText.confidence)
            put("truck_number", truckNumber.confidence)
            put("gross_tons", grossTons.confidence)
            put("tare_tons", tareTons.confidence)
            put("net_tons", netTons.confidence)
            put("notes", notes.confidence)
        }

        fun rawJson(lineCount: Int): JSONObject = JSONObject().apply {
            put("trace", JSONArray(trace.map { it.toJson() }))
            put("weight_unit", weightUnit ?: JSONObject.NULL)
            put("line_count", lineCount)
        }
    }

    // MARK: Tunables

    /** A heuristic match can never clear the floors on its own. Deliberate. */
    private const val HEURISTIC_CEILING = 0.70

    /** Nothing is ever certain. 0.99 leaves room to mean "as good as it gets". */
    private const val CEILING = 0.99

    /** How much of a line height counts as "the same row". */
    private const val ROW_TOLERANCE = 0.7

    /** How far below a label to look for its value, in line heights. */
    private const val BELOW_REACH = 1.8

    // MARK: Entry point

    fun parse(result: TextRecognizer.Result): Output {
        val lines = prepare(result.lines)
        val fullText = lines.joinToString("\n") { it.raw }
        val upper = TicketText.normalize(fullText)
        val notes = mutableListOf<String>()
        val trace = mutableListOf<Trace>()

        val ticketNumber = best(lines, TicketField.TICKET_NUMBER, ::readTicketNumber)
        val date = best(lines, TicketField.TAG_DATE) { text ->
            TicketText.readDate(text)?.let { Read(it.value, it.fit) }
        }
        val time = best(lines, TicketField.TAG_TIME) { text ->
            TicketText.readTime(text)?.let { Read(it.value, it.fit) }
        }

        val quarry = best(lines, TicketField.QUARRY_TEXT, ::readFreeText) ?: headerQuarry(lines)
        val material = best(lines, TicketField.MATERIAL_TEXT, ::readFreeText)
        val job = best(lines, TicketField.JOB_TEXT, ::readJob)
        val truck = best(lines, TicketField.TRUCK_NUMBER, ::readIdentifier)

        // Weights are read raw and resolved together: units, magnitude sanity
        // and the arithmetic check all need to see all three at once.
        val grossHit = best(lines, TicketField.GROSS_TONS, ::readWeight)
        val tareHit = best(lines, TicketField.TARE_TONS, ::readWeight)
        val netHit = best(lines, TicketField.NET_TONS, ::readWeight)

        val weights = resolveWeights(grossHit, tareHit, netHit, upper, notes)

        listOfNotNull(ticketNumber, date, time, quarry, material, job, truck)
            .forEach { trace += it.trace }
        trace += weights.trace

        // Anything a reviewer would want to know that has no field of its own.
        val marked = Regex("\\b(VOID|CORRECTED|REPRINT|DUPLICATE|AMENDED|REWEIGH)\\b")
        for (line in lines) {
            if (marked.containsMatchIn(line.norm)) {
                notes += "Ticket is marked: ${line.raw.trim()}"
            }
        }

        val weightsRead =
            listOfNotNull(weights.gross.value, weights.tare.value, weights.net.value).size
        val markers = Lexicon.ticketMarkers.count {
            Regex("\\b$it\\b").containsMatchIn(upper)
        }

        return Output(
            ticketNumber = cell(ticketNumber),
            tagDate = cell(date),
            tagTime = cell(time),
            quarryText = cell(quarry),
            materialText = cell(material),
            jobText = cell(job),
            truckNumber = cell(truck),
            grossTons = weights.gross,
            tareTons = weights.tare,
            netTons = weights.net,
            notes = Field(
                value = notes.takeIf { it.isNotEmpty() }?.joinToString(" "),
                // Notes are an observation about the parse, not a reading of
                // the ticket. Full confidence in "here is what I noticed" is
                // honest.
                confidence = if (notes.isEmpty()) 0.0 else 1.0
            ),
            // Used only to route to review, never to reject. A wrong "no" costs
            // a driver a pointless retake, so the bar is low on purpose.
            isScaleTicket = markers >= 3 || weightsRead >= 2,
            text = fullText,
            trace = trace,
            weightUnit = weights.unit,
        )
    }

    // MARK: Line preparation

    private data class Prepared(
        val index: Int,
        val raw: String,
        val norm: String,
        val box: Box,
        val conf: Double,
        val hasMoney: Boolean,
    )

    /** Normalised 0..1, origin top left, y growing downward. */
    data class Box(val x: Double, val y: Double, val width: Double, val height: Double) {
        val right get() = x + width
        val bottom get() = y + height
        val midY get() = y + height / 2
    }

    private fun prepare(lines: List<TextRecognizer.Line>): List<Prepared> =
        lines.mapIndexedNotNull { index, line ->
            val norm = TicketText.normalize(line.text)
            if (norm.isEmpty()) null
            else Prepared(
                index = index,
                raw = line.text,
                norm = norm,
                box = line.box,
                conf = line.confidence.coerceIn(0.0, 1.0),
                hasMoney = Lexicon.moneyMarkers.any { norm.contains(it) },
            )
        }.sortedWith(compareBy({ (it.box.y * 100).roundToInt() }, { it.box.x }))

    // MARK: Label matching

    private data class LabelHit(val spec: Lexicon.LabelSpec, val remainder: String)

    private val labelPatterns = mutableMapOf<String, Regex>()

    /**
     * `NET WT` becomes `(^|[^A-Z0-9])(NET[\s.:#*_-]+WT)(?![A-Z])` — tolerant of
     * the punctuation between the words, strict about the boundaries either
     * side. Those boundaries are what stop "SUBNET" matching NET.
     */
    private fun labelPattern(label: String): Regex = labelPatterns.getOrPut(label) {
        val words = label.split(" ").joinToString("[\\s.:#*_\\-]+") { Regex.escape(it) }
        Regex("(^|[^A-Z0-9])($words)(?![A-Z])")
    }

    /**
     * Find the strongest label for [field] on this line, and what follows it.
     *
     * The remainder comes from the *unmodified* normalised text, not from a
     * punctuation-stripped copy. That distinction is load-bearing: stripping
     * `.` to make labels match turns `48.32` into `48 32`, and the parser then
     * reads a ticket for forty-eight tons.
     */
    private fun labelOn(line: Prepared, field: TicketField): LabelHit? {
        for (spec in Lexicon.labels[field].orEmpty()) {
            val m = labelPattern(spec.label).find(line.norm) ?: continue
            val end = m.range.first + m.groupValues[1].length + m.groupValues[2].length
            val remainder = line.norm.substring(end).trim(' ', '.', ':', '#', '*', '_', '-')
            return LabelHit(spec, remainder)
        }
        return null
    }

    private data class Candidate(
        val text: String,
        val line: Prepared,
        val how: String,
        val proximity: Double,
        val spec: Lexicon.LabelSpec,
    )

    private fun candidates(lines: List<Prepared>, field: TicketField): List<Candidate> {
        val out = mutableListOf<Candidate>()

        for (line in lines) {
            val hit = labelOn(line, field) ?: continue

            // 1. the rest of this line
            if (hit.remainder.isNotEmpty()) {
                out += Candidate(hit.remainder, line, "label_same_line", 1.0, hit.spec)
            }

            // 2. the nearest thing to the right, on the same row
            val band = line.box.height * ROW_TOLERANCE
            lines.filter {
                it.index != line.index &&
                    it.box.x >= line.box.right - line.box.width * 0.1 &&
                    abs(it.box.midY - line.box.midY) <= band
            }.minByOrNull { it.box.x }?.let { right ->
                out += Candidate(
                    right.norm, right, "label_right",
                    // A neighbouring column is nearly as good as the same line,
                    // but not quite — a wide gap is how a value from the next
                    // field over gets picked up.
                    if (right.box.x - line.box.right < 0.15) 0.95 else 0.8,
                    hit.spec
                )
            }

            // 3. directly beneath, for column-header layouts
            lines.filter {
                it.index != line.index &&
                    it.box.y > line.box.y &&
                    it.box.y - line.box.bottom < line.box.height * BELOW_REACH &&
                    overlapX(it.box, line.box) > 0.4
            }.minByOrNull { it.box.y }?.let { below ->
                out += Candidate(below.norm, below, "label_below", 0.85, hit.spec)
            }
        }

        return out
    }

    private fun overlapX(a: Box, b: Box): Double {
        val left = max(a.x, b.x)
        val right = min(a.right, b.right)
        if (right <= left) return 0.0
        return (right - left) / min(a.width, b.width)
    }

    // MARK: Scoring

    private data class Read<T>(
        val value: T,
        val fit: Double,
        val unit: WeightUnit? = null,
        val raw: Double? = null,
    )

    private data class Hit<T>(
        val value: T,
        val confidence: Double,
        val trace: Trace,
        val raw: Double?,
        val unit: WeightUnit?,
    )

    private fun <T> best(
        lines: List<Prepared>,
        field: TicketField,
        read: (String) -> Read<T>?,
    ): Hit<T>? {
        var winner: Hit<T>? = null

        for (candidate in candidates(lines, field)) {
            // A candidate that is itself a label is a column header, not a
            // value. On a two-column ticket the row below a label is the *next*
            // label, and without this the truck number reads as the word
            // PRODUCT.
            if (candidate.text.trim() in Lexicon.allLabels) continue

            val got = read(candidate.text) ?: continue

            // A weight read off a line that also mentions money is very likely
            // the quarry's price. It stays a candidate — some tickets do put
            // the extension on the same row — but cannot beat a clean one.
            val moneyPenalty = if (candidate.line.hasMoney && field.isWeight) 0.35 else 1.0

            val parts = mapOf(
                "ocr" to candidate.line.conf,
                "label" to candidate.spec.weight,
                "fit" to got.fit,
                "proximity" to candidate.proximity,
                "money" to moneyPenalty,
            )

            val score = (candidate.line.conf * candidate.spec.weight *
                got.fit * candidate.proximity * moneyPenalty).coerceIn(0.0, CEILING)

            if (winner == null || score > winner.confidence) {
                winner = Hit(
                    value = got.value,
                    confidence = score,
                    trace = Trace(
                        field = field.wire,
                        label = candidate.spec.label,
                        source = candidate.line.raw,
                        how = candidate.how,
                        confidence = round3(score),
                        parts = parts,
                    ),
                    raw = got.raw,
                    unit = got.unit,
                )
            }
        }

        return winner
    }

    // MARK: Field readers

    private val ticketShape = Regex("^[A-Z]{0,3}-?\\d[\\dA-Z-]*$")
    private val timeShape = Regex("^\\d{1,2}[:.]\\d{2}")
    private val weightShape = Regex("^\\d+\\.\\d{1,2}$")

    /** The longest mostly-numeric token that is not a date, a time, or a weight. */
    private fun readTicketNumber(text: String): Read<String>? {
        for (token in TicketText.tokens(text)) {
            val stripped = token.trim('#', ':')
            if (stripped.length !in 3..16) continue
            if ((stripped.contains('-') || stripped.contains('/')) &&
                TicketText.readDate(stripped) != null
            ) continue
            if (timeShape.containsMatchIn(stripped)) continue
            if (weightShape.matches(stripped)) continue

            val digits = stripped.count { it.isDigit() }
            if (digits < 3) continue
            if (!ticketShape.matches(stripped)) continue

            val bare = stripped.replace("-", "").length
            val purity = if (bare == 0) 0.0 else digits.toDouble() / bare
            return Read(stripped, 0.7 + 0.3 * purity)
        }
        return null
    }

    /** Free text: a vendor, a material, a project name. */
    private fun readFreeText(text: String): Read<String>? {
        val cleaned = text.trim(' ', ':', '#', '-', '.')
        if (cleaned.length < 2) return null

        // A bare number is not a name. This is what stops "MATERIAL 57"
        // resolving to nothing useful while looking confident.
        if (cleaned.count { it.isLetter() } < 2) return null
        if (cleaned in Lexicon.headerNoise) return null

        // Long lines are usually an address or a legal footer that happened to
        // sit under the label, not the name itself.
        val fit = if (cleaned.length <= 40) 1.0 else 0.6
        return Read(cleaned.take(80), fit)
    }

    private val identifierShape = Regex("^[A-Z0-9][A-Z0-9\\-/]*$")

    /**
     * A truck or unit number: short, alphanumeric, containing a digit.
     *
     * The digit requirement keeps a neighbouring word from becoming a truck
     * number. Fleet numbering is always numeric somewhere — "118", "T-42" — and
     * a purely alphabetic token there is a label or OCR noise.
     */
    private fun readIdentifier(text: String): Read<String>? {
        for (token in TicketText.tokens(text)) {
            val stripped = token.trim('#', ':')
            if (stripped.isEmpty() || stripped.length > 12) continue
            if (!identifierShape.matches(stripped)) continue
            if (stripped.none { it.isDigit() }) continue
            if (TicketText.readDate(stripped) != null) continue
            if (Lexicon.unitTokens.containsKey(stripped)) continue

            // A single character is almost always noise from a box edge.
            return Read(stripped, if (stripped.length >= 2) 1.0 else 0.4)
        }
        return null
    }

    /** A job is either a name or a number, and both are common on one fleet. */
    private fun readJob(text: String): Read<String>? =
        if (text.count { it.isLetter() } >= 2) readFreeText(text) else readIdentifier(text)

    private val gluedUnit = Regex("([A-Z#]+)$")

    /**
     * A weight, plus whatever unit was printed beside it. Conversion to tons
     * needs all three weights, so it happens in [resolveWeights].
     */
    private fun readWeight(text: String): Read<Double>? {
        val ts = TicketText.tokens(text)

        for ((i, token) in ts.withIndex()) {
            val num = TicketText.readNumber(token) ?: continue
            if (num.value <= 0) continue

            var unit = ts.getOrNull(i + 1)?.let { Lexicon.unitTokens[it] }
            if (unit == null) {
                unit = gluedUnit.find(token)?.groupValues?.get(1)?.let { Lexicon.unitTokens[it] }
            }

            return Read(num.value, num.fit, unit, num.value)
        }
        return null
    }

    // MARK: The weight pass

    private data class WeightResult(
        val gross: Field<Double>,
        val tare: Field<Double>,
        val net: Field<Double>,
        val unit: String?,
        val trace: List<Trace>,
    )

    /**
     * Decide the unit, convert, and let the three numbers vote on each other.
     *
     * The arithmetic check is the single most valuable thing in this file.
     * Three numbers that agree to within a hundredth of a ton were almost
     * certainly all read correctly; if one digit had been misread they would
     * not. That is a real verification, not a heuristic, and it is what lets a
     * deterministic parser reach the 0.95 floor pay-critical fields are held to.
     */
    private fun resolveWeights(
        grossHit: Hit<Double>?,
        tareHit: Hit<Double>?,
        netHit: Hit<Double>?,
        upperText: String,
        notes: MutableList<String>,
    ): WeightResult {

        val trace = listOfNotNull(grossHit, tareHit, netHit).map { it.trace }
        val printed = listOfNotNull(grossHit?.raw, tareHit?.raw, netHit?.raw)
        val explicit = listOfNotNull(grossHit?.unit, tareHit?.unit, netHit?.unit)

        var unit: WeightUnit? = null
        var unitFit = 1.0

        when {
            WeightUnit.CUBIC_YARD in explicit -> {
                // Density varies by material by enough that a fixed factor
                // would be a guess with a dollar sign attached.
                notes += "This ticket appears to be measured in cubic yards, " +
                    "not tons. Someone needs to confirm the tonnage."
                unitFit = 0.3
            }
            WeightUnit.POUND in explicit -> unit = WeightUnit.POUND
            WeightUnit.TON in explicit -> unit = WeightUnit.TON
            printed.isNotEmpty() -> {
                // No unit printed anywhere. Magnitude decides: a loaded truck
                // is 60,000-90,000 lb or 30-45 tons, and those do not overlap.
                val largest = printed.max()
                when {
                    largest >= 1000 -> unit = WeightUnit.POUND
                    largest <= 200 -> unit = WeightUnit.TON
                    else -> {
                        // Neither. Something was misread; do not pick a side.
                        unitFit = 0.4
                        notes += "Weights read as ${printed.joinToString(", ") { trim(it) }} " +
                            "— too large for tons and too small for pounds. Check the photo."
                    }
                }
                if (unit == WeightUnit.POUND &&
                    !upperText.contains("LB") && !upperText.contains("#")
                ) {
                    // Inferred from magnitude with nothing on the ticket
                    // confirming it.
                    unitFit = 0.9
                }
            }
        }

        fun toTons(v: Double?): Double? {
            if (v == null || unit == null) return null
            return round2(if (unit == WeightUnit.POUND) v / 2000 else v)
        }

        if (unit == WeightUnit.POUND && printed.isNotEmpty()) {
            notes += "Weights were printed in pounds and converted to tons."
        }

        val gross = toTons(grossHit?.raw)
        val tare = toTons(tareHit?.raw)
        val net = toTons(netHit?.raw)

        var gConf = (grossHit?.confidence ?: 0.0) * unitFit
        var tConf = (tareHit?.confidence ?: 0.0) * unitFit
        var nConf = (netHit?.confidence ?: 0.0) * unitFit

        if (gross != null && tare != null && net != null) {
            val drift = abs(gross - tare - net)

            if (drift <= 0.05) {
                // Genuine independent confirmation of all three, and the only
                // route by which this parser reaches the pay-critical floor.
                gConf = min(CEILING, gConf * 1.2)
                tConf = min(CEILING, tConf * 1.2)
                nConf = min(CEILING, nConf * 1.2)
            } else {
                // At least one is wrong and there is no way to tell which.
                gConf *= 0.5
                tConf *= 0.5
                nConf *= 0.5
                notes += "Gross minus tare is ${trim2(gross - tare)} t but net reads " +
                    "${trim2(net)} t — off by ${trim2(drift)} t."
            }

            // A tare heavier than the gross is a swapped pair, not a small
            // error.
            if (tare > gross) {
                notes += "Tare reads heavier than gross. The two may be swapped."
                gConf *= 0.4
                tConf *= 0.4
            }
        } else if (gross != null && tare != null) {
            // Deliberately NOT computed. Gross minus tare is what the ticket
            // says net *should* be, not what it says net *is* — and net is the
            // number that gets paid. A reviewer types it from the photo, which
            // takes three seconds and keeps a machine's arithmetic out of a
            // financial record.
            notes += "Net was not readable. Gross minus tare would be " +
                "${trim2(gross - tare)} t — confirm against the photo."
        }

        // Two fields reading the same number usually means one label found the
        // other field's value.
        if (gross != null && net != null && gross == net) {
            gConf *= 0.5
            nConf *= 0.5
            notes += "Gross and net read as the same number."
        }

        return WeightResult(
            gross = Field(gross, round3(gConf)),
            tare = Field(tare, round3(tConf)),
            net = Field(net, round3(nConf)),
            unit = when (unit) {
                WeightUnit.POUND -> "lb"
                WeightUnit.TON -> "ton"
                else -> null
            },
            trace = trace,
        )
    }

    // MARK: Fallbacks

    /**
     * The quarry name when no label found it.
     *
     * Scale tickets put the vendor's name at the top in the largest type on the
     * page, which is a shape the geometry can find even when the words mean
     * nothing to the lexicon. Capped at the heuristic ceiling so it always
     * reaches a person — but a person with the right answer already typed in,
     * and one correction teaches `learn_alias()` the vendor's printed name for
     * every future ticket.
     */
    private fun headerQuarry(lines: List<Prepared>): Hit<String>? {
        val chosen = lines.filter {
            it.box.y < 0.25 &&
                it.norm.length >= 4 &&
                it.norm.count { c -> c.isLetter() } >= 3 &&
                Lexicon.headerNoise.none { noise -> it.norm.contains(noise) }
        }.sortedWith(
            compareByDescending<Prepared> { it.box.height }.thenBy { it.box.y }
        ).firstOrNull() ?: return null

        val score = min(HEURISTIC_CEILING, chosen.conf * 0.8)

        return Hit(
            value = chosen.raw.trim().take(80),
            confidence = score,
            trace = Trace(
                field = TicketField.QUARRY_TEXT.wire,
                label = null,
                source = chosen.raw,
                how = "heuristic",
                confidence = round3(score),
                parts = mapOf("ocr" to chosen.conf, "heuristic" to 0.8),
            ),
            raw = null,
            unit = null,
        )
    }

    // MARK: Helpers

    private fun <T> cell(hit: Hit<T>?): Field<T> =
        if (hit == null) Field(null, 0.0) else Field(hit.value, round3(hit.confidence))

    private fun round3(v: Double) = kotlin.math.round(v * 1000) / 1000
    private fun round2(v: Double) = kotlin.math.round(v * 100) / 100

    /** `%g`-ish: whole numbers without a trailing `.0`. */
    private fun trim(v: Double) =
        if (v == kotlin.math.floor(v)) v.toLong().toString() else v.toString()

    private fun trim2(v: Double) = "%.2f".format(round2(v))
}
