import SwiftUI

/// Who you are, what is stuck, and the way out.
///
/// Small on purpose. Everything a driver needs day to day is on the other
/// three screens; this is where the two things that occasionally go wrong live
/// — a capture that will not upload, and a phone that needs signing out.
struct AccountView: View {

    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var uploader: Uploader
    @StateObject private var push = PushRegistrar.shared

    @State private var biometricsOn = Biometrics.isEnabled
    @State private var stuck: [Outbox.Row] = []
    @State private var confirmSignOut = false

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    identity
                    if !stuck.isEmpty { stuckCard }
                    settings
                    signOut
                    build
                }
                .padding(20)
            }
        }
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            stuck = Outbox.shared.stuck()
            await push.registerIfPermitted()
        }
    }

    private var identity: some View {
        Card {
            Text(state.profile?.fullName ?? "—")
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(Theme.text)

            HStack(spacing: 8) {
                Text(state.profile?.role.label ?? "")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.tint(for: state.payeeType))
                if let subhauler = state.profile?.subhaulerId, !subhauler.isEmpty {
                    Text("· paid to your outfit")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.faint)
                }
            }

            if let phone = state.profile?.phone {
                Text(phone).font(.system(size: 15)).foregroundStyle(Theme.muted)
            }
        }
    }

    /// Captures that have failed enough times to need a person.
    ///
    /// Left visible rather than retried forever in silence, because the photo
    /// is still on the phone and somebody in the office can be told about it
    /// in a phone call. A silent permanent failure is how a load stops being
    /// paid for.
    private var stuckCard: some View {
        Card {
            Label("\(stuck.count) will not send", systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.bad)

            ForEach(stuck, id: \.id) { row in
                VStack(alignment: .leading, spacing: 2) {
                    Text(Format.date(row.capturedAt))
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Theme.text)
                    Text(row.lastError ?? "Unknown problem.")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Text("The photos are still on this phone. Call the office and tell them the date.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.faint)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var settings: some View {
        Card {
            Toggle(isOn: $biometricsOn) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Require \(Biometrics.name)")
                        .font(.system(size: 16))
                        .foregroundStyle(Theme.text)
                    Text("Ask every time the app is reopened.")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.faint)
                }
            }
            .tint(Theme.driver)
            .disabled(!Biometrics.isAvailable)
            .onChange(of: biometricsOn) { Biometrics.isEnabled = $0 }

            Divider().overlay(Theme.line)

            if push.isAuthorised {
                Label("Notifications are on", systemImage: "bell.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.muted)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Turn on notifications so you know when the office needs a ticket retaken.")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Turn on notifications") {
                        Task { await push.requestPermission() }
                    }
                    .buttonStyle(SecondaryButton())
                }
            }
        }
    }

    private var signOut: some View {
        VStack(spacing: 10) {
            Button("Sign out") { confirmSignOut = true }
                .buttonStyle(PrimaryButton(destructive: true))

            if uploader.pendingCount > 0 {
                Text("\(uploader.pendingCount) still waiting to send. Signing out keeps them on the phone but nothing will upload until you sign back in.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.attention)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .confirmationDialog("Sign out?", isPresented: $confirmSignOut) {
            Button("Sign out", role: .destructive) {
                Task { await state.signOut() }
            }
            Button("Stay signed in", role: .cancel) {}
        }
    }

    private var build: some View {
        Text("TagSnap \(Config.versionString)")
            .font(.system(size: 12))
            .foregroundStyle(Theme.faint)
            .frame(maxWidth: .infinity)
    }
}
