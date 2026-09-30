import SwiftUI
import UIKit

@main
struct TagSnapApp: App {

    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var state = AppState.shared
    @StateObject private var uploader = Uploader.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .environmentObject(uploader)
                .preferredColorScheme(.dark)
                .task { await state.start() }
                .onChange(of: scenePhase) { phase in
                    switch phase {
                    case .active:
                        // Coming back to the foreground is the cheapest moment
                        // to drain the outbox: the driver has just pulled out
                        // of a pit and has signal again.
                        Task { await uploader.sync() }
                    case .background:
                        if Biometrics.isEnabled { state.isLocked = true }
                    default:
                        break
                    }
                }
        }
    }
}

/// Only here for APNs, which has no SwiftUI equivalent.
final class AppDelegate: NSObject, UIApplicationDelegate {

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in PushRegistrar.shared.store(deviceToken: deviceToken) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Simulator, or a build without the push entitlement. Neither is worth
        // interrupting anyone about.
        Log.error("push registration failed: \(error.localizedDescription)")
    }
}
