import Foundation
import SwiftUI

/// Who is signed in, which door they came through, and whether the app is
/// locked.
///
/// The portal question — "Driver or Subhauler?" — is asked before sign-in
/// because it changes what the sign-in screen says and it is the first thing
/// somebody handed a phone needs to answer. It is emphatically **not** what
/// grants the role.
///
/// The flow is: pick a door → authenticate → ask the server who this actually
/// is → if the two disagree, sign back out and say which door to use. Letting
/// the picker grant the role would make choosing "Office" a privilege
/// escalation, which is the sort of thing that looks obviously wrong written
/// down and completely reasonable while you are building a login screen.
@MainActor
final class AppState: ObservableObject {

    static let shared = AppState()

    enum Phase: Equatable {
        case starting
        case choosingPortal
        case signingIn(Portal)
        case ready
        case wrongPortal(actual: Portal)
    }

    @Published var phase: Phase = .starting
    @Published var portal: Portal = .driver
    @Published private(set) var profile: Profile?

    /// Set when the app returns from the background and biometrics are on.
    @Published var isLocked = false

    /// A tag id from a tapped notification, consumed by the root view.
    @Published var pendingTagId: String?

    private init() {}

    // MARK: - Launch

    func start() async {
        await Supabase.shared.restoreSession()

        guard await Supabase.shared.isSignedIn else {
            phase = .choosingPortal
            return
        }

        do {
            try await loadProfile()
        } catch {
            // A session that cannot load a profile is a session for an account
            // that has been deactivated or deleted. Do not leave someone
            // staring at an empty list wondering.
            await Supabase.shared.signOut()
            phase = .choosingPortal
        }
    }

    /// Fetch the profile and reconcile it against the door they picked.
    func loadProfile() async throws {
        guard let userId = await Supabase.shared.currentUserId else {
            throw SupabaseError.signedOut
        }

        let rows: [Profile] = try await Supabase.shared.select(
            "profiles",
            query: "select=*&id=eq.\(userId)&limit=1"
        )

        guard let me = rows.first else { throw SupabaseError.signedOut }
        guard me.active else {
            await Supabase.shared.signOut()
            phase = .choosingPortal
            throw SupabaseError.server("This account has been deactivated.")
        }

        profile = me

        // Office and admin accounts are turned away from the phone entirely.
        // Their work is the review screen, which needs a wide layout and a
        // photo big enough to read a faded carbon copy on.
        if me.role.portal == .office {
            await Supabase.shared.signOut()
            profile = nil
            phase = .wrongPortal(actual: .office)
            return
        }

        if me.role.portal != portal {
            await Supabase.shared.signOut()
            profile = nil
            phase = .wrongPortal(actual: me.role.portal)
            return
        }

        phase = .ready
        isLocked = Biometrics.isEnabled
        await PushRegistrar.shared.registerIfPermitted()
    }

    func signOut() async {
        await Supabase.shared.signOut()
        profile = nil
        phase = .choosingPortal
    }

    // MARK: - Filing a tag

    /// Which payee this person's loads land on.
    ///
    /// Read from `profiles.role`, never from the portal picker, and it follows
    /// the ticket all the way to the invoice. A subhauler's loads are a
    /// payable to their *outfit* — you owe the company, not the individual
    /// behind the wheel — which is why `subhaulerId` is the payee here and the
    /// person is only who filed it.
    var payeeType: PayeeType { profile?.role.payeeType ?? .employeeDriver }

    var driverId: String? {
        payeeType == .employeeDriver ? profile?.id : nil
    }

    var subhaulerId: String? {
        payeeType == .subhauler ? profile?.subhaulerId : nil
    }
}
