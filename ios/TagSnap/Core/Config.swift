import Foundation

/// Where this build points and what it is allowed to say about itself.
///
/// Values come from the Info.plist, which XcodeGen fills from `ios/Config.xcconfig`
/// — see `ios/README.md`. Nothing here is a secret. The anon key is published
/// by design: it identifies the project and grants nothing on its own, because
/// every table in `002_rls.sql` refuses a request that a policy does not allow.
/// Assume this key is extracted from the IPA on day one, because it will be.
///
/// The key that would matter — the service role key — exists only in the edge
/// function environment and appears nowhere in this target.
enum Config {

    static let supabaseURL: URL = {
        guard
            let raw = Bundle.main.object(forInfoDictionaryKey: "SUPABASE_URL") as? String,
            let url = URL(string: raw.trimmingCharacters(in: .whitespaces)),
            url.scheme?.hasPrefix("http") == true
        else {
            // A build with no backend is not a build worth shipping, and a
            // silent fallback to a placeholder host would produce a support
            // ticket about "sign-in not working" instead of a build failure.
            fatalError("SUPABASE_URL is missing or malformed. See ios/README.md.")
        }
        return url
    }()

    static let anonKey: String = {
        guard
            let key = Bundle.main.object(forInfoDictionaryKey: "SUPABASE_ANON_KEY") as? String,
            key.isEmpty == false
        else {
            fatalError("SUPABASE_ANON_KEY is missing. See ios/README.md.")
        }
        return key.trimmingCharacters(in: .whitespaces)
    }()

    static var restURL: URL { supabaseURL.appendingPathComponent("rest/v1") }
    static var authURL: URL { supabaseURL.appendingPathComponent("auth/v1") }
    static var storageURL: URL { supabaseURL.appendingPathComponent("storage/v1") }
    static var functionsURL: URL { supabaseURL.appendingPathComponent("functions/v1") }

    static let imageBucket = "tag-images"

    /// Shown on the account screen so a bug report identifies a real build.
    static var versionString: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }

    /// Longest side a photo is resized to before upload.
    ///
    /// 2000px keeps dot-matrix print legible to both Vision and a human on the
    /// review screen, at roughly 400 KB a ticket. Storage is now the only
    /// per-ticket cost in the whole system, so this number is the cost dial:
    /// 500 tickets a month is about 200 MB, which fits inside Supabase's free
    /// tier for the first several months of a pilot.
    static let maxImageDimension: CGFloat = 2000

    static let jpegQuality: CGFloat = 0.82
}
