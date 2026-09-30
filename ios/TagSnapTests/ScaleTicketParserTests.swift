import CoreGraphics
import XCTest
@testable import TagSnap

/// Conformance suite for the ticket parser.
///
/// The same fixtures as `packages/shared/test/parse.test.ts` and
/// `android/.../ScaleTicketParserTest.kt`. All three readers must agree on the
/// values, and — more importantly — on which side of the confidence floors
/// each field lands, because that is what decides whether a human sees the
/// ticket before somebody is paid on it.
///
/// When a label is added to the lexicon, it goes into the TypeScript file
/// first, then here and in the Kotlin one, and a case is added to all three.
final class ScaleTicketParserTests: XCTestCase {

    // MARK: - Floors, mirrored from packages/shared/src/validation.ts

    private let confidenceFloor = 0.90
    private let payCriticalFloor = 0.95

    // MARK: - Fixtures

    /// Build a recognition result from a rough page layout.
    ///
    /// A row is either one full-width line or a list of columns. Boxes are laid
    /// out the way a scale ticket actually is — evenly spaced rows, columns
    /// sharing the width — so the same-row and directly-below rules are
    /// exercised rather than merely satisfied.
    private func page(_ rows: [[String]], confidence: Double = 0.95) -> TextRecognizer.Result {
        var lines: [TextRecognizer.Line] = []
        let rowHeight = 0.9 / Double(rows.count + 1)

        for (r, cells) in rows.enumerated() {
            let cellWidth = 0.92 / Double(cells.count)
            for (c, text) in cells.enumerated() where !text.isEmpty {
                lines.append(TextRecognizer.Line(
                    text: text,
                    box: CGRect(
                        x: 0.04 + Double(c) * cellWidth,
                        y: 0.04 + Double(r) * rowHeight,
                        width: min(cellWidth * 0.95, 0.012 * Double(text.count)),
                        height: rowHeight * 0.6
                    ),
                    confidence: confidence
                ))
            }
        }

        return TextRecognizer.Result(lines: lines, ms: 40, engineVersion: "test")
    }

    private func page(_ rows: [String], confidence: Double = 0.95) -> TextRecognizer.Result {
        page(rows.map { [$0] }, confidence: confidence)
    }

    private var cleanTons: TextRecognizer.Result {
        page([
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
        ])
    }

    private var cleanPounds: TextRecognizer.Result {
        page([
            ["MARTIN MARIETTA AGGREGATES"],
            ["TICKET NO", "118422"],
            ["DATE", "03/04/26"],
            ["TRUCK", "T-42"],
            ["PRODUCT", "ASPHALT BASE 19MM"],
            ["PROJECT", "HWY 41 PHASE 2"],
            ["GROSS WEIGHT", "76,480 LB"],
            ["TARE WEIGHT", "30,120 LB"],
            ["NET WEIGHT", "46,360 LB"],
        ])
    }

    // MARK: - Tests

    func testCleanTicketInTonsReadsEveryField() {
        let out = ScaleTicketParser.parse(cleanTons)

        XCTAssertEqual(out.ticketNumber.value, "0245871")
        XCTAssertEqual(out.tagDate.value, "2026-08-25")
        XCTAssertEqual(out.tagTime.value, "09:14")
        XCTAssertEqual(out.truckNumber.value, "118")
        XCTAssertEqual(out.grossTons.value, 78.42)
        XCTAssertEqual(out.tareTons.value, 30.10)
        XCTAssertEqual(out.netTons.value, 48.32)
        XCTAssertTrue(out.isScaleTicket)

        // Net tonnage is what gets paid, so it is the one field that has to
        // clear the higher bar on a ticket this clean. If this ever fails,
        // every ticket goes to a reviewer and the app is a camera with extra
        // steps.
        XCTAssertGreaterThanOrEqual(
            out.netTons.confidence, payCriticalFloor,
            "net_tons must clear the pay-critical floor on a clean ticket"
        )
        XCTAssertGreaterThanOrEqual(out.ticketNumber.confidence, confidenceFloor)
    }

    func testPoundsAreConvertedAndDisclosed() {
        let out = ScaleTicketParser.parse(cleanPounds)

        XCTAssertEqual(out.grossTons.value, 38.24)
        XCTAssertEqual(out.tareTons.value, 15.06)
        XCTAssertEqual(out.netTons.value, 23.18)
        XCTAssertTrue(out.notes.value?.lowercased().contains("pounds") == true)
    }

    func testValuesInASecondColumnAreFound() {
        let out = ScaleTicketParser.parse(cleanPounds)

        XCTAssertEqual(out.ticketNumber.value, "118422")
        XCTAssertEqual(out.truckNumber.value, "T-42")
        XCTAssertEqual(out.tagDate.value, "2026-03-04")
        XCTAssertEqual(out.trace.first { $0.field == "net_tons" }?.how, "label_right")
    }

    func testColumnHeaderLayout() {
        let out = ScaleTicketParser.parse(page([
            ["ACME SAND AND GRAVEL"],
            ["TICKET 55901   DATE 01/09/2026"],
            ["GROSS", "TARE", "NET"],
            ["80,140", "31,200", "48,940"],
            ["MATERIAL CLASS 5 BASE"],
        ]))

        XCTAssertEqual(out.grossTons.value, 40.07)
        XCTAssertEqual(out.tareTons.value, 15.60)
        XCTAssertEqual(out.netTons.value, 24.47)
        XCTAssertEqual(out.trace.first { $0.field == "net_tons" }?.how, "label_below")
    }

    func testWeightsThatDisagreeDropBelowTheFloor() {
        // 78.42 - 30.10 is 48.32, not 43.82. A transposition, which is exactly
        // the error the arithmetic check exists to catch.
        let out = ScaleTicketParser.parse(page([
            "VULCAN MATERIALS COMPANY",
            "TICKET NO 0245871",
            "DATE 08/25/2026",
            "GROSS WT 78.42 TON",
            "TARE WT 30.10 TON",
            "NET WT 43.82 TON",
        ]))

        XCTAssertEqual(out.netTons.value, 43.82)
        XCTAssertLessThan(
            out.netTons.confidence, payCriticalFloor,
            "a ticket whose weights contradict each other must not be trusted"
        )
        XCTAssertTrue(out.notes.value?.contains("off by") == true)
    }

    func testThePriceLineIsNotAWeight() {
        let out = ScaleTicketParser.parse(page([
            "GRANITE ROCK CO",
            "TICKET NO 771204",
            "DATE 11/02/2026",
            "GROSS WT 74,220 LB",
            "TARE WT 29,980 LB",
            "NET WT 44,240 LB",
            "NET AMOUNT DUE $ 486.64",
            "RATE PER TON $ 22.00",
        ]))

        // 486.64 sits on a line labelled NET. Taking it would hand a reviewer
        // a plausible wrong tonnage, which is worse than handing them nothing.
        XCTAssertEqual(out.netTons.value, 22.12)
    }

    func testADateWithNoYearIsNotADate() {
        let out = ScaleTicketParser.parse(page([
            "PIONEER AGGREGATE",
            "TICKET NO 4410",
            "DATE 08/25",
            "GROSS 61,400 LB",
            "TARE 30,000 LB",
            "NET 31,400 LB",
        ]))

        XCTAssertNil(out.tagDate.value)
        XCTAssertEqual(out.tagDate.confidence, 0)
    }

    func testCubicYardsAreDetectedAndNeverConverted() {
        let out = ScaleTicketParser.parse(page([
            "RIVERBEND SAND",
            "TICKET NO 9912",
            "DATE 06/14/2026",
            "MATERIAL FILL SAND",
            "NET QTY 12.0 CY",
        ]))

        XCTAssertNil(out.netTons.value)
        XCTAssertTrue(out.notes.value?.lowercased().contains("cubic yards") == true)
    }

    func testAPhotoOfNothingIsNotAScaleTicket() {
        let out = ScaleTicketParser.parse(page(["BLURRY", "IMG 4471"]))
        XCTAssertFalse(out.isScaleTicket)
        XCTAssertNil(out.netTons.value)
    }

    func testTheVendorIsGuessedFromTheHeaderButNeverConfidently() {
        let out = ScaleTicketParser.parse(page([
            "CAPITOL AGGREGATES INC",
            "TICKET NO 30021",
            "DATE 02/02/2026",
            "GROSS 70,000 LB",
            "TARE 30,000 LB",
            "NET 40,000 LB",
        ]))

        XCTAssertEqual(out.quarryText.value, "CAPITOL AGGREGATES INC")
        XCTAssertEqual(out.trace.first { $0.field == "quarry_text" }?.how, "heuristic")

        // A guess from page position must always reach a person. If this ever
        // cleared the floor, a wrongly resolved quarry would price the load
        // against another vendor's rate with nobody looking.
        XCTAssertLessThanOrEqual(out.quarryText.confidence, 0.70)
    }

    func testRepairedDigitsCostConfidence() {
        let clean = ScaleTicketParser.parse(
            page(["TICKET NO 1001", "DATE 05/05/2026", "NET WT 45.32 TON"])
        )
        // "4S.32" — the S is a 5. Repairable, but not for free.
        let damaged = ScaleTicketParser.parse(
            page(["TICKET NO 1001", "DATE 05/05/2026", "NET WT 4S.32 TON"])
        )

        XCTAssertEqual(damaged.netTons.value, 45.32)
        XCTAssertLessThan(damaged.netTons.confidence, clean.netTons.confidence)
    }

    func testNetIsNeverComputedFromGrossMinusTare() {
        let out = ScaleTicketParser.parse(page([
            "TICKET NO 6060",
            "DATE 09/09/2026",
            "GROSS WT 72.00 TON",
            "TARE WT 30.00 TON",
        ]))

        // The figure is offered to the reviewer in the notes and kept out of
        // the field, because a machine's arithmetic must not become the number
        // somebody is paid on.
        XCTAssertNil(out.netTons.value)
        XCTAssertTrue(out.notes.value?.contains("42") == true)
    }

    func testAVoidTicketSaysSo() {
        let out = ScaleTicketParser.parse(page([
            "TICKET NO 2020",
            "VOID - REWEIGH",
            "DATE 04/04/2026",
            "NET WT 20.00 TON",
        ]))
        XCTAssertTrue(out.notes.value?.contains("VOID") == true)
    }

    func testThePayloadMatchesWhatApplyExtractionExpects() {
        let out = ScaleTicketParser.parse(cleanTons)
        let extracted = out.extractedJSON

        // The server's agreement check reads confidence off the top level and
        // the value out of `{field,value}`. Both shapes have to be right or
        // every tag lands in review with `no_ocr_text`.
        let net = extracted["net_tons"] as? [String: Any]
        XCTAssertEqual(net?["value"] as? Double, 48.32)
        XCTAssertNotNil(out.confidenceJSON["net_tons"] as? Double)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(extracted))
        XCTAssertTrue(out.text.contains("VULCAN"))
    }

    func testAnEmptyReadIsRefusedBeforeSubmission() {
        XCTAssertFalse(page(["A", "B"]).isWorthSubmitting)
        XCTAssertTrue(cleanTons.isWorthSubmitting)
    }

    /// The parser runs on the capture screen while the driver waits. It has to
    /// be fast enough that they never see it happen.
    func testParsingIsFastEnoughToBeInvisible() {
        measure {
            for _ in 0..<20 { _ = ScaleTicketParser.parse(cleanTons) }
        }
    }
}
