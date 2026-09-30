import Foundation

/// What scale tickets call things.
///
/// A direct port of `packages/shared/src/parse/lexicon.ts`. The TypeScript
/// version is canonical: add a label there first, then here and in the Kotlin
/// file, so all three readers agree about what a ticket says.
///
/// Adding a label is the cheapest accuracy improvement available and it costs
/// nothing at runtime. When the office corrects the same field on the same
/// vendor twice, read `ocr_text` on those tags and add what it actually says.
enum Lexicon {

    struct LabelSpec {
        let label: String
        /// How much the label's presence should be trusted. An exact "NET WT"
        /// is unambiguous; a bare "NET" could be a net price.
        let weight: Double

        init(_ label: String, _ weight: Double) {
            self.label = label
            self.weight = weight
        }
    }

    /// Longest first within each field: the matcher takes the first that fits,
    /// so "NET WT" wins over "NET" on a line that says "NET WT 21.34".
    static let labels: [TicketField: [LabelSpec]] = [
        .ticketNumber: [
            LabelSpec("SCALE TICKET NO", 1.0),
            LabelSpec("WEIGHT TICKET NO", 1.0),
            LabelSpec("TRANSACTION NO", 0.95),
            LabelSpec("DELIVERY TICKET", 0.95),
            LabelSpec("SCALE TICKET", 1.0),
            LabelSpec("TICKET NUMBER", 1.0),
            LabelSpec("TICKET NO", 1.0),
            LabelSpec("TICKET NUM", 1.0),
            LabelSpec("TRANS NO", 0.9),
            LabelSpec("LOAD NO", 0.85),
            LabelSpec("TICKET", 0.95),
            LabelSpec("TKT NO", 0.95),
            LabelSpec("TRANS", 0.8),
            LabelSpec("TKT", 0.9),
            // A bare "NO." beside a number in the header block is usually the
            // ticket number, but it is also how a job or truck number prints.
            LabelSpec("NO", 0.55),
        ],
        .tagDate: [
            LabelSpec("DATE IN", 0.9),
            LabelSpec("DATE OUT", 0.9),
            LabelSpec("SHIP DATE", 0.95),
            LabelSpec("LOAD DATE", 0.95),
            LabelSpec("DATE", 1.0),
            LabelSpec("DATED", 0.9),
        ],
        .tagTime: [
            LabelSpec("TIME IN", 0.9),
            LabelSpec("TIME OUT", 0.9),
            LabelSpec("TIME", 1.0),
        ],
        .quarryText: [
            LabelSpec("SHIPPED FROM", 1.0),
            LabelSpec("SHIP FROM", 1.0),
            LabelSpec("PLANT NAME", 1.0),
            LabelSpec("ORIGIN", 0.95),
            LabelSpec("QUARRY", 1.0),
            LabelSpec("SOURCE", 0.9),
            LabelSpec("PLANT", 0.95),
            LabelSpec("SITE", 0.85),
            LabelSpec("YARD", 0.8),
            LabelSpec("FROM", 0.7),
        ],
        .materialText: [
            LabelSpec("MATERIAL DESC", 1.0),
            LabelSpec("PRODUCT DESC", 1.0),
            LabelSpec("DESCRIPTION", 0.85),
            LabelSpec("COMMODITY", 0.95),
            LabelSpec("MATERIAL", 1.0),
            LabelSpec("PRODUCT", 1.0),
            LabelSpec("ITEM", 0.8),
            LabelSpec("MIX", 0.8),
            LabelSpec("DESC", 0.8),
        ],
        .jobText: [
            LabelSpec("PROJECT NO", 1.0),
            LabelSpec("JOB NUMBER", 1.0),
            LabelSpec("PURCHASE ORDER", 0.9),
            LabelSpec("DELIVER TO", 0.85),
            LabelSpec("SHIP TO", 0.85),
            LabelSpec("PROJECT", 1.0),
            LabelSpec("JOB NO", 1.0),
            LabelSpec("JOB", 0.95),
            LabelSpec("PO NO", 0.85),
            LabelSpec("PO", 0.7),
        ],
        .truckNumber: [
            LabelSpec("TRUCK NO", 1.0),
            LabelSpec("VEHICLE NO", 1.0),
            LabelSpec("UNIT NO", 0.95),
            LabelSpec("TRUCK", 1.0),
            LabelSpec("VEHICLE", 0.95),
            LabelSpec("HAULER", 0.8),
            LabelSpec("CARRIER", 0.75),
            LabelSpec("UNIT", 0.85),
            LabelSpec("TRK", 0.9),
        ],
        .grossTons: [
            LabelSpec("GROSS WEIGHT", 1.0),
            LabelSpec("GROSS TONS", 1.0),
            LabelSpec("GROSS WT", 1.0),
            LabelSpec("GROSS", 0.95),
            LabelSpec("GVW", 0.9),
            LabelSpec("GR WT", 0.9),
            LabelSpec("LOADED", 0.8),
        ],
        .tareTons: [
            LabelSpec("TARE WEIGHT", 1.0),
            LabelSpec("TARE TONS", 1.0),
            LabelSpec("EMPTY WEIGHT", 0.95),
            LabelSpec("TARE WT", 1.0),
            LabelSpec("TARE", 0.95),
            LabelSpec("EMPTY WT", 0.9),
            LabelSpec("EMPTY", 0.8),
            LabelSpec("TR WT", 0.85),
        ],
        .netTons: [
            LabelSpec("NET WEIGHT", 1.0),
            LabelSpec("NET TONS", 1.0),
            LabelSpec("NET TON", 1.0),
            LabelSpec("NET WT", 1.0),
            LabelSpec("NET QTY", 0.95),
            LabelSpec("QUANTITY", 0.7),
            LabelSpec("NET", 0.9),
            LabelSpec("TONS", 0.75),
            LabelSpec("QTY", 0.7),
        ],
        // Never label-matched. Assembled from what the parser noticed.
        .notes: [],
    ]

    /// Every label the lexicon knows, for the header-versus-value test.
    static let allLabels: Set<String> = Set(labels.values.flatMap { $0.map(\.label) })

    /// Words that mean "this is a scale ticket" rather than a photo of a thumb.
    ///
    /// Deliberately generous, and only ever used to route to review rather
    /// than to reject anything. A false negative sends a good ticket to a
    /// person, which costs ten seconds.
    static let ticketMarkers = [
        "SCALE", "TICKET", "GROSS", "TARE", "NET", "TONS", "TON", "LBS",
        "QUARRY", "AGGREGATE", "MATERIAL", "PLANT", "HAUL", "WEIGHT", "WT", "CY",
    ]

    enum Unit { case pound, ton, cubicYard }

    /// `CY` is here to be *detected*, not converted. Aggregate density varies
    /// enough by material that a fixed factor would be a guess with a dollar
    /// sign on it, so a ticket measured in cubic yards routes to a person.
    static let unitTokens: [String: Unit] = [
        "LB": .pound, "LBS": .pound, "POUND": .pound, "POUNDS": .pound, "#": .pound,
        "T": .ton, "TN": .ton, "TON": .ton, "TONS": .ton, "NT": .ton,
        "CY": .cubicYard, "CYD": .cubicYard, "YD": .cubicYard, "YDS": .cubicYard,
    ]

    /// Header lines that are never the quarry name, even though they sit where
    /// the quarry name usually is.
    static let headerNoise = [
        "SCALE TICKET", "WEIGHT TICKET", "DELIVERY TICKET", "ORIGINAL",
        "DUPLICATE", "CUSTOMER COPY", "DRIVER COPY", "OFFICE COPY",
        "THANK YOU", "INVOICE", "REMIT TO", "PAGE",
    ]

    /// Text that means a number nearby is money rather than weight.
    ///
    /// This matters more than it looks. The dollar figure on a scale ticket is
    /// the quarry billing their customer — nothing to do with what we owe a
    /// hauler — and a parser that took it as a weight would put a plausible
    /// wrong number in front of a reviewer, which is the worst kind.
    static let moneyMarkers = [
        "$", "PRICE", "AMOUNT", "TOTAL DUE", "SUBTOTAL", "TAX", "RATE",
        "EXT", "CHARGE", "BALANCE", "PER TON", "UNIT PRICE",
    ]
}

/// The fields the parser fills. Mirrors `ExtractedTag` in the shared types and
/// the `extracted` jsonb that `apply_extraction()` reads.
enum TicketField: String, CaseIterable {
    case ticketNumber = "ticket_number"
    case tagDate = "tag_date"
    case tagTime = "tag_time"
    case quarryText = "quarry_text"
    case materialText = "material_text"
    case jobText = "job_text"
    case truckNumber = "truck_number"
    case grossTons = "gross_tons"
    case tareTons = "tare_tons"
    case netTons = "net_tons"
    case notes

    var isWeight: Bool {
        self == .grossTons || self == .tareTons || self == .netTons
    }
}
