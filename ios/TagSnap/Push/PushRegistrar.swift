import Foundation
import UIKit
import UserNotifications

/// Push registration and handling.
///
/// Straight to APNs — no Firebase, no Expo relay, no third-party SDK. The app
/// hands its device token to `device_tokens`, and `push-rescan` signs a JWT
/// with a `.p8` key and posts to Apple directly. Free, and one fewer service
/// between the office and a driver's phone.
///
/// Two notifications, and deliberately only two:
///
///   * a rescan request, because the office is now blocked on this person
///   * an approval, because it is the one people actually want
///
/// A notification for every status change trains people to swipe them away,
/// and then the rescan gets swiped away too.
@MainActor
final class PushRegistrar: NSObject, ObservableObject, UNUserNotificationCenterDelegate {

    static let shared = PushRegistrar()

    @Published private(set) var isAuthorised = false

    override private init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    /// Ask, once, at a moment when the reason is obvious.
    ///
    /// Called from the account screen and after the first successful capture —
    /// never at launch. A permission prompt on a screen that has not yet
    /// explained itself gets denied, and iOS only lets you ask once.
    func requestPermission() async {
        let granted = (try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound, .badge])) ?? false

        isAuthorised = granted
        if granted { UIApplication.shared.registerForRemoteNotifications() }
    }

    func registerIfPermitted() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        isAuthorised = settings.authorizationStatus == .authorized
        if isAuthorised {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Called by the app delegate once APNs hands over a token.
    func store(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task {
            do {
                try await API.registerDevice(token: hex)
            } catch {
                // Not fatal. Realtime and pull-to-refresh still work; the
                // driver just misses the interruption.
                Log.error("could not register for push: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Delegate

    /// Show the banner even with the app open.
    ///
    /// Normally a bad default. Right here, because the app is open on the
    /// capture screen for most of the day, and a rescan arriving silently
    /// while the driver is photographing the next load is the exact failure
    /// this notification exists to prevent.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    /// A tap opens the ticket it is about, not the app's front door.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        guard let tagId = info["tagId"] as? String else { return }
        await MainActor.run { AppState.shared.pendingTagId = tagId }
    }
}
