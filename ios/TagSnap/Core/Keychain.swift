import Foundation
import Security

/// The session, kept where a lost phone does not give it away.
///
/// A refresh token is a long-lived credential for someone's pay records, so it
/// does not go in UserDefaults — that file is readable from a backup and from
/// any process that can reach the container. Keychain with
/// `WhenUnlockedThisDeviceOnly` means it never leaves this handset, does not
/// travel in an iCloud backup, and is unreadable while the phone is locked.
///
/// This is threat #2 from `Trucktags/docs/SECURITY.md` — a phone left in a
/// truck cab at a job site — and it is the cheapest one to close properly.
enum Keychain {

    private static let service = "com.tagsnap.session"

    static func set(_ value: String, for account: String) {
        let data = Data(value.utf8)

        // Delete-then-add rather than SecItemUpdate: fewer branches, and an
        // update that silently fails leaves a stale token behind, which is the
        // worst outcome here.
        remove(account)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        if status != errSecSuccess {
            Log.error("keychain write failed for \(account): \(status)")
        }
    }

    static func get(_ account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let string = String(data: data, encoding: .utf8)
        else { return nil }

        return string
    }

    static func remove(_ account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // Named accounts, so a typo is a compile error rather than a silent miss.
    static let accessToken = "access_token"
    static let refreshToken = "refresh_token"
    static let expiresAt = "expires_at"
    static let userId = "user_id"
}
