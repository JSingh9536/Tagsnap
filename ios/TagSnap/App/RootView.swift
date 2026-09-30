import SwiftUI

/// What the app shows, in order of what has to be true first.
///
/// The tab bar has three tabs and no more. A driver opens this app to do one
/// of three things: photograph a ticket, check whether one went through, or
/// see what they are owed. Anything else belongs behind the account screen.
struct RootView: View {

    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var uploader: Uploader

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            switch state.phase {
            case .starting:
                ProgressView().tint(Theme.driver)

            case .choosingPortal:
                PortalView()

            case .signingIn(let portal):
                SignInView(portal: portal)

            case .wrongPortal(let actual):
                WrongPortalView(actual: actual)

            case .ready:
                MainTabs()
            }

            if state.isLocked, state.phase == .ready {
                LockView()
                    .transition(.opacity)
                    .zIndex(10)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: state.isLocked)
    }
}

private struct MainTabs: View {

    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var uploader: Uploader
    @State private var selection = Tab.capture
    @State private var openTagId: String?

    enum Tab { case capture, tags, pay }

    var body: some View {
        TabView(selection: $selection) {
            CaptureView()
                .tabItem { Label("Capture", systemImage: "camera.fill") }
                .tag(Tab.capture)

            TagsView(openTagId: $openTagId)
                .tabItem { Label("Tickets", systemImage: "list.bullet.rectangle") }
                .badge(uploader.pendingCount)
                .tag(Tab.tags)

            PayView()
                .tabItem { Label("Pay", systemImage: "dollarsign.circle") }
                .tag(Tab.pay)
        }
        .tint(Theme.tint(for: state.payeeType))
        // A tapped notification opens the ticket it is about, not the app's
        // front door. Landing on the capture screen after tapping "retake this
        // ticket" is how a driver ends up filing a second tag for one load,
        // which is the exact duplicate this system exists to prevent.
        .onChange(of: state.pendingTagId) { tagId in
            guard let tagId else { return }
            openTagId = tagId
            selection = .tags
            state.pendingTagId = nil
        }
    }
}

/// You came through the wrong door.
///
/// Shown after a successful sign-in whose profile disagrees with the portal
/// that was picked. The account is already signed back out by the time this
/// appears — see `AppState.loadProfile`.
private struct WrongPortalView: View {

    let actual: Portal
    @EnvironmentObject private var state: AppState

    var body: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: "arrow.uturn.left.circle")
                .font(.system(size: 52))
                .foregroundStyle(Theme.attention)

            Text(headline)
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(Theme.text)
                .multilineTextAlignment(.center)

            Text(body)
                .font(.system(size: 17))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            Spacer()

            Button("Start again") {
                state.phase = .choosingPortal
            }
            .buttonStyle(PrimaryButton())
            .padding(.horizontal, 24)
            .padding(.bottom, 40)
        }
    }

    private var headline: String {
        actual == .office ? "This app is for the field" : "Wrong door"
    }

    private var body: String {
        switch actual {
        case .office:
            return """
            Your account reviews and approves tickets. That work happens in the \
            office console in a browser, where the photo is big enough to read.
            """
        case .driver:
            return "Your account is set up as a company driver. Sign in through the Driver door."
        case .subhauler:
            return "Your account is set up as a subhauler. Sign in through the Subhauler door."
        }
    }
}
