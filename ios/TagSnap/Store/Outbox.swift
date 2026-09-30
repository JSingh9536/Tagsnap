import Foundation
import SQLite3

/// What the phone is holding that the server has not got yet.
///
/// The order of operations at capture is the whole point of this file:
///
///   1. write the JPEG to disk
///   2. read it with Vision, **on the device, with no network**
///   3. insert a row here
///   4. tell the driver it is saved
///
/// Only then, whenever there is signal, does anything get uploaded. A quarry
/// scale house is frequently a metal building at the bottom of a pit, and the
/// app has to behave as though there is no connectivity at all — because
/// often there is not.
///
/// Moving OCR onto the device made this strictly better than the old pipeline.
/// Reading used to require reaching a server, so a driver in a dead zone
/// waited hours to find out their photo was unreadable — by which time they
/// had left the quarry. Now they find out in half a second, standing next to
/// the scale house, while retaking it costs nothing.
///
/// SQLite directly rather than Core Data: this is one table with no
/// relationships and no migrations worth the name, and the C API is a hundred
/// lines against a framework's worth of ceremony.
final class Outbox {

    static let shared = Outbox()

    private var db: OpaquePointer?
    private let queue = DispatchQueue(label: "com.tagsnap.outbox")

    /// A capture waiting to go up.
    struct Row {
        let id: String
        let rescanForTagId: String?
        let payeeType: PayeeType
        let driverId: String?
        let subhaulerId: String?
        let localPath: String
        let capturedAt: String
        let capturedLat: Double?
        let capturedLng: Double?
        let phash: Int64?
        let note: String?

        /// The reading, taken at capture time. `nil` when Vision found
        /// nothing usable — that submits `extraction_failed()` instead, which
        /// puts the photo in front of a person rather than filing a reading
        /// of nothing.
        let extractedJSON: String?
        let confidenceJSON: String?
        let rawJSON: String?
        let ocrText: String?
        let ocrMs: Int
        let ocrOK: Bool

        let status: String
        let attempts: Int
        let lastError: String?
        let createdAt: String
    }

    private init() {
        open()
    }

    // MARK: - Setup

    private var databaseURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("tagsnap.sqlite")
    }

    /// Where the JPEGs live until they are safely uploaded.
    ///
    /// Application Support rather than Caches, because the system evicts
    /// Caches under disk pressure and this is the only copy of evidence for a
    /// load somebody is owed money for.
    static var photosDirectory: URL {
        let dir = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("photos", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // Excluded from iCloud backup: these are transient, they are large,
        // and the server copy is the record.
        var url = dir
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)

        return dir
    }

    private func open() {
        guard sqlite3_open(databaseURL.path, &db) == SQLITE_OK else {
            Log.error("could not open the local database")
            return
        }

        exec("pragma journal_mode = WAL;")
        exec("pragma synchronous = FULL;")   // a lost capture is a lost load
        exec("""
        create table if not exists outbox (
          id                text primary key,
          rescan_for_tag_id text,
          payee_type        text not null,
          driver_id         text,
          subhauler_id      text,
          local_path        text not null,
          captured_at       text not null,
          captured_lat      real,
          captured_lng      real,
          phash             integer,
          note              text,
          extracted_json    text,
          confidence_json   text,
          raw_json          text,
          ocr_text          text,
          ocr_ms            integer not null default 0,
          ocr_ok            integer not null default 0,
          status            text not null default 'pending',
          attempts          integer not null default 0,
          last_error        text,
          created_at        text not null,
          sent_at           text
        );
        """)
        exec("create index if not exists outbox_pending on outbox (status, created_at);")
    }

    private func exec(_ sql: String) {
        var error: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &error) != SQLITE_OK, let error {
            Log.error("sqlite: \(String(cString: error))")
            sqlite3_free(error)
        }
    }

    // MARK: - Writes

    func enqueue(_ row: Row) {
        queue.sync {
            let sql = """
            insert or replace into outbox
              (id, rescan_for_tag_id, payee_type, driver_id, subhauler_id,
               local_path, captured_at, captured_lat, captured_lng, phash, note,
               extracted_json, confidence_json, raw_json, ocr_text, ocr_ms, ocr_ok,
               status, attempts, created_at)
            values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', 0, ?);
            """

            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
                Log.error("could not prepare the enqueue")
                return
            }
            defer { sqlite3_finalize(statement) }

            bind(statement, 1, row.id)
            bind(statement, 2, row.rescanForTagId)
            bind(statement, 3, row.payeeType.rawValue)
            bind(statement, 4, row.driverId)
            bind(statement, 5, row.subhaulerId)
            bind(statement, 6, row.localPath)
            bind(statement, 7, row.capturedAt)
            bind(statement, 8, row.capturedLat)
            bind(statement, 9, row.capturedLng)
            if let phash = row.phash {
                sqlite3_bind_int64(statement, 10, phash)
            } else {
                sqlite3_bind_null(statement, 10)
            }
            bind(statement, 11, row.note)
            bind(statement, 12, row.extractedJSON)
            bind(statement, 13, row.confidenceJSON)
            bind(statement, 14, row.rawJSON)
            bind(statement, 15, row.ocrText)
            sqlite3_bind_int(statement, 16, Int32(row.ocrMs))
            sqlite3_bind_int(statement, 17, row.ocrOK ? 1 : 0)
            bind(statement, 18, row.createdAt)

            if sqlite3_step(statement) != SQLITE_DONE {
                Log.error("could not save the capture: \(String(cString: sqlite3_errmsg(db)))")
            }
        }
    }

    func markUploading(_ id: String) {
        run("update outbox set status = 'uploading', attempts = attempts + 1 where id = ?", id)
    }

    func markSent(_ id: String) {
        run("update outbox set status = 'sent', last_error = null, sent_at = datetime('now') where id = ?", id)
    }

    func markFailed(_ id: String, _ message: String) {
        queue.sync {
            var statement: OpaquePointer?
            let sql = "update outbox set status = 'pending', last_error = ? where id = ?"
            guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return }
            defer { sqlite3_finalize(statement) }
            bind(statement, 1, String(message.prefix(300)))
            bind(statement, 2, id)
            sqlite3_step(statement)
        }
    }

    private func run(_ sql: String, _ id: String) {
        queue.sync {
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return }
            defer { sqlite3_finalize(statement) }
            bind(statement, 1, id)
            sqlite3_step(statement)
        }
    }

    // MARK: - Reads

    /// Everything still waiting, oldest first.
    ///
    /// Oldest first because a driver who took eight tickets in a dead zone
    /// wants them to land in the order they hauled them, and because the
    /// oldest is the one closest to falling outside the 45-day window.
    func pending() -> [Row] {
        select("select * from outbox where status in ('pending','uploading') order by created_at asc limit 50")
    }

    func pendingCount() -> Int {
        queue.sync {
            var statement: OpaquePointer?
            let sql = "select count(*) from outbox where status in ('pending','uploading')"
            guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return 0 }
            defer { sqlite3_finalize(statement) }
            return sqlite3_step(statement) == SQLITE_ROW ? Int(sqlite3_column_int(statement, 0)) : 0
        }
    }

    /// Anything stuck: too many attempts, and a person should be told.
    func stuck() -> [Row] {
        select("select * from outbox where status = 'pending' and attempts >= 8 order by created_at asc")
    }

    /// Delete sent rows and hand back the files that can now go.
    ///
    /// Kept for an hour after sending rather than deleted immediately, so that
    /// a driver who checks their list right after a sync still sees the photo
    /// rather than a grey box while the server round trip catches up.
    func pruneSent() -> [String] {
        let rows = select("select * from outbox where status = 'sent' and sent_at < datetime('now', '-1 hour')")
        for row in rows {
            run("delete from outbox where id = ?", row.id)
        }
        return rows.map(\.localPath)
    }

    private func select(_ sql: String) -> [Row] {
        queue.sync {
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return [] }
            defer { sqlite3_finalize(statement) }

            var rows: [Row] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                rows.append(Row(
                    id: text(statement, 0) ?? "",
                    rescanForTagId: text(statement, 1),
                    payeeType: PayeeType(rawValue: text(statement, 2) ?? "") ?? .employeeDriver,
                    driverId: text(statement, 3),
                    subhaulerId: text(statement, 4),
                    localPath: text(statement, 5) ?? "",
                    capturedAt: text(statement, 6) ?? "",
                    capturedLat: double(statement, 7),
                    capturedLng: double(statement, 8),
                    phash: sqlite3_column_type(statement, 9) == SQLITE_NULL
                        ? nil : sqlite3_column_int64(statement, 9),
                    note: text(statement, 10),
                    extractedJSON: text(statement, 11),
                    confidenceJSON: text(statement, 12),
                    rawJSON: text(statement, 13),
                    ocrText: text(statement, 14),
                    ocrMs: Int(sqlite3_column_int(statement, 15)),
                    ocrOK: sqlite3_column_int(statement, 16) == 1,
                    status: text(statement, 17) ?? "pending",
                    attempts: Int(sqlite3_column_int(statement, 18)),
                    lastError: text(statement, 19),
                    createdAt: text(statement, 20) ?? ""
                ))
            }
            return rows
        }
    }

    // MARK: - Binding helpers

    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private func bind(_ statement: OpaquePointer?, _ index: Int32, _ value: String?) {
        if let value {
            sqlite3_bind_text(statement, index, value, -1, Self.transient)
        } else {
            sqlite3_bind_null(statement, index)
        }
    }

    private func bind(_ statement: OpaquePointer?, _ index: Int32, _ value: Double?) {
        if let value {
            sqlite3_bind_double(statement, index, value)
        } else {
            sqlite3_bind_null(statement, index)
        }
    }

    private func text(_ statement: OpaquePointer?, _ column: Int32) -> String? {
        guard let raw = sqlite3_column_text(statement, column) else { return nil }
        return String(cString: raw)
    }

    private func double(_ statement: OpaquePointer?, _ column: Int32) -> Double? {
        sqlite3_column_type(statement, column) == SQLITE_NULL
            ? nil : sqlite3_column_double(statement, column)
    }
}
