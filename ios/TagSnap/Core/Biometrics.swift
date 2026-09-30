import Foundation
import LocalAuthentication

/// Face ID or Touch ID in front of the app.
///
/// This is threat #2 from `Trucktags/docs/SECURITY.md`: a phone left in a
/// truck cab, or borrowed by whoever is next in the yard. It is opt-in and
/// off by default, because forcing it on a driver whose hands are filthy at
/// 5 a.m. gets the app deleted rather than making anything safer.
///
/// What it protects is modest and worth being honest about: it stops casual
/// access to somebody's pay history and stops a borrowed phone filing a
/// ticket under their name. It does not protect against a determined attacker
/// with the handset, and the real control there is that a driver cannot edit
/// a submitted tag and cannot approve anything.
enum Biometrics {

    private static let key = "biometrics_enabled"

    static var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: key) }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    /// Is there any biometric or passcode to fall back on?
    static var isAvailable: Bool {
        LAContext().canEvaluatePolicy(
            .deviceOwnerAuthentication, error: nil
        )
    }

    static var name: String {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        default: return "your passcode"
        }
    }

    /// `.deviceOwnerAuthentication`, not `.deviceOwnerAuthenticationWithBiometrics`:
    /// the passcode fallback matters here, because a driver in a dust mask and
    /// safety glasses will fail Face ID all morning.
    static func authenticate(reason: String) async -> Bool {
        let context = LAContext()
        context.localizedFallbackTitle = "Use passcode"

        return await withCheckedContinuation { continuation in
            context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: reason
            ) { success, _ in
                continuation.resume(returning: success)
            }
        }
    }
}
