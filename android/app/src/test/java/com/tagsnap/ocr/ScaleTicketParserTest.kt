package com.tagsnap.ocr

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Conformance suite for the ticket parser.
 *
 * The same fixtures as `packages/shared/test/parse.test.ts` and
 * `ios/TagSnapTests/ScaleTicketParserTests.swift`. All three readers must agree
 * on the values, and — more importantly — on which side of the confidence
 * floors each field lands, because that is what decides whether a human sees
 * the ticket before somebody is paid on it.
 *
 * A plain JVM test: no Robolectric, no emulator, no device. The parser touches
 * nothing Android-specific on purpose, which is what lets it be tested in
 * milliseconds on any machine including CI.
 */
class ScaleTicketParserTest {

    /** Floors mirrored from `packages/shared/src/validation.ts`. */
    private val confidenceFloor = 0.90
    private val payCriticalFloor = 0.95

    /**
     * Build a recognition result from a rough page layout.
     *
     * A row is either one full-width line or a list of columns. Boxes are laid
     * out the way a scale ticket actually is — evenly spaced rows, columns
     * sharing the width — so the same-row and directly-below rules are
     * exercised rather than merely satisfied.
     */
    private fun page(rows: List<List<String>>, confidence: Double = 0.95):
        TextRecognizer.Result {

        val lines = mutableListOf<TextRecognizer.Line>()
        val rowHeight = 0.9 / (rows.size + 1)

        rows.forEachIndexed { r, cells ->
            val cellWidth = 0.92 / cells.size
            cells.forEachIndexed { c, text ->
                if (text.isNotEmpty()) {
                    lines += TextRecognizer.Line(
                        text = text,
                        box = ScaleTicketParser.Box(
                            x = 0.04 + c * cellWidth,
                            y = 0.04 + r * rowHeight,
                            width = minOf(cellWidth * 0.95, 0.012 * text.length),
                            height = rowHeight * 0.6,
                        ),
                        confidence = confidence,
                    )
                }
            }
        }

        return TextRecognizer.Result(lines, ms = 40, engineVersion = "test")
    }

    private fun rows(vararg lines: String) = page(lines.map { listOf(it) })

    private val cleanTons get() = rows(
        "VULCAN MATERIALS COMPANY",
        "GRANITE QUARRY - PLANT 0412",
        "SCALE TICKET NO 0245871",
        "DATE 08/25/2026    TIME 09:14 AM",
        "TRUCK NO 118",
        "MATERIAL 57 CRUSHED STONE",
        "JOB NO 4471",
        "GROSS WT 78.42 TON",
        "TARE WT 30.10 TON",
        "NET WT 48.32 TON",
    )

    private val cleanPounds get() = page(
        listOf(
            listOf("MARTIN MARIETTA AGGREGATES"),
            listOf("TICKET NO", "118422"),
            listOf("DATE", "03/04/26"),
            listOf("TRUCK", "T-42"),
            listOf("PRODUCT", "ASPHALT BASE 19MM"),
            listOf("PROJECT", "HWY 41 PHASE 2"),
            listOf("GROSS WEIGHT", "76,480 LB"),
            listOf("TARE WEIGHT", "30,120 LB"),
            listOf("NET WEIGHT", "46,360 LB"),
        )
    )

    @Test
    fun `a clean ticket in tons reads every field`() {
        val out = ScaleTicketParser.parse(cleanTons)

        assertEquals("0245871", out.ticketNumber.value)
        assertEquals("2026-08-25", out.tagDate.value)
        assertEquals("09:14", out.tagTime.value)
        assertEquals("118", out.truckNumber.value)
        assertEquals(78.42, out.grossTons.value!!, 0.001)
        assertEquals(30.10, out.tareTons.value!!, 0.001)
        assertEquals(48.32, out.netTons.value!!, 0.001)
        assertTrue(out.isScaleTicket)

        // Net tonnage is what gets paid, so it is the one field that has to
        // clear the higher bar on a ticket this clean. If this ever fails,
        // every ticket goes to a reviewer and the app is a camera with extra
        // steps.
        assertTrue(
            "net_tons confidence ${out.netTons.confidence} is under the pay-critical floor",
            out.netTons.confidence >= payCriticalFloor
        )
        assertTrue(out.ticketNumber.confidence >= confidenceFloor)
    }

    @Test
    fun `pounds are converted to tons and the conversion is disclosed`() {
        val out = ScaleTicketParser.parse(cleanPounds)

        assertEquals(38.24, out.grossTons.value!!, 0.001)
        assertEquals(15.06, out.tareTons.value!!, 0.001)
        assertEquals(23.18, out.netTons.value!!, 0.001)
        assertTrue(out.notes.value!!.lowercase().contains("pounds"))
    }

    @Test
    fun `values in a second column are found`() {
        val out = ScaleTicketParser.parse(cleanPounds)

        assertEquals("118422", out.ticketNumber.value)
        assertEquals("T-42", out.truckNumber.value)
        assertEquals("2026-03-04", out.tagDate.value)
        assertEquals("label_right", out.trace.first { it.field == "net_tons" }.how)
    }

    @Test
    fun `a column-header layout puts the value under the label`() {
        val out = ScaleTicketParser.parse(
            page(
                listOf(
                    listOf("ACME SAND AND GRAVEL"),
                    listOf("TICKET 55901   DATE 01/09/2026"),
                    listOf("GROSS", "TARE", "NET"),
                    listOf("80,140", "31,200", "48,940"),
                    listOf("MATERIAL CLASS 5 BASE"),
                )
            )
        )

        assertEquals(40.07, out.grossTons.value!!, 0.001)
        assertEquals(15.60, out.tareTons.value!!, 0.001)
        assertEquals(24.47, out.netTons.value!!, 0.001)
        assertEquals("label_below", out.trace.first { it.field == "net_tons" }.how)
    }

    @Test
    fun `weights that disagree drop below the pay-critical floor`() {
        // 78.42 - 30.10 is 48.32, not 43.82. A transposition, which is exactly
        // the error the arithmetic check exists to catch.
        val out = ScaleTicketParser.parse(
            rows(
                "VULCAN MATERIALS COMPANY",
                "TICKET NO 0245871",
                "DATE 08/25/2026",
                "GROSS WT 78.42 TON",
                "TARE WT 30.10 TON",
                "NET WT 43.82 TON",
            )
        )

        assertEquals(43.82, out.netTons.value!!, 0.001)
        assertTrue(
            "a ticket whose weights contradict each other must not be trusted",
            out.netTons.confidence < payCriticalFloor
        )
        assertTrue(out.notes.value!!.contains("off by"))
    }

    @Test
    fun `the price line is not mistaken for a weight`() {
        val out = ScaleTicketParser.parse(
            rows(
                "GRANITE ROCK CO",
                "TICKET NO 771204",
                "DATE 11/02/2026",
                "GROSS WT 74,220 LB",
                "TARE WT 29,980 LB",
                "NET WT 44,240 LB",
                "NET AMOUNT DUE $ 486.64",
                "RATE PER TON $ 22.00",
            )
        )

        // 486.64 sits on a line labelled NET. Taking it would hand a reviewer a
        // plausible wrong tonnage, which is worse than handing them nothing.
        assertEquals(22.12, out.netTons.value!!, 0.001)
    }

    @Test
    fun `a date with no year is not a date`() {
        val out = ScaleTicketParser.parse(
            rows(
                "PIONEER AGGREGATE",
                "TICKET NO 4410",
                "DATE 08/25",
                "GROSS 61,400 LB",
                "TARE 30,000 LB",
                "NET 31,400 LB",
            )
        )

        assertNull(out.tagDate.value)
        assertEquals(0.0, out.tagDate.confidence, 0.0001)
    }

    @Test
    fun `cubic yards are detected and never converted`() {
        val out = ScaleTicketParser.parse(
            rows(
                "RIVERBEND SAND",
                "TICKET NO 9912",
                "DATE 06/14/2026",
                "MATERIAL FILL SAND",
                "NET QTY 12.0 CY",
            )
        )

        assertNull(out.netTons.value)
        assertTrue(out.notes.value!!.lowercase().contains("cubic yards"))
    }

    @Test
    fun `a photo of nothing is not a scale ticket`() {
        val out = ScaleTicketParser.parse(rows("BLURRY", "IMG 4471"))
        assertFalse(out.isScaleTicket)
        assertNull(out.netTons.value)
    }

    @Test
    fun `the vendor is guessed from the header but never confidently`() {
        val out = ScaleTicketParser.parse(
            rows(
                "CAPITOL AGGREGATES INC",
                "TICKET NO 30021",
                "DATE 02/02/2026",
                "GROSS 70,000 LB",
                "TARE 30,000 LB",
                "NET 40,000 LB",
            )
        )

        assertEquals("CAPITOL AGGREGATES INC", out.quarryText.value)
        assertEquals("heuristic", out.trace.first { it.field == "quarry_text" }.how)

        // A guess from page position must always reach a person. If this ever
        // cleared the floor, a wrongly resolved quarry would price the load
        // against another vendor's rate with nobody looking.
        assertTrue(out.quarryText.confidence <= 0.70)
    }

    @Test
    fun `characters repaired into digits cost confidence`() {
        val clean = ScaleTicketParser.parse(
            rows("TICKET NO 1001", "DATE 05/05/2026", "NET WT 45.32 TON")
        )
        // "4S.32" — the S is a 5. Repairable, but not for free.
        val damaged = ScaleTicketParser.parse(
            rows("TICKET NO 1001", "DATE 05/05/2026", "NET WT 4S.32 TON")
        )

        assertEquals(45.32, damaged.netTons.value!!, 0.001)
        assertTrue(damaged.netTons.confidence < clean.netTons.confidence)
    }

    @Test
    fun `net is never computed from gross minus tare`() {
        val out = ScaleTicketParser.parse(
            rows(
                "TICKET NO 6060",
                "DATE 09/09/2026",
                "GROSS WT 72.00 TON",
                "TARE WT 30.00 TON",
            )
        )

        // The figure is offered to the reviewer in the notes and kept out of
        // the field, because a machine's arithmetic must not become the number
        // somebody is paid on.
        assertNull(out.netTons.value)
        assertTrue(out.notes.value!!.contains("42"))
    }

    @Test
    fun `a void ticket says so`() {
        val out = ScaleTicketParser.parse(
            rows(
                "TICKET NO 2020",
                "VOID - REWEIGH",
                "DATE 04/04/2026",
                "NET WT 20.00 TON",
            )
        )
        assertTrue(out.notes.value!!.contains("VOID"))
    }

    @Test
    fun `the payload matches what apply_extraction expects`() {
        val out = ScaleTicketParser.parse(cleanTons)
        val extracted: JSONObject = out.extractedJson()

        // The server's agreement check reads confidence off the top level and
        // the value out of `{field,value}`. Both shapes have to be right or
        // every tag lands in review with `no_ocr_text`.
        assertEquals(48.32, extracted.getJSONObject("net_tons").getDouble("value"), 0.001)
        assertNotNull(out.confidenceJson().get("net_tons"))
        assertTrue(out.text.contains("VULCAN"))
    }

    @Test
    fun `an empty read is refused before submission`() {
        assertFalse(rows("A", "B").isWorthSubmitting)
        assertTrue(cleanTons.isWorthSubmitting)
    }
}
