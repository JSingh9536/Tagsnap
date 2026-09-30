import CoreGraphics
import Foundation

/// The scale ticket parser.
///
/// A port of `packages/shared/src/parse/parse.ts`, which is canonical and has
/// the conformance suite. This is what replaced the vision model: it runs on
/// the phone in about forty milliseconds, on text Apple's Vision framework
/// already produced for free.
///
/// The design constraint that shapes everything below: **it must be worse than
/// the model in a visible way rather than a plausible one.** A vision model
/// that misreads a ticket hands back a confident, well-formed, wrong number. A
/// parser that misreads one usually finds no label, or finds a value that
/// fails a shape test, and says nil — which routes to a person. So every rule
/// here prefers "I did not find it" to "here is my best effort", and
/// confidence is built up from evidence rather than assumed and discounted.
///
/// How a field gets a value, in order of preference:
///
///   1. a label on the same line, value after it   — "NET WT 21.34"
///   2. a label with the value to its right        — two columns
///   3. a label with the value directly beneath it — a column header
///   4. a shape heuristic with no label at all     — capped at 0.70, so it can
///                                                   never clear the floors
///
/// The ceiling comes from `PAY_CRITICAL_FLOOR` in validation.ts, which is
/// 0.95. A field that reaches that had a strong label, a clean numeric token,
/// no character repairs, and — for the weights — three numbers that agree with
/// each other.
enum ScaleTicketParser {

    // MARK: - Output

    struct Field<T> {
        let value: T?
        let confidence: Double

        static func empty() -> Field<T> { Field(value: nil, confidence: 0) }
    }

    /// Why a field ended up with the value it has.
    ///
    /// Rides along in `model_raw`, so that when a reviewer corrects a field
    /// the office can see which line on the ticket the wrong value came from —
    /// a bad label and a bad OCR read need different fixes.
    struct Trace {
        let field: String
        let label: String?
        let source: String?
        let how: String
        let confidence: Double
        let parts: [String: Double]

        var json: [String: Any] {
            [
                "field": field,
                "label": label ?? NSNull(),
                "source": source ?? NSNull(),
                "how": how,
                "confidence": confidence,
                "parts": parts,
            ]
        }
    }

    struct Output {
        let ticketNumber: Field<String>
        let tagDate: Field<String>
        let tagTime: Field<String>
        let quarryText: Field<String>
        let materialText: Field<String>
        let jobText: Field<String>
        let truckNumber: Field<String>
        let grossTons: Field<Double>
        let tareTons: Field<Double>
        let netTons: Field<Double>
        let notes: Field<String>
        let isScaleTicket: Bool

        let text: String
        let trace: [Trace]
        let weightUnit: String?

        /// The `extracted` jsonb exactly as `apply_extraction()` reads it.
        var extractedJSON: [String: Any] {
            func cell<T>(_ f: Field<T>) -> [String: Any] {
                ["value": f.value ?? NSNull(), "confidence": f.confidence]
            }
            return [
                "ticket_number": cell(ticketNumber),
                "tag_date": cell(tagDate),
                "tag_time": cell(tagTime),
                "quarry_text": cell(quarryText),
                "material_text": cell(materialText),
                "job_text": cell(jobText),
                "truck_number": cell(truckNumber),
                "gross_tons": cell(grossTons),
                "tare_tons": cell(tareTons),
                "net_tons": cell(netTons),
                "notes": cell(notes),
                "is_scale_ticket": isScaleTicket,
            ]
        }

        var confidenceJSON: [String: Any] {
            [
                "ticket_number": ticketNumber.confidence,
                "tag_date": tagDate.confidence,
                "tag_time": tagTime.confidence,
                "quarry_text": quarryText.confidence,
                "material_text": materialText.confidence,
                "job_text": jobText.confidence,
                "truck_number": truckNumber.confidence,
                "gross_tons": grossTons.confidence,
                "tare_tons": tareTons.confidence,
                "net_tons": netTons.confidence,
                "notes": notes.confidence,
            ]
        }
    }

    // MARK: - Tunables

    /// A heuristic match can never clear the floors on its own. Deliberate.
    private static let heuristicCeiling = 0.70

    /// Nothing is ever certain. 0.99 leaves room to mean "as good as it gets".
    private static let ceiling = 0.99

    /// How much of a line height counts as "the same row".
    private static let rowTolerance = 0.7

    /// How far below a label to look for its value, in line heights.
    private static let belowReach = 1.8

    // MARK: - Entry point

    static func parse(_ result: TextRecognizer.Result) -> Output {
        let lines = prepare(result.lines)
        let fullText = lines.map(\.raw).joined(separator: "\n")
        let upper = TicketText.normalize(fullText)
        var notes: [String] = []
        var trace: [Trace] = []

        let ticketNumber = best(lines, .ticketNumber, readTicketNumber)
        let date = best(lines, .tagDate) { text, _ in
            TicketText.readDate(text).map { Read(value: $0.value, fit: $0.fit) }
        }
        let time = best(lines, .tagTime) { text, _ in
            TicketText.readTime(text).map { Read(value: $0.value, fit: $0.fit) }
        }

        let quarry = best(lines, .quarryText, readFreeText) ?? headerQuarry(lines)
        let material = best(lines, .materialText, readFreeText)
        let job = best(lines, .jobText, readJob)
        let truck = best(lines, .truckNumber, readIdentifier)

        // Weights are read raw and resolved together: units, magnitude sanity
        // and the arithmetic check all need to see all three at once.
        let grossHit = best(lines, .grossTons, readWeight)
        let tareHit = best(lines, .tareTons, readWeight)
        let netHit = best(lines, .netTons, readWeight)

        let weights = resolveWeights(grossHit, tareHit, netHit, upper, &notes)

        for hit in [ticketNumber, date, time, quarry, material, job, truck] {
            if let hit { trace.append(hit.trace) }
        }
        trace.append(contentsOf: weights.trace)

        // Anything a reviewer would want to know that has no field of its own.
        for line in lines
        where TicketText.match(line.norm, #"\b(VOID|CORRECTED|REPRINT|DUPLICATE|AMENDED|REWEIGH)\b"#) != nil {
            notes.append("Ticket is marked: \(line.raw.trimmingCharacters(in: .whitespaces))")
        }

        let weightsRead = [weights.gross.value, weights.tare.value, weights.net.value]
            .compactMap { $0 }.count
        let markers = Lexicon.ticketMarkers.filter {
            TicketText.match(upper, "\\b\($0)\\b") != nil
        }.count

        return Output(
            ticketNumber: cell(ticketNumber),
            tagDate: cell(date),
            tagTime: cell(time),
            quarryText: cell(quarry),
            materialText: cell(material),
            jobText: cell(job),
            truckNumber: cell(truck),
            grossTons: weights.gross,
            tareTons: weights.tare,
            netTons: weights.net,
            notes: Field(
                value: notes.isEmpty ? nil : notes.joined(separator: " "),
                // Notes are an observation about the parse, not a reading of
                // the ticket. Full confidence in "here is what I noticed" is
                // honest.
                confidence: notes.isEmpty ? 0 : 1
            ),
            // Used only to route to review, never to reject. A wrong "no"
            // costs a driver a pointless retake, so the bar is low on purpose.
            isScaleTicket: markers >= 3 || weightsRead >= 2,
            text: fullText,
            trace: trace,
            weightUnit: weights.unit
        )
    }

    // MARK: - Line preparation

    private struct Prepared {
        let index: Int
        let raw: String
        let norm: String
        let box: CGRect
        let conf: Double
        let hasMoney: Bool
    }

    private static func prepare(_ lines: [TextRecognizer.Line]) -> [Prepared] {
        lines.enumerated().compactMap { index, line -> Prepared? in
            let norm = TicketText.normalize(line.text)
            guard !norm.isEmpty else { return nil }
            return Prepared(
                index: index,
                raw: line.text,
                norm: norm,
                box: line.box,
                conf: min(1, max(0, line.confidence)),
                hasMoney: Lexicon.moneyMarkers.contains { norm.contains($0) }
            )
        }
        .sorted {
            abs($0.box.minY - $1.box.minY) < 0.01
                ? $0.box.minX < $1.box.minX
                : $0.box.minY < $1.box.minY
        }
    }

    // MARK: - Label matching

    private struct LabelHit {
        let spec: Lexicon.LabelSpec
        let remainder: String
    }

    /// Find the strongest label for `field` on this line, and what follows it.
    ///
    /// The remainder comes from the *unmodified* normalised text, not from a
    /// punctuation-stripped copy. That distinction is load-bearing: stripping
    /// `.` to make labels match turns `48.32` into `48 32`, and the parser
    /// then reads a ticket for forty-eight tons.
    ///
    /// The boundaries in the pattern are what stop "SUBNET" matching NET and
    /// "GROSSLY" matching GROSS.
    private static func labelOn(_ line: Prepared, _ field: TicketField) -> LabelHit? {
        for spec in Lexicon.labels[field] ?? [] {
            let words = spec.label.split(separator: " ").map {
                NSRegularExpression.escapedPattern(for: String($0))
            }
            let pattern = "(^|[^A-Z0-9])(" + words.joined(separator: "[\\s.:#*_\\-]+") + ")(?![A-Z])"

            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let m = regex.firstMatch(
                    in: line.norm,
                    range: NSRange(line.norm.startIndex..., in: line.norm)
                  ),
                  let whole = Range(m.range(at: 2), in: line.norm)
            else { continue }

            let remainder = String(line.norm[whole.upperBound...])
                .trimmingCharacters(in: CharacterSet(charactersIn: " .:#*_-"))

            return LabelHit(spec: spec, remainder: remainder)
        }
        return nil
    }

    private struct Candidate {
        let text: String
        let line: Prepared
        let how: String
        let proximity: Double
        let spec: Lexicon.LabelSpec
    }

    private static func candidates(_ lines: [Prepared], _ field: TicketField) -> [Candidate] {
        var out: [Candidate] = []

        for line in lines {
            guard let hit = labelOn(line, field) else { continue }

            // 1. the rest of this line
            if !hit.remainder.isEmpty {
                out.append(Candidate(
                    text: hit.remainder, line: line,
                    how: "label_same_line", proximity: 1, spec: hit.spec
                ))
            }

            // 2. the nearest thing to the right, on the same row
            let band = line.box.height * rowTolerance
            if let right = lines
                .filter({
                    $0.index != line.index
                        && $0.box.minX >= line.box.maxX - line.box.width * 0.1
                        && abs($0.box.midY - line.box.midY) <= band
                })
                .min(by: { $0.box.minX < $1.box.minX }) {

                out.append(Candidate(
                    text: right.norm, line: right, how: "label_right",
                    // A neighbouring column is nearly as good as the same
                    // line, but not quite — a wide gap is how a value from the
                    // next field over gets picked up.
                    proximity: right.box.minX - line.box.maxX < 0.15 ? 0.95 : 0.8,
                    spec: hit.spec
                ))
            }

            // 3. directly beneath, for column-header layouts
            if let below = lines
                .filter({
                    $0.index != line.index
                        && $0.box.minY > line.box.minY
                        && $0.box.minY - line.box.maxY < line.box.height * belowReach
                        && overlapX($0.box, line.box) > 0.4
                })
                .min(by: { $0.box.minY < $1.box.minY }) {

                out.append(Candidate(
                    text: below.norm, line: below,
                    how: "label_below", proximity: 0.85, spec: hit.spec
                ))
            }
        }

        return out
    }

    private static func overlapX(_ a: CGRect, _ b: CGRect) -> Double {
        let left = max(a.minX, b.minX)
        let right = min(a.maxX, b.maxX)
        guard right > left else { return 0 }
        return Double((right - left) / min(a.width, b.width))
    }

    // MARK: - Scoring

    private struct Read<T> {
        let value: T
        let fit: Double
        var unit: Lexicon.Unit?
        var raw: Double?

        init(value: T, fit: Double, unit: Lexicon.Unit? = nil, raw: Double? = nil) {
            self.value = value
            self.fit = fit
            self.unit = unit
            self.raw = raw
        }
    }

    private struct Hit<T> {
        let value: T
        let confidence: Double
        let trace: Trace
        let raw: Double?
        let unit: Lexicon.Unit?
    }

    private static func best<T>(
        _ lines: [Prepared],
        _ field: TicketField,
        _ read: (String, Prepared) -> Read<T>?
    ) -> Hit<T>? {
        var winner: Hit<T>?

        for candidate in candidates(lines, field) {
            // A candidate that is itself a label is a column header, not a
            // value. On a two-column ticket the row below a label is the
            // *next* label, and without this the truck number reads as the
            // word PRODUCT.
            if Lexicon.allLabels.contains(candidate.text.trimmingCharacters(in: .whitespaces)) {
                continue
            }
            guard let got = read(candidate.text, candidate.line) else { continue }

            // A weight read off a line that also mentions money is very likely
            // the quarry's price. It stays a candidate — some tickets do put
            // the extension on the same row — but cannot beat a clean one.
            let moneyPenalty = (candidate.line.hasMoney && field.isWeight) ? 0.35 : 1.0

            let parts: [String: Double] = [
                "ocr": candidate.line.conf,
                "label": candidate.spec.weight,
                "fit": got.fit,
                "proximity": candidate.proximity,
                "money": moneyPenalty,
            ]

            let score = min(
                ceiling,
                max(0, candidate.line.conf * candidate.spec.weight
                    * got.fit * candidate.proximity * moneyPenalty)
            )

            if winner == nil || score > winner!.confidence {
                winner = Hit(
                    value: got.value,
                    confidence: score,
                    trace: Trace(
                        field: field.rawValue,
                        label: candidate.spec.label,
                        source: candidate.line.raw,
                        how: candidate.how,
                        confidence: round3(score),
                        parts: parts
                    ),
                    raw: got.raw,
                    unit: got.unit
                )
            }
        }

        return winner
    }

    // MARK: - Field readers

    /// The longest mostly-numeric token that is not a date, a time, or a weight.
    private static func readTicketNumber(_ text: String, _ line: Prepared) -> Read<String>? {
        for token in TicketText.tokens(text) {
            let stripped = token.trimmingCharacters(in: CharacterSet(charactersIn: "#:"))
            guard stripped.count >= 3, stripped.count <= 16 else { continue }
            if stripped.contains("-") || stripped.contains("/"),
               TicketText.readDate(stripped) != nil { continue }
            if TicketText.match(stripped, #"^\d{1,2}[:.]\d{2}"#) != nil { continue }
            if TicketText.match(stripped, #"^\d+\.\d{1,2}$"#) != nil { continue }

            let digits = stripped.filter(\.isNumber).count
            guard digits >= 3 else { continue }
            guard TicketText.match(stripped, #"^[A-Z]{0,3}[-]?\d[\dA-Z-]*$"#) != nil else { continue }

            let bare = stripped.replacingOccurrences(of: "-", with: "").count
            let purity = bare == 0 ? 0 : Double(digits) / Double(bare)
            return Read(value: stripped, fit: 0.7 + 0.3 * purity)
        }
        return nil
    }

    /// Free text: a vendor, a material, a project name.
    private static func readFreeText(_ text: String, _ line: Prepared) -> Read<String>? {
        let cleaned = text
            .trimmingCharacters(in: CharacterSet(charactersIn: " :#-."))
        guard cleaned.count >= 2 else { return nil }

        // A bare number is not a name. This is what stops "MATERIAL 57"
        // resolving to nothing useful while looking confident.
        guard cleaned.filter({ $0.isLetter }).count >= 2 else { return nil }
        guard !Lexicon.headerNoise.contains(cleaned) else { return nil }

        // Long lines are usually an address or a legal footer that happened to
        // sit under the label, not the name itself.
        let fit = cleaned.count <= 40 ? 1.0 : 0.6
        return Read(value: String(cleaned.prefix(80)), fit: fit)
    }

    /// A truck or unit number: short, alphanumeric, containing a digit.
    ///
    /// The digit requirement keeps a neighbouring word from becoming a truck
    /// number. Fleet numbering is always numeric somewhere — "118", "T-42" —
    /// and a purely alphabetic token there is a label or OCR noise.
    private static func readIdentifier(_ text: String, _ line: Prepared) -> Read<String>? {
        for token in TicketText.tokens(text) {
            let stripped = token.trimmingCharacters(in: CharacterSet(charactersIn: "#:"))
            guard !stripped.isEmpty, stripped.count <= 12 else { continue }
            guard TicketText.match(stripped, #"^[A-Z0-9][A-Z0-9\-/]*$"#) != nil else { continue }
            guard stripped.contains(where: \.isNumber) else { continue }
            guard TicketText.readDate(stripped) == nil else { continue }
            guard Lexicon.unitTokens[stripped] == nil else { continue }

            // A single character is almost always noise from a box edge.
            return Read(value: stripped, fit: stripped.count >= 2 ? 1 : 0.4)
        }
        return nil
    }

    /// A job is either a name or a number, and both are common on one fleet.
    private static func readJob(_ text: String, _ line: Prepared) -> Read<String>? {
        text.filter(\.isLetter).count >= 2
            ? readFreeText(text, line)
            : readIdentifier(text, line)
    }

    /// A weight, plus whatever unit was printed beside it. Conversion to tons
    /// needs all three weights, so it happens in `resolveWeights`.
    private static func readWeight(_ text: String, _ line: Prepared) -> Read<Double>? {
        let ts = TicketText.tokens(text)

        for (i, token) in ts.enumerated() {
            guard let num = TicketText.readNumber(token), num.value > 0 else { continue }

            var unit: Lexicon.Unit?
            if i + 1 < ts.count, let next = Lexicon.unitTokens[ts[i + 1]] { unit = next }
            if unit == nil,
               let suffix = TicketText.match(token, #"([A-Z#]+)$"#)?[1],
               let glued = Lexicon.unitTokens[suffix] {
                unit = glued
            }

            return Read(value: num.value, fit: num.fit, unit: unit, raw: num.value)
        }
        return nil
    }

    // MARK: - The weight pass

    private struct WeightResult {
        let gross: Field<Double>
        let tare: Field<Double>
        let net: Field<Double>
        let unit: String?
        let trace: [Trace]
    }

    /// Decide the unit, convert, and let the three numbers vote on each other.
    ///
    /// The arithmetic check is the single most valuable thing in this file.
    /// Three numbers that agree to within a hundredth of a ton were almost
    /// certainly all read correctly; if one digit had been misread they would
    /// not. That is a real verification, not a heuristic, and it is what lets
    /// a deterministic parser reach the 0.95 floor pay-critical fields are
    /// held to.
    private static func resolveWeights(
        _ grossHit: Hit<Double>?,
        _ tareHit: Hit<Double>?,
        _ netHit: Hit<Double>?,
        _ upperText: String,
        _ notes: inout [String]
    ) -> WeightResult {

        var trace: [Trace] = []
        for hit in [grossHit, tareHit, netHit] { if let hit { trace.append(hit.trace) } }

        let printed = [grossHit?.raw, tareHit?.raw, netHit?.raw].compactMap { $0 }
        let explicit = [grossHit?.unit, tareHit?.unit, netHit?.unit].compactMap { $0 }

        var unit: Lexicon.Unit?
        var unitFit = 1.0

        if explicit.contains(.cubicYard) {
            // Density varies by material by enough that a fixed factor would
            // be a guess with a dollar sign attached. This goes to a person.
            notes.append(
                "This ticket appears to be measured in cubic yards, not tons. Someone needs to confirm the tonnage."
            )
            unit = nil
            unitFit = 0.3
        } else if explicit.contains(.pound) {
            unit = .pound
        } else if explicit.contains(.ton) {
            unit = .ton
        } else if let largest = printed.max() {
            // No unit printed anywhere. Magnitude decides: a loaded truck is
            // 60,000-90,000 lb or 30-45 tons, and those ranges do not overlap.
            if largest >= 1000 {
                unit = .pound
            } else if largest <= 200 {
                unit = .ton
            } else {
                // Neither. Something was misread; do not pick a side.
                unit = nil
                unitFit = 0.4
                let list = printed.map { String(format: "%g", $0) }.joined(separator: ", ")
                notes.append(
                    "Weights read as \(list) — too large for tons and too small for pounds. Check the photo."
                )
            }

            if unit == .pound, !upperText.contains("LB"), !upperText.contains("#") {
                // Inferred from magnitude with nothing on the ticket
                // confirming it.
                unitFit = 0.9
            }
        }

        func toTons(_ v: Double?) -> Double? {
            guard let v, let unit else { return nil }
            return round2(unit == .pound ? v / 2000 : v)
        }

        if unit == .pound, !printed.isEmpty {
            notes.append("Weights were printed in pounds and converted to tons.")
        }

        let gross = toTons(grossHit?.raw)
        let tare = toTons(tareHit?.raw)
        let net = toTons(netHit?.raw)

        var gConf = (grossHit?.confidence ?? 0) * unitFit
        var tConf = (tareHit?.confidence ?? 0) * unitFit
        var nConf = (netHit?.confidence ?? 0) * unitFit

        if let gross, let tare, let net {
            let drift = abs(gross - tare - net)

            if drift <= 0.05 {
                // Genuine independent confirmation of all three, and the only
                // route by which this parser reaches the pay-critical floor.
                gConf = min(ceiling, gConf * 1.2)
                tConf = min(ceiling, tConf * 1.2)
                nConf = min(ceiling, nConf * 1.2)
            } else {
                // At least one is wrong and there is no way to tell which.
                gConf *= 0.5
                tConf *= 0.5
                nConf *= 0.5
                notes.append(String(
                    format: "Gross minus tare is %.2f t but net reads %.2f t — off by %.2f t.",
                    gross - tare, net, drift
                ))
            }

            // A tare heavier than the gross is a swapped pair, not a small
            // error.
            if tare > gross {
                notes.append("Tare reads heavier than gross. The two may be swapped.")
                gConf *= 0.4
                tConf *= 0.4
            }
        } else if let gross, let tare, net == nil {
            // Deliberately NOT computed. Gross minus tare is what the ticket
            // says net *should* be, not what it says net *is* — and net is the
            // number that gets paid. A reviewer types it from the photo, which
            // takes three seconds and keeps a machine's arithmetic out of a
            // financial record.
            notes.append(String(
                format: "Net was not readable. Gross minus tare would be %.2f t — confirm against the photo.",
                gross - tare
            ))
        }

        // Two fields reading the same number usually means one label found the
        // other field's value.
        if let gross, let net, gross == net {
            gConf *= 0.5
            nConf *= 0.5
            notes.append("Gross and net read as the same number.")
        }

        return WeightResult(
            gross: Field(value: gross, confidence: round3(gConf)),
            tare: Field(value: tare, confidence: round3(tConf)),
            net: Field(value: net, confidence: round3(nConf)),
            unit: unit == .pound ? "lb" : (unit == .ton ? "ton" : nil),
            trace: trace
        )
    }

    // MARK: - Fallbacks

    /// The quarry name when no label found it.
    ///
    /// Scale tickets put the vendor's name at the top in the largest type on
    /// the page, which is a shape the geometry can find even when the words
    /// mean nothing to the lexicon. Capped at the heuristic ceiling so it
    /// always reaches a person — but a person with the right answer already
    /// typed in, and one correction teaches `learn_alias()` the vendor's
    /// printed name for every future ticket.
    private static func headerQuarry(_ lines: [Prepared]) -> Hit<String>? {
        let header = lines.filter { line in
            line.box.minY < 0.25
                && line.norm.count >= 4
                && line.norm.filter(\.isLetter).count >= 3
                && !Lexicon.headerNoise.contains(where: { noise in line.norm.contains(noise) })
        }

        guard let chosen = header.max(by: { a, b in
            a.box.height == b.box.height
                ? a.box.minY > b.box.minY
                : a.box.height < b.box.height
        }) else { return nil }

        let score = min(heuristicCeiling, chosen.conf * 0.8)

        return Hit(
            value: String(chosen.raw.trimmingCharacters(in: CharacterSet.whitespaces).prefix(80)),
            confidence: score,
            trace: Trace(
                field: TicketField.quarryText.rawValue,
                label: nil,
                source: chosen.raw,
                how: "heuristic",
                confidence: round3(score),
                parts: ["ocr": chosen.conf, "heuristic": 0.8]
            ),
            raw: nil,
            unit: nil
        )
    }

    // MARK: - Helpers

    private static func cell<T>(_ hit: Hit<T>?) -> Field<T> {
        guard let hit else { return Field(value: nil, confidence: 0) }
        return Field(value: hit.value, confidence: round3(hit.confidence))
    }

    private static func round3(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }
    private static func round2(_ v: Double) -> Double { (v * 100).rounded() / 100 }
}
