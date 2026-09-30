import SwiftUI

/// The screen over everything when the app comes back from the background.
///
/// Opt-in — see `Biometrics`. It covers the content rather than replacing it,
/// so unlocking puts the driver back exactly where they were rather than
/// resetting them to the front door mid-shift.
struct LockView: View {

    @EnvironmentObject private var state: AppState
    @State private var failed = false

    var body: some View {
        ZStack {
            // Opaque, not a blur. A blurred screenshot of somebody's pay
            // screen is still a screenshot of somebody's pay screen.
            Theme.background.ignoresSafeArea()

            VStack(spacing: 22) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(Theme.driver)

                Text("TagSnap is locked")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundStyle(Theme.text)

                if failed {
                    Text("That did not unlock it.")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.bad)
                }

                Button("Unlock with \(Biometrics.name)") {
                    Task { await unlock() }
                }
                .buttonStyle(PrimaryButton())
                .padding(.horizontal, 40)

                Button("Sign out instead") {
                    Task { await state.signOut() }
                }
                .font(.system(size: 15))
                .foregroundStyle(Theme.faint)
            }
        }
        .task { await unlock() }
    }

    private func unlock() async {
        let ok = await Biometrics.authenticate(reason: "Unlock TagSnap")
        failed = !ok
        if ok { state.isLocked = false }
    }
}
