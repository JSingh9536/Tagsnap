import Foundation
import os

/// Logging that will not leak a ticket into a device log.
///
/// `os.Logger` redacts interpolated values by default unless they are marked
/// public, which is the behaviour we want: a crash log or a sysdiagnose from a
/// driver's phone should carry enough to debug a sync failure and nothing that
/// identifies a load, a rate, or a person.
///
/// Everything here is deliberately terse. Anything worth keeping belongs in
/// `audit_log`, which is append-only, attributable, and on the server.
enum Log {

    private static let logger = Logger(subsystem: "com.tagsnap", category: "app")

    static func info(_ message: String) {
        logger.info("\(message, privacy: .public)")
    }

    static func error(_ message: String) {
        logger.error("\(message, privacy: .public)")
    }

    /// For anything that might carry ticket data. Visible while debugging,
    /// redacted in a log pulled off a shipped build.
    static func detail(_ message: String) {
        logger.debug("\(message, privacy: .private)")
    }
}
