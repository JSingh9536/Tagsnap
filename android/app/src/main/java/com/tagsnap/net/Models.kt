package com.tagsnap.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * The row shapes, mirroring `supabase/migrations/001_schema.sql` and
 * `packages/shared/src/types.ts`.
 *
 * Every optional here is nullable in the database too. A tag that has been
 * photographed but not yet read has nulls in most of these columns, and the UI
 * has to say "not read yet" rather than "0.00 tons".
 */

@Serializable
enum class UserRole {
    @SerialName("driver") DRIVER,
    @SerialName("subhauler") SUBHAULER,
    @SerialName("office") OFFICE,
    @SerialName("admin") ADMIN;

    val label: String
        get() = when (this) {
            DRIVER -> "Driver"
            SUBHAULER -> "Subhauler"
            OFFICE -> "Office"
            ADMIN -> "Admin"
        }

    /**
     * Which door this account belongs to. Office and admin have no business on
     * a phone — their work is the review screen, which needs a wide layout and
     * a photo big enough to read a faded carbon copy on.
     */
    val portal: Portal
        get() = when (this) {
            SUBHAULER -> Portal.SUBHAULER
            DRIVER -> Portal.DRIVER
            OFFICE, ADMIN -> Portal.OFFICE
        }

    val payeeType: PayeeType
        get() = if (this == SUBHAULER) PayeeType.SUBHAULER else PayeeType.EMPLOYEE_DRIVER
}

enum class Portal { DRIVER, SUBHAULER, OFFICE }

@Serializable
enum class PayeeType(val wire: String) {
    @SerialName("employee_driver") EMPLOYEE_DRIVER("employee_driver"),
    @SerialName("subhauler") SUBHAULER("subhauler");

    val label: String
        get() = if (this == SUBHAULER) "Subhauler" else "Company driver"

    val ledgerLabel: String
        get() = if (this == SUBHAULER) "Subhauler payable" else "Driver settlement"
}

@Serializable
enum class TagStatus {
    @SerialName("queued") QUEUED,
    @SerialName("uploaded") UPLOADED,
    @SerialName("extracted") EXTRACTED,
    @SerialName("needs_review") NEEDS_REVIEW,
    @SerialName("rescan_requested") RESCAN_REQUESTED,
    @SerialName("ready") READY,
    @SerialName("approved") APPROVED,
    @SerialName("invoiced") INVOICED,
    @SerialName("rejected") REJECTED;

    /**
     * What the field crew is told, from their point of view rather than the
     * pipeline's. They do not care what a stage is called, only whether their
     * money is moving.
     */
    val driverLabel: String
        get() = when (this) {
            QUEUED -> "Waiting for signal"
            UPLOADED -> "Sent"
            EXTRACTED -> "Being read"
            NEEDS_REVIEW, READY -> "With the office"
            RESCAN_REQUESTED -> "Rescan needed"
            APPROVED -> "Approved"
            INVOICED -> "On your invoice"
            REJECTED -> "Rejected"
        }

    val tone: Tone
        get() = when (this) {
            QUEUED, UPLOADED, EXTRACTED, READY -> Tone.PENDING
            NEEDS_REVIEW, RESCAN_REQUESTED -> Tone.ATTENTION
            APPROVED, INVOICED -> Tone.GOOD
            REJECTED -> Tone.BAD
        }

    enum class Tone { PENDING, ATTENTION, GOOD, BAD }
}

@Serializable
enum class RescanReason {
    @SerialName("unreadable") UNREADABLE,
    @SerialName("cropped") CROPPED,
    @SerialName("wrong_document") WRONG_DOCUMENT,
    @SerialName("missing_fields") MISSING_FIELDS,
    @SerialName("duplicate_check") DUPLICATE_CHECK,
    @SerialName("other") OTHER;

    val label: String
        get() = when (this) {
            UNREADABLE -> "Can't read it"
            CROPPED -> "Part of the ticket is cut off"
            WRONG_DOCUMENT -> "Not a scale ticket"
            MISSING_FIELDS -> "A needed field is missing"
            DUPLICATE_CHECK -> "Possible duplicate"
            OTHER -> "Other"
        }

    /**
     * What to *do*, not what went wrong. This is printed across the camera
     * screen while the driver retakes the photo, so it has to be an instruction
     * that can be followed while holding a phone in one hand.
     */
    val instruction: String
        get() = when (this) {
            UNREADABLE ->
                "Retake it in better light. Hold the ticket flat and keep your shadow off it."
            CROPPED ->
                "Retake it with all four corners of the ticket inside the frame."
            WRONG_DOCUMENT ->
                "That was not a scale ticket. Photograph the ticket for this load."
            MISSING_FIELDS ->
                "Retake it so the whole ticket is visible, including the margins."
            DUPLICATE_CHECK ->
                "This looks like a ticket already submitted. Retake it, or call the office if it is a separate load."
            OTHER ->
                "Retake the photo. See the note from the office."
        }
}

@Serializable
enum class ExtractionEngine(val wire: String) {
    @SerialName("apple_vision") APPLE_VISION("apple_vision"),
    @SerialName("mlkit") MLKIT("mlkit"),
    @SerialName("tesseract") TESSERACT("tesseract"),
    @SerialName("office_manual") OFFICE_MANUAL("office_manual"),
    @SerialName("quarry_feed") QUARRY_FEED("quarry_feed"),
}

@Serializable
enum class InvoiceStatus {
    @SerialName("draft") DRAFT,
    @SerialName("issued") ISSUED,
    @SerialName("paid") PAID,
    @SerialName("void") VOID,
}

@Serializable
data class Profile(
    val id: String,
    @SerialName("company_id") val companyId: String,
    val role: UserRole,
    @SerialName("full_name") val fullName: String,
    val phone: String? = null,
    val email: String? = null,
    @SerialName("subhauler_id") val subhaulerId: String? = null,
    val active: Boolean = true,
)

@Serializable
data class TagImage(
    val id: String,
    @SerialName("tag_id") val tagId: String,
    val version: Int,
    @SerialName("image_path") val imagePath: String,
    @SerialName("captured_at") val capturedAt: String? = null,
    @SerialName("is_current") val isCurrent: Boolean = true,
)

@Serializable
data class RescanRequestRow(
    val id: String,
    @SerialName("tag_id") val tagId: String,
    @SerialName("requested_at") val requestedAt: String,
    val reason: RescanReason,
    val note: String? = null,
    @SerialName("resolved_at") val resolvedAt: String? = null,
    @SerialName("cancelled_at") val cancelledAt: String? = null,
) {
    val isOpen: Boolean get() = resolvedAt == null && cancelledAt == null
}

@Serializable data class NamedRef(val id: String, val name: String)

@Serializable
data class MaterialRef(val id: String, val name: String, val code: String? = null)

@Serializable
data class JobRef(val id: String, val name: String, val number: String? = null)

@Serializable
data class TruckRef(
    val id: String,
    val number: String,
    @SerialName("legal_capacity_tons") val legalCapacityTons: Double? = null,
    @SerialName("avg_tare_tons") val avgTareTons: Double? = null,
)

/**
 * A tag with the joins a phone screen needs, in one round trip.
 *
 * The submitter is deliberately not selected: a driver has no business
 * enumerating who else files tickets, and the policy on `profiles` would refuse
 * the join anyway.
 */
@Serializable
data class Tag(
    val id: String,
    @SerialName("company_id") val companyId: String,
    @SerialName("created_by") val createdBy: String,
    @SerialName("created_at") val createdAt: String,
    val status: TagStatus,
    @SerialName("payee_type") val payeeType: PayeeType,

    val engine: ExtractionEngine? = null,
    @SerialName("ocr_text") val ocrText: String? = null,
    @SerialName("ocr_ms") val ocrMs: Int? = null,

    @SerialName("ticket_number") val ticketNumber: String? = null,
    @SerialName("tag_date") val tagDate: String? = null,
    @SerialName("gross_tons") val grossTons: Double? = null,
    @SerialName("tare_tons") val tareTons: Double? = null,
    @SerialName("net_tons") val netTons: Double? = null,

    @SerialName("computed_pay_cents") val computedPayCents: Int? = null,
    @SerialName("review_reasons") val reviewReasons: List<String> = emptyList(),
    @SerialName("review_notes") val reviewNotes: String? = null,
    @SerialName("rejected_reason") val rejectedReason: String? = null,

    @SerialName("tag_images") val tagImages: List<TagImage> = emptyList(),
    @SerialName("rescan_requests") val rescanRequests: List<RescanRequestRow> = emptyList(),
    val quarries: NamedRef? = null,
    val materials: MaterialRef? = null,
    val jobs: JobRef? = null,
    val trucks: TruckRef? = null,
    val subhaulers: NamedRef? = null,
) {
    val currentImage: TagImage?
        get() = tagImages.firstOrNull { it.isCurrent } ?: tagImages.lastOrNull()

    val openRescan: RescanRequestRow?
        get() = rescanRequests.firstOrNull { it.isOpen }
}

@Serializable
data class Invoice(
    val id: String,
    @SerialName("payee_type") val payeeType: PayeeType,
    @SerialName("period_start") val periodStart: String,
    @SerialName("period_end") val periodEnd: String,
    val status: InvoiceStatus,
    @SerialName("total_cents") val totalCents: Int,
)

/** A quarry the phone is standing in, from `quarry_at()` in 010. */
@Serializable
data class NearbyQuarry(val id: String, val name: String, val metres: Int)
