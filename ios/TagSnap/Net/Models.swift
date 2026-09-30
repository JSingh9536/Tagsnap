import Foundation

/// The row shapes, mirroring `supabase/migrations/001_schema.sql` and
/// `packages/shared/src/types.ts`.
///
/// Decoding uses `.convertFromSnakeCase`, so `ticket_number` arrives as
/// `ticketNumber` with no CodingKeys to maintain. The exception is anything
/// that has to be *encoded* back to PostgREST, which needs the database's
/// spelling — those types declare their keys explicitly.
///
/// Every optional here is optional in the database too. A tag that has been
/// photographed but not yet read has nulls in most of these columns, and the
/// UI has to say "not read yet" rather than "0.00 tons".

// MARK: - Enums

enum UserRole: String, Codable {
    case driver, subhauler, office, admin

    var label: String {
        switch self {
        case .driver: return "Driver"
        case .subhauler: return "Subhauler"
        case .office: return "Office"
        case .admin: return "Admin"
        }
    }

    /// Which door this account belongs to. Office and admin have no business
    /// on a phone — their work is the review screen, which needs a wide layout
    /// and a photo big enough to read a faded carbon copy on.
    var portal: Portal {
        switch self {
        case .subhauler: return .subhauler
        case .driver: return .driver
        case .office, .admin: return .office
        }
    }

    var payeeType: PayeeType {
        self == .subhauler ? .subhauler : .employeeDriver
    }
}

enum Portal: String {
    case driver, subhauler, office
}

enum PayeeType: String, Codable {
    case employeeDriver = "employee_driver"
    case subhauler

    var label: String {
        self == .subhauler ? "Subhauler" : "Company driver"
    }

    var ledgerLabel: String {
        self == .subhauler ? "Subhauler payable" : "Driver settlement"
    }
}

enum TagStatus: String, Codable {
    case queued, uploaded, extracted
    case needsReview = "needs_review"
    case rescanRequested = "rescan_requested"
    case ready, approved, invoiced, rejected

    /// What the field crew is told, from their point of view rather than the
    /// pipeline's. They do not care what a stage is called, only whether their
    /// money is moving.
    var driverLabel: String {
        switch self {
        case .queued: return "Waiting for signal"
        case .uploaded: return "Sent"
        case .extracted: return "Being read"
        case .needsReview, .ready: return "With the office"
        case .rescanRequested: return "Rescan needed"
        case .approved: return "Approved"
        case .invoiced: return "On your invoice"
        case .rejected: return "Rejected"
        }
    }

    var tone: Tone {
        switch self {
        case .queued, .uploaded, .extracted, .ready: return .pending
        case .needsReview, .rescanRequested: return .attention
        case .approved, .invoiced: return .good
        case .rejected: return .bad
        }
    }

    enum Tone { case pending, attention, good, bad }
}

enum RescanReason: String, Codable, CaseIterable {
    case unreadable, cropped
    case wrongDocument = "wrong_document"
    case missingFields = "missing_fields"
    case duplicateCheck = "duplicate_check"
    case other

    var label: String {
        switch self {
        case .unreadable: return "Can't read it"
        case .cropped: return "Part of the ticket is cut off"
        case .wrongDocument: return "Not a scale ticket"
        case .missingFields: return "A needed field is missing"
        case .duplicateCheck: return "Possible duplicate"
        case .other: return "Other"
        }
    }

    /// What to *do*, not what went wrong. This is printed across the camera
    /// screen while the driver retakes the photo, so it has to be an
    /// instruction that can be followed while holding a phone in one hand.
    var instruction: String {
        switch self {
        case .unreadable:
            return "Retake it in better light. Hold the ticket flat and keep your shadow off it."
        case .cropped:
            return "Retake it with all four corners of the ticket inside the frame."
        case .wrongDocument:
            return "That was not a scale ticket. Photograph the ticket for this load."
        case .missingFields:
            return "Retake it so the whole ticket is visible, including the margins."
        case .duplicateCheck:
            return "This looks like a ticket already submitted. Retake it, or call the office if it is a separate load."
        case .other:
            return "Retake the photo. See the note from the office."
        }
    }
}

enum ExtractionEngine: String, Codable {
    case appleVision = "apple_vision"
    case mlkit
    case tesseract
    case officeManual = "office_manual"
    case quarryFeed = "quarry_feed"
}

enum InvoiceStatus: String, Codable {
    case draft, issued, paid, void
}

// MARK: - Rows

struct Profile: Codable, Identifiable {
    let id: String
    let companyId: String
    let role: UserRole
    let fullName: String
    let phone: String?
    let email: String?
    let subhaulerId: String?
    let active: Bool
}

struct TagImage: Codable, Identifiable {
    let id: String
    let tagId: String
    let version: Int
    let imagePath: String
    let bytes: Int?
    let width: Int?
    let height: Int?
    let capturedAt: String?
    let capturedLat: Double?
    let capturedLng: Double?
    let isCurrent: Bool
}

struct RescanRequestRow: Codable, Identifiable {
    let id: String
    let tagId: String
    let requestedAt: String
    let reason: RescanReason
    let note: String?
    let resolvedAt: String?
    let cancelledAt: String?

    var isOpen: Bool { resolvedAt == nil && cancelledAt == nil }
}

struct NamedRef: Codable {
    let id: String
    let name: String
}

struct MaterialRef: Codable {
    let id: String
    let name: String
    let code: String?
}

struct JobRef: Codable {
    let id: String
    let name: String
    let number: String?
}

struct TruckRef: Codable {
    let id: String
    let number: String
    let legalCapacityTons: Double?
    let avgTareTons: Double?
}

/// A tag with the joins the phone screens need, in one round trip.
///
/// The field app deliberately does not select the submitter: a driver has no
/// business enumerating who else files tickets, and the RLS policy on
/// `profiles` would refuse the join anyway.
struct Tag: Codable, Identifiable {
    let id: String
    let companyId: String
    let createdBy: String
    let createdAt: String
    let status: TagStatus
    let payeeType: PayeeType
    let driverId: String?
    let subhaulerId: String?

    let engine: ExtractionEngine?
    let engineVersion: String?
    let ocrText: String?
    let ocrMs: Int?
    let extractedAt: String?

    let ticketNumber: String?
    let tagDate: String?
    let grossTons: Double?
    let tareTons: Double?
    let netTons: Double?

    let computedPayCents: Int?
    let reviewReasons: [String]
    let reviewNotes: String?
    let rescanCount: Int
    let approvedAt: String?
    let rejectedReason: String?

    let tagImages: [TagImage]?
    let rescanRequests: [RescanRequestRow]?
    let quarries: NamedRef?
    let materials: MaterialRef?
    let jobs: JobRef?
    let trucks: TruckRef?
    let subhaulers: NamedRef?

    var currentImage: TagImage? {
        tagImages?.first(where: \.isCurrent) ?? tagImages?.last
    }

    var openRescan: RescanRequestRow? {
        rescanRequests?.first(where: \.isOpen)
    }
}

struct Invoice: Codable, Identifiable {
    let id: String
    let payeeType: PayeeType
    let periodStart: String
    let periodEnd: String
    let status: InvoiceStatus
    let totalCents: Int
}

/// A quarry the phone is standing in, from `quarry_at()` in 010.
struct NearbyQuarry: Codable, Identifiable {
    let id: String
    let name: String
    let metres: Int
}
