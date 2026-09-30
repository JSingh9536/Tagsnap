import Foundation
import Network
import UIKit

/// The upload worker.
///
/// Runs whenever there is connectivity and something is waiting. Four steps
/// per capture, in this order and for a reason:
///
///   1. create the `tags` row       — the storage policy in 004 checks that
///                                    the tag exists and is not frozen, so the
///                                    row has to land first
///   2. upload the image            — straight to the private bucket
///   3. create the `tag_images` row — this is what supersedes any prior photo
///                                    and closes an open rescan request
///   4. submit the reading          — `apply_extraction`, or
///                                    `extraction_failed` if the phone could
///                                    not read it
///
/// Every step is idempotent. Step 1 upserts on a client-generated primary key,
/// step 2 overwrites the same object path, step 3 is skipped when a row for
/// that version already exists, and step 4 can be re-run on a tag that is
/// already `extracted`. A worker killed mid-flight and restarted lands in the
/// same place, which matters because in this line of work it will be.
@MainActor
final class Uploader: ObservableObject {

    static let shared = Uploader()

    @Published private(set) var pendingCount = 0
    @Published private(set) var isSyncing = false
    @Published private(set) var lastError: String?
    @Published private(set) var isOnline = true

    private var running = false
    private let monitor = NWPathMonitor()

    private init() {
        pendingCount = Outbox.shared.pendingCount()

        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                let wasOffline = self?.isOnline == false
                self?.isOnline = path.status == .satisfied
                // Coming back into coverage is the moment worth acting on: a
                // driver pulling out of a pit gets their morning uploaded
                // without touching the phone.
                if wasOffline, path.status == .satisfied {
                    await self?.sync()
                }
            }
        }
        monitor.start(queue: DispatchQueue(label: "com.tagsnap.network"))
    }

    /// Give up on a row after this many tries and let the driver see it stuck.
    private let maxAttempts = 8

    /// Exponential, capped. A dead zone lasts as long as it lasts.
    private func backoff(_ attempts: Int) -> TimeInterval {
        min(pow(2, Double(attempts)), 300)
    }

    func refreshCount() {
        pendingCount = Outbox.shared.pendingCount()
    }

    @discardableResult
    func sync() async -> Int {
        guard !running, isOnline else { return 0 }
        running = true
        isSyncing = true
        defer {
            running = false
            isSyncing = false
            pendingCount = Outbox.shared.pendingCount()
        }

        var sent = 0

        for row in Outbox.shared.pending() {
            guard row.attempts < maxAttempts else { continue }

            // Respect backoff without holding the worker open.
            if row.attempts > 0,
               let created = ISO8601DateFormatter().date(from: row.createdAt),
               Date().timeIntervalSince(created) < backoff(row.attempts) {
                continue
            }

            do {
                Outbox.shared.markUploading(row.id)
                try await upload(row)
                Outbox.shared.markSent(row.id)
                sent += 1
                lastError = nil
            } catch {
                Outbox.shared.markFailed(row.id, error.localizedDescription)
                lastError = error.localizedDescription
                Log.error("upload failed: \(error.localizedDescription)")
            }
        }

        for path in Outbox.shared.pruneSent() {
            try? FileManager.default.removeItem(atPath: path)
        }

        return sent
    }

    // MARK: - One capture

    private func upload(_ row: Outbox.Row) async throws {
        let isRescan = row.rescanForTagId != nil
        let tagId = row.rescanForTagId ?? row.id
        let supabase = Supabase.shared

        guard let userId = await supabase.currentUserId else {
            throw SupabaseError.signedOut
        }
        guard let profile = AppState.shared.profile else {
            throw SupabaseError.signedOut
        }

        // --- 1. the tag row -------------------------------------------------
        if !isRescan {
            var values: [String: Any] = [
                "id": tagId,
                "company_id": profile.companyId,
                "payee_type": row.payeeType.rawValue,
                "source": "driver_photo",
                "status": "uploaded",
            ]
            values["driver_id"] = row.driverId ?? NSNull()
            values["subhauler_id"] = row.subhaulerId ?? NSNull()
            if let note = row.note { values["review_notes"] = note }

            do {
                try await supabase.insert("tags", values: values, upsert: true)
            } catch SupabaseError.duplicate {
                // A previous attempt already got this far. That is success.
            }
        }

        // --- 2. the image ---------------------------------------------------
        let version = try await nextVersion(tagId: tagId)
        let path = "\(profile.companyId)/\(tagId)/v\(version).jpg"

        guard let data = FileManager.default.contents(atPath: row.localPath) else {
            // The photo is gone from disk. Nothing to retry forever over, and
            // pretending otherwise leaves a row that never clears.
            throw SupabaseError.server("That photo is no longer on this device.")
        }

        try await supabase.uploadImage(data: data, path: path)

        // --- 3. the image row ------------------------------------------------
        // Last of the storage steps, because this is the one that supersedes
        // the previous photo and closes an open rescan. If the process dies
        // before it, step 2 just re-runs harmlessly.
        var image: [String: Any] = [
            "tag_id": tagId,
            "version": version,
            "image_path": path,
            "bytes": data.count,
            "captured_at": row.capturedAt,
            "uploaded_by": userId,
            "is_current": true,
        ]
        image["captured_lat"] = row.capturedLat ?? NSNull()
        image["captured_lng"] = row.capturedLng ?? NSNull()
        // Postgres bigint over JSON: sent as a string so a 64-bit value cannot
        // lose its low bits to a JavaScript double on the way through
        // PostgREST.
        image["image_phash"] = row.phash.map { String($0) } ?? NSNull()

        do {
            try await supabase.insert("tag_images", values: image)
        } catch SupabaseError.duplicate {
            // Already attached on a previous attempt.
        }

        // --- 4. the reading ---------------------------------------------------
        // This is the step that used to be a paid server-side model call. It
        // is now a plain database write of work the phone already did, for
        // free, possibly hours ago in a dead zone.
        if row.ocrOK,
           let extracted = json(row.extractedJSON),
           let confidence = json(row.confidenceJSON) {

            var args: [String: Any] = [
                "p_tag_id": tagId,
                "p_extracted": extracted,
                "p_confidence": confidence,
                "p_engine": ExtractionEngine.appleVision.rawValue,
                "p_engine_version": UIDeviceVersion,
                "p_ocr_ms": row.ocrMs,
            ]
            args["p_ocr_text"] = row.ocrText ?? NSNull()
            args["p_raw"] = json(row.rawJSON) ?? NSNull()

            try await supabase.rpcVoid("apply_extraction", args: args)
        } else {
            try await supabase.rpcVoid("extraction_failed", args: [
                "p_tag_id": tagId,
                "p_engine": ExtractionEngine.appleVision.rawValue,
                "p_reason": "ocr_unreadable",
                "p_ocr_text": row.ocrText ?? NSNull(),
            ])
        }
    }

    /// The next image version for a tag.
    ///
    /// The database assigns this too, in a trigger — this is only so the
    /// storage path is predictable before the row exists. A collision is
    /// harmless because the trigger has the final say on the column.
    private func nextVersion(tagId: String) async throws -> Int {
        struct VersionRow: Decodable { let version: Int }
        let rows: [VersionRow] = try await Supabase.shared.select(
            "tag_images",
            query: "select=version&tag_id=eq.\(tagId)&order=version.desc&limit=1"
        )
        return (rows.first?.version ?? 0) + 1
    }

    private func json(_ string: String?) -> Any? {
        guard let string, let data = string.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }
}

/// Recorded on every reading, so a drop in accuracy after an iOS update is
/// visible in `daily_extraction_health` rather than being a rumour.
let UIDeviceVersion = "ios-\(UIDevice.current.systemVersion)"
