package com.tagsnap.ocr

/**
 * The fields the parser fills.
 *
 * The wire name is the key in the `extracted` jsonb that `apply_extraction()`
 * reads, so these strings are a contract with the database, not an internal
 * detail.
 */
enum class TicketField(val wire: String) {
    TICKET_NUMBER("ticket_number"),
    TAG_DATE("tag_date"),
    TAG_TIME("tag_time"),
    QUARRY_TEXT("quarry_text"),
    MATERIAL_TEXT("material_text"),
    JOB_TEXT("job_text"),
    TRUCK_NUMBER("truck_number"),
    GROSS_TONS("gross_tons"),
    TARE_TONS("tare_tons"),
    NET_TONS("net_tons"),
    NOTES("notes");

    val isWeight: Boolean
        get() = this == GROSS_TONS || this == TARE_TONS || this == NET_TONS
}

enum class WeightUnit { POUND, TON, CUBIC_YARD }

/**
 * What scale tickets call things.
 *
 * A direct port of `packages/shared/src/parse/lexicon.ts`. The TypeScript
 * version is canonical and carries the conformance suite; add a label there
 * first, then here and in the Swift file, so all three readers agree about
 * what a ticket says.
 *
 * Every quarry prints its own layout, but the vocabulary is small and has
 * barely changed in forty years, because most of these tickets come off scale
 * software that predates the web. That is what makes a deterministic parser
 * viable here where it would not be on, say, an invoice.
 *
 * Adding a label is the cheapest accuracy improvement available and costs
 * nothing at runtime. When the office corrects the same field on the same
 * vendor twice, read `ocr_text` on those tags and add what it actually says.
 */
object Lexicon {

    /**
     * @param weight how much the label's presence should be trusted. An exact
     *   "NET WT" is unambiguous; a bare "NET" could be a net price. Ambiguous
     *   labels are kept — a weak match beats no match — but cannot on their own
     *   carry a field past the confidence floor.
     */
    data class LabelSpec(val label: String, val weight: Double)

    private fun spec(label: String, weight: Double) = LabelSpec(label, weight)

    /**
     * Longest first within each field. The matcher takes the first that fits,
     * so "NET WT" wins over "NET" on a line reading "NET WT 21.34".
     */
    val labels: Map<TicketField, List<LabelSpec>> = mapOf(
        TicketField.TICKET_NUMBER to listOf(
            spec("SCALE TICKET NO", 1.0),
            spec("WEIGHT TICKET NO", 1.0),
            spec("TRANSACTION NO", 0.95),
            spec("DELIVERY TICKET", 0.95),
            spec("SCALE TICKET", 1.0),
            spec("TICKET NUMBER", 1.0),
            spec("TICKET NO", 1.0),
            spec("TICKET NUM", 1.0),
            spec("TRANS NO", 0.9),
            spec("LOAD NO", 0.85),
            spec("TICKET", 0.95),
            spec("TKT NO", 0.95),
            spec("TRANS", 0.8),
            spec("TKT", 0.9),
            // A bare "NO." beside a number in the header block is usually the
            // ticket number, but it is also how a job or truck number prints.
            spec("NO", 0.55),
        ),
        TicketField.TAG_DATE to listOf(
            spec("DATE IN", 0.9),
            spec("DATE OUT", 0.9),
            spec("SHIP DATE", 0.95),
            spec("LOAD DATE", 0.95),
            spec("DATE", 1.0),
            spec("DATED", 0.9),
        ),
        TicketField.TAG_TIME to listOf(
            spec("TIME IN", 0.9),
            spec("TIME OUT", 0.9),
            spec("TIME", 1.0),
        ),
        TicketField.QUARRY_TEXT to listOf(
            spec("SHIPPED FROM", 1.0),
            spec("SHIP FROM", 1.0),
            spec("PLANT NAME", 1.0),
            spec("ORIGIN", 0.95),
            spec("QUARRY", 1.0),
            spec("SOURCE", 0.9),
            spec("PLANT", 0.95),
            spec("SITE", 0.85),
            spec("YARD", 0.8),
            spec("FROM", 0.7),
        ),
        TicketField.MATERIAL_TEXT to listOf(
            spec("MATERIAL DESC", 1.0),
            spec("PRODUCT DESC", 1.0),
            spec("DESCRIPTION", 0.85),
            spec("COMMODITY", 0.95),
            spec("MATERIAL", 1.0),
            spec("PRODUCT", 1.0),
            spec("ITEM", 0.8),
            spec("MIX", 0.8),
            spec("DESC", 0.8),
        ),
        TicketField.JOB_TEXT to listOf(
            spec("PROJECT NO", 1.0),
            spec("JOB NUMBER", 1.0),
            spec("PURCHASE ORDER", 0.9),
            spec("DELIVER TO", 0.85),
            spec("SHIP TO", 0.85),
            spec("PROJECT", 1.0),
            spec("JOB NO", 1.0),
            spec("JOB", 0.95),
            spec("PO NO", 0.85),
            spec("PO", 0.7),
        ),
        TicketField.TRUCK_NUMBER to listOf(
            spec("TRUCK NO", 1.0),
            spec("VEHICLE NO", 1.0),
            spec("UNIT NO", 0.95),
            spec("TRUCK", 1.0),
            spec("VEHICLE", 0.95),
            spec("HAULER", 0.8),
            spec("CARRIER", 0.75),
            spec("UNIT", 0.85),
            spec("TRK", 0.9),
        ),
        TicketField.GROSS_TONS to listOf(
            spec("GROSS WEIGHT", 1.0),
            spec("GROSS TONS", 1.0),
            spec("GROSS WT", 1.0),
            spec("GROSS", 0.95),
            spec("GVW", 0.9),
            spec("GR WT", 0.9),
            spec("LOADED", 0.8),
        ),
        TicketField.TARE_TONS to listOf(
            spec("TARE WEIGHT", 1.0),
            spec("TARE TONS", 1.0),
            spec("EMPTY WEIGHT", 0.95),
            spec("TARE WT", 1.0),
            spec("TARE", 0.95),
            spec("EMPTY WT", 0.9),
            spec("EMPTY", 0.8),
            spec("TR WT", 0.85),
        ),
        TicketField.NET_TONS to listOf(
            spec("NET WEIGHT", 1.0),
            spec("NET TONS", 1.0),
            spec("NET TON", 1.0),
            spec("NET WT", 1.0),
            spec("NET QTY", 0.95),
            spec("QUANTITY", 0.7),
            spec("NET", 0.9),
            spec("TONS", 0.75),
            spec("QTY", 0.7),
        ),
        // Never label-matched. Assembled from what the parser noticed.
        TicketField.NOTES to emptyList(),
    )

    /** Every label the lexicon knows, for the header-versus-value test. */
    val allLabels: Set<String> = labels.values.flatten().map { it.label }.toSet()

    /**
     * Words that mean "this is a scale ticket" rather than a photo of a thumb.
     *
     * Generous on purpose, and only ever used to route to review rather than to
     * reject anything. A false negative sends a good ticket to a person, which
     * costs ten seconds.
     */
    val ticketMarkers = listOf(
        "SCALE", "TICKET", "GROSS", "TARE", "NET", "TONS", "TON", "LBS",
        "QUARRY", "AGGREGATE", "MATERIAL", "PLANT", "HAUL", "WEIGHT", "WT", "CY",
    )

    /**
     * `CY` is here to be *detected*, not converted. Aggregate density varies
     * enough by material that a fixed factor would be a guess with a dollar
     * sign on it, so a ticket in cubic yards routes to a person.
     */
    val unitTokens: Map<String, WeightUnit> = mapOf(
        "LB" to WeightUnit.POUND, "LBS" to WeightUnit.POUND,
        "POUND" to WeightUnit.POUND, "POUNDS" to WeightUnit.POUND,
        "#" to WeightUnit.POUND,
        "T" to WeightUnit.TON, "TN" to WeightUnit.TON,
        "TON" to WeightUnit.TON, "TONS" to WeightUnit.TON, "NT" to WeightUnit.TON,
        "CY" to WeightUnit.CUBIC_YARD, "CYD" to WeightUnit.CUBIC_YARD,
        "YD" to WeightUnit.CUBIC_YARD, "YDS" to WeightUnit.CUBIC_YARD,
    )

    /**
     * Header lines that are never the quarry name, even though they sit where
     * the quarry name usually is.
     */
    val headerNoise = listOf(
        "SCALE TICKET", "WEIGHT TICKET", "DELIVERY TICKET", "ORIGINAL",
        "DUPLICATE", "CUSTOMER COPY", "DRIVER COPY", "OFFICE COPY",
        "THANK YOU", "INVOICE", "REMIT TO", "PAGE",
    )

    /**
     * Text that means a number nearby is money rather than weight.
     *
     * This matters more than it looks. The dollar figure on a scale ticket is
     * the quarry billing their customer — nothing to do with what we owe a
     * hauler — and a parser that took it as a weight would put a plausible
     * wrong number in front of a reviewer, which is the worst kind.
     */
    val moneyMarkers = listOf(
        "$", "PRICE", "AMOUNT", "TOTAL DUE", "SUBTOTAL", "TAX", "RATE",
        "EXT", "CHARGE", "BALANCE", "PER TON", "UNIT PRICE",
    )
}
