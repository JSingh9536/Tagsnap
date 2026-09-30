import Foundation

/// A small Supabase client, written here rather than imported.
///
/// The reason is not purity. This app talks to four documented, stable HTTP
/// APIs — GoTrue, PostgREST, Storage, and Edge Functions — and needs perhaps
/// four hundred lines to do it. Against that: an SDK dependency that has to be
/// version-matched to Xcode, resolved on every clean build, and audited every
/// time it updates, in an app whose whole point is that it keeps working in a
/// truck cab with no signal. The trade is not close.
///
/// The result is that this target has **no third-party dependencies at all**.
/// Everything it uses ships with iOS.
///
/// What this client does not do, on purpose: it has no query builder, no
/// realtime socket, and no offline cache. Reads are plain PostgREST URLs, live
/// updates are a pull-to-refresh and a push notification, and the offline
/// story is the outbox in `Store/Outbox.swift`, which is a different and
/// simpler problem than a general cache.
actor Supabase {

    static let shared = Supabase()

    private let session: URLSession = {
        let config = URLSessionConfiguration.default
        // A driver at a quarry has one bar and a lot of concrete around them.
        // Long enough to survive that; short enough that a dead zone does not
        // hang the UI behind a spinner for a minute.
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }()

    // MARK: - Session

    private var accessToken: String?
    private var refreshToken: String?
    private var expiresAt: Date?

    /// Set once at launch from the Keychain, so a cold start on a plane still
    /// knows who is signed in and can show their tags from the local outbox.
    func restoreSession() {
        accessToken = Keychain.get(Keychain.accessToken)
        refreshToken = Keychain.get(Keychain.refreshToken)
        if let raw = Keychain.get(Keychain.expiresAt), let seconds = Double(raw) {
            expiresAt = Date(timeIntervalSince1970: seconds)
        }
    }

    var isSignedIn: Bool { refreshToken != nil }

    var currentUserId: String? { Keychain.get(Keychain.userId) }

    private func store(_ token: TokenResponse) {
        accessToken = token.accessToken
        refreshToken = token.refreshToken
        expiresAt = Date().addingTimeInterval(TimeInterval(token.expiresIn))

        Keychain.set(token.accessToken, for: Keychain.accessToken)
        Keychain.set(token.refreshToken, for: Keychain.refreshToken)
        Keychain.set(String(expiresAt!.timeIntervalSince1970), for: Keychain.expiresAt)
        if let id = token.user?.id {
            Keychain.set(id, for: Keychain.userId)
        }
    }

    func signOut() async {
        // Best effort. If the network call fails the local session is still
        // destroyed, which is the part that matters on a phone someone just
        // handed back.
        if let token = accessToken {
            var request = URLRequest(url: Config.authURL.appendingPathComponent("logout"))
            request.httpMethod = "POST"
            request.setValue(Config.anonKey, forHTTPHeaderField: "apikey")
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            _ = try? await session.data(for: request)
        }

        accessToken = nil
        refreshToken = nil
        expiresAt = nil
        Keychain.remove(Keychain.accessToken)
        Keychain.remove(Keychain.refreshToken)
        Keychain.remove(Keychain.expiresAt)
        Keychain.remove(Keychain.userId)
    }

    /// A valid access token, refreshing first if it is about to expire.
    ///
    /// Actor isolation is doing real work here: two screens loading at once
    /// would otherwise both notice the expiry and both refresh, and GoTrue
    /// rotates refresh tokens — so the second call would present one that the
    /// first had already consumed and the user would be signed out mid-shift.
    func validToken() async throws -> String {
        if let token = accessToken, let expiry = expiresAt,
           expiry.timeIntervalSinceNow > 60 {
            return token
        }
        guard let refresh = refreshToken else { throw SupabaseError.signedOut }

        var request = URLRequest(url: Config.authURL.appendingPathComponent("token"))
        request.url = request.url?.appending(queryItems: [
            URLQueryItem(name: "grant_type", value: "refresh_token")
        ])
        request.httpMethod = "POST"
        request.setValue(Config.anonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(
            withJSONObject: ["refresh_token": refresh]
        )

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            // A refused refresh means the session is genuinely over — revoked,
            // expired, or the account was deactivated. Clear it rather than
            // retrying into a loop.
            await signOut()
            throw SupabaseError.signedOut
        }

        let token = try decoder.decode(TokenResponse.self, from: data)
        store(token)
        return token.accessToken
    }

    // MARK: - Sign in

    /// Phone OTP. The lead path in the field: gloves on, no work email, and a
    /// phone number is the one identifier every driver already has.
    func sendPhoneCode(to phone: String) async throws {
        try await postAuth("otp", body: ["phone": normalisePhone(phone), "create_user": false])
    }

    func verifyPhoneCode(phone: String, code: String) async throws {
        let token: TokenResponse = try await postAuth(
            "verify",
            body: ["phone": normalisePhone(phone), "token": code, "type": "sms"]
        )
        store(token)
    }

    /// Email and password, for owner-operators who have one and prefer it.
    func signIn(email: String, password: String) async throws {
        let token: TokenResponse = try await postAuth(
            "token?grant_type=password",
            body: ["email": email.trimmingCharacters(in: .whitespaces), "password": password]
        )
        store(token)
    }

    /// US-centric on purpose: this is a regional haul operation, and a driver
    /// typing their own number will not type `+1`.
    private func normalisePhone(_ raw: String) -> String {
        let digits = raw.filter(\.isNumber)
        if digits.count == 10 { return "+1\(digits)" }
        if digits.count == 11, digits.hasPrefix("1") { return "+\(digits)" }
        return raw.hasPrefix("+") ? raw : "+\(digits)"
    }

    @discardableResult
    private func postAuth<T: Decodable>(
        _ path: String, body: [String: Any]
    ) async throws -> T {
        let url = Config.authURL.appendingPathComponent(path.components(separatedBy: "?")[0])
        var request = URLRequest(url: path.contains("?")
            ? URL(string: url.absoluteString + "?" + path.components(separatedBy: "?")[1])!
            : url)
        request.httpMethod = "POST"
        request.setValue(Config.anonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)
        try check(response, data, context: "sign in")

        if T.self == Empty.self { return Empty() as! T }
        return try decoder.decode(T.self, from: data)
    }

    private func postAuth(_ path: String, body: [String: Any]) async throws {
        let _: Empty = try await postAuth(path, body: body)
    }

    // MARK: - PostgREST

    /// A read. `query` is the raw PostgREST query string — `select=…&order=…`.
    ///
    /// There is no filter argument by design. Every read in this app is scoped
    /// by Row Level Security rather than by a WHERE clause the client
    /// remembered to add: a driver gets their own tags because the database
    /// says so. A forgotten filter here would be a cosmetic bug; a forgotten
    /// policy would be a data leak, and there is no way to forget a policy.
    func select<T: Decodable>(_ table: String, query: String) async throws -> [T] {
        let url = URL(string: "\(Config.restURL.absoluteString)/\(table)?\(query)")!
        var request = URLRequest(url: url)
        try await authorise(&request)

        let (data, response) = try await session.data(for: request)
        try check(response, data, context: "loading \(table)")
        return try decoder.decode([T].self, from: data)
    }

    func insert(_ table: String, values: [String: Any], upsert: Bool = false) async throws {
        let url = URL(string: "\(Config.restURL.absoluteString)/\(table)")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        try await authorise(&request)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(
            upsert ? "return=minimal,resolution=merge-duplicates" : "return=minimal",
            forHTTPHeaderField: "Prefer"
        )
        request.httpBody = try JSONSerialization.data(withJSONObject: values)

        let (data, response) = try await session.data(for: request)
        try check(response, data, context: "saving to \(table)")
    }

    /// Call a database function. This is how the app writes anything that has
    /// rules attached to it — `apply_extraction`, `extraction_failed` — so the
    /// rules live in one place that a client cannot route around.
    @discardableResult
    func rpc<T: Decodable>(_ name: String, args: [String: Any]) async throws -> T {
        let url = Config.restURL.appendingPathComponent("rpc/\(name)")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        try await authorise(&request)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: args)

        let (data, response) = try await session.data(for: request)
        try check(response, data, context: name)

        if T.self == Empty.self { return Empty() as! T }
        return try decoder.decode(T.self, from: data)
    }

    func rpcVoid(_ name: String, args: [String: Any]) async throws {
        let _: Empty = try await rpc(name, args: args)
    }

    // MARK: - Storage

    /// Upload one photo to the private bucket.
    ///
    /// `x-upsert` makes this idempotent: a retry after a dropped connection
    /// overwrites the same object rather than creating a second one, which
    /// matters because the retry path is the normal path in the field.
    func uploadImage(data: Data, path: String) async throws {
        let url = Config.storageURL
            .appendingPathComponent("object")
            .appendingPathComponent(Config.imageBucket)
            .appendingPathComponent(path)

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        try await authorise(&request)
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        request.setValue("true", forHTTPHeaderField: "x-upsert")
        request.httpBody = data

        let (body, response) = try await session.data(for: request)
        try check(response, body, context: "uploading the photo")
    }

    /// A short-lived URL for one image, minted by an edge function rather than
    /// by the client, so the TTL and the permission check live server-side
    /// where nobody can lengthen either.
    func signedImageURL(path: String) async throws -> URL {
        struct Body: Decodable { let url: String }
        let response: Body = try await callFunction("sign-image", body: ["path": path])
        guard let url = URL(string: response.url) else {
            throw SupabaseError.server("That photo link came back malformed.")
        }
        return url
    }

    // MARK: - Edge functions

    func callFunction<T: Decodable>(_ name: String, body: [String: Any]) async throws -> T {
        var request = URLRequest(url: Config.functionsURL.appendingPathComponent(name))
        request.httpMethod = "POST"
        try await authorise(&request)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)
        try check(response, data, context: name)
        return try decoder.decode(T.self, from: data)
    }

    // MARK: - Plumbing

    private func authorise(_ request: inout URLRequest) async throws {
        let token = try await validToken()
        request.setValue(Config.anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    /// Turn an HTTP failure into something a driver can act on.
    ///
    /// PostgREST error bodies are precise and completely unreadable to anyone
    /// who has not seen one before. The two that actually reach a driver —
    /// a duplicate ticket and an RLS refusal — get plain sentences; everything
    /// else gets a generic line and the detail goes to the log.
    private func check(_ response: URLResponse, _ data: Data, context: String) throws {
        guard let http = response as? HTTPURLResponse else {
            throw SupabaseError.server("No response from the server.")
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            Log.detail("\(context) failed \(http.statusCode): \(body)")

            if http.statusCode == 401 || http.statusCode == 403 {
                if body.contains("23505") || body.contains("duplicate key") {
                    throw SupabaseError.duplicate
                }
                throw SupabaseError.notPermitted
            }
            if body.contains("23505") || body.contains("duplicate key") {
                throw SupabaseError.duplicate
            }
            if http.statusCode == 429 || body.contains("53400") {
                throw SupabaseError.server("Too many at once. Give it a minute.")
            }

            throw SupabaseError.server("Could not finish \(context) (\(http.statusCode)).")
        }
    }

    struct Empty: Codable {}

    private struct TokenResponse: Decodable {
        struct User: Decodable { let id: String }
        let accessToken: String
        let refreshToken: String
        let expiresIn: Int
        let user: User?
    }
}

enum SupabaseError: LocalizedError {
    case signedOut
    case notPermitted
    case duplicate
    case server(String)

    var errorDescription: String? {
        switch self {
        case .signedOut:
            return "Your session has ended. Sign in again."
        case .notPermitted:
            return "You are not allowed to do that."
        case .duplicate:
            return "That ticket has already been filed."
        case .server(let message):
            return message
        }
    }
}
