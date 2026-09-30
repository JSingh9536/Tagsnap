import SwiftUI

/// Sign in, phone number first.
///
/// A phone number is the one identifier every driver already has, works with
/// gloves on, and does not require anybody to remember a password they set
/// once in an office. Email and password is the alternative, kept because
/// owner-operators often have a work email and prefer it.
///
/// There is no sign-up. Accounts are created by an admin, because a self-serve
/// account on a payables system is a way for somebody to pay themselves.
struct SignInView: View {

    let portal: Portal

    @EnvironmentObject private var state: AppState

    @State private var method: Method = .phone
    @State private var phone = ""
    @State private var code = ""
    @State private var email = ""
    @State private var password = ""
    @State private var codeSent = false
    @State private var busy = false
    @State private var error: String?

    @FocusState private var focus: Field?

    enum Method { case phone, email }
    enum Field { case phone, code, email, password }

    private var tint: Color {
        portal == .subhauler ? Theme.subhauler : Theme.driver
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header

                Picker("How do you sign in?", selection: $method) {
                    Text("Phone").tag(Method.phone)
                    Text("Email").tag(Method.email)
                }
                .pickerStyle(.segmented)

                if method == .phone { phoneFields } else { emailFields }

                if let error {
                    Text(error)
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.bad)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button(action: { Task { await submit() } }) {
                    if busy {
                        ProgressView().tint(.black)
                    } else {
                        Text(primaryLabel)
                    }
                }
                .buttonStyle(PrimaryButton(tint: tint))
                .disabled(busy || !isReady)

                Button("Pick a different door") {
                    state.phase = .choosingPortal
                }
                .font(.system(size: 15))
                .foregroundStyle(Theme.faint)
                .frame(maxWidth: .infinity)
            }
            .padding(24)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(portal == .subhauler ? "Subhauler sign-in" : "Driver sign-in")
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(Theme.text)
            Text("No account here? The office creates them.")
                .font(.system(size: 15))
                .foregroundStyle(Theme.muted)
        }
        .padding(.top, 24)
    }

    @ViewBuilder private var phoneFields: some View {
        FieldBox(label: "Mobile number") {
            TextField("(555) 555-0123", text: $phone)
                .keyboardType(.phonePad)
                .textContentType(.telephoneNumber)
                .focused($focus, equals: .phone)
                .disabled(codeSent)
        }

        if codeSent {
            FieldBox(label: "The 6-digit code we just texted you") {
                TextField("123456", text: $code)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .focused($focus, equals: .code)
            }

            Button("Use a different number") {
                codeSent = false
                code = ""
            }
            .font(.system(size: 15))
            .foregroundStyle(tint)
        }
    }

    @ViewBuilder private var emailFields: some View {
        FieldBox(label: "Email") {
            TextField("you@example.com", text: $email)
                .keyboardType(.emailAddress)
                .textContentType(.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focus, equals: .email)
        }
        FieldBox(label: "Password") {
            SecureField("••••••••", text: $password)
                .textContentType(.password)
                .focused($focus, equals: .password)
        }
    }

    private var primaryLabel: String {
        if method == .email { return "Sign in" }
        return codeSent ? "Sign in" : "Text me a code"
    }

    private var isReady: Bool {
        if method == .email {
            return email.contains("@") && password.count >= 6
        }
        return codeSent ? code.count >= 6 : phone.filter(\.isNumber).count >= 10
    }

    private func submit() async {
        busy = true
        error = nil
        defer { busy = false }

        do {
            if method == .email {
                try await Supabase.shared.signIn(email: email, password: password)
                try await state.loadProfile()
            } else if codeSent {
                try await Supabase.shared.verifyPhoneCode(phone: phone, code: code)
                try await state.loadProfile()
            } else {
                try await Supabase.shared.sendPhoneCode(to: phone)
                codeSent = true
                focus = .code
            }
        } catch {
            // Deliberately vague about *which* half was wrong. Saying "no such
            // number" tells anyone holding the phone whose numbers are on the
            // system.
            self.error = (error as? LocalizedError)?.errorDescription
                ?? "That did not work. Check what you typed and try again."
        }
    }
}

/// A labelled input sized for a gloved thumb.
private struct FieldBox<Content: View>: View {
    let label: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.muted)
            content
                .font(.system(size: 20))
                .foregroundStyle(Theme.text)
                .padding(14)
                .frame(minHeight: 54)
                .background(Theme.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
        }
    }
}
