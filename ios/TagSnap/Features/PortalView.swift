import SwiftUI

/// Driver or subhauler — asked before anything else.
///
/// This is an affordance, not a permission. It changes what the sign-in screen
/// says and sets an expectation the server then confirms or contradicts. See
/// `AppState.loadProfile`, and `docs/ROLES.md` for why the two ledgers can
/// never share a document.
struct PortalView: View {

    @EnvironmentObject private var state: AppState

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 8) {
                Text("TagSnap")
                    .font(.system(size: 40, weight: .heavy, design: .default))
                    .foregroundStyle(Theme.text)
                Text("Photograph the ticket. That is the whole job.")
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.muted)
            }

            Spacer()

            VStack(spacing: 14) {
                Door(
                    title: "Company driver",
                    detail: "You drive one of our trucks and are paid on a settlement.",
                    tint: Theme.driver,
                    icon: "truck.box.fill"
                ) {
                    state.portal = .driver
                    state.phase = .signingIn(.driver)
                }

                Door(
                    title: "Subhauler",
                    detail: "You haul for us under your own outfit and invoice us for it.",
                    tint: Theme.subhauler,
                    icon: "shippingbox.fill"
                ) {
                    state.portal = .subhauler
                    state.phase = .signingIn(.subhauler)
                }
            }
            .padding(.horizontal, 20)

            Text("Office and admin accounts use the web console.")
                .font(.system(size: 14))
                .foregroundStyle(Theme.faint)
                .padding(.top, 24)
                .padding(.bottom, 32)
        }
    }
}

private struct Door: View {
    let title: String
    let detail: String
    let tint: Color
    let icon: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                Image(systemName: icon)
                    .font(.system(size: 26))
                    .foregroundStyle(tint)
                    .frame(width: 44)

                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(Theme.text)
                    Text(detail)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.muted)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 0)
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radius)
                    .strokeBorder(tint.opacity(0.35), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
        }
        .buttonStyle(.plain)
    }
}
