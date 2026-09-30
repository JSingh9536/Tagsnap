import Foundation

/// Reads for the field app.
///
/// Every one of these is scoped by Row Level Security rather than by a filter
/// written here — a driver gets their own tags and a subhauler gets their
/// outfit's because `002_rls.sql` says so, not because this file remembered.
/// That is deliberate: a forgotten filter here would be a cosmetic bug, a
/// forgotten policy would be a data leak, and there is no way to forget a
/// policy.
enum API {

    /// The joins a phone screen needs, in one round trip.
    ///
    /// The submitter is deliberately not selected: a driver has no business
    /// enumerating who else files tickets, and the policy on `profiles` would
    /// refuse the join anyway.
    private static let tagSelect = """
    *,\
    tag_images(*),\
    rescan_requests(*),\
    quarries(id,name),\
    materials(id,name,code),\
    jobs(id,name,number),\
    trucks(id,number,legal_capacity_tons,avg_tare_tons),\
    subhaulers(id,name)
    """

    static func myTags(limit: Int = 100) async throws -> [Tag] {
        try await Supabase.shared.select(
            "tags",
            query: "select=\(encoded(tagSelect))&order=created_at.desc&limit=\(limit)"
        )
    }

    static func tag(id: String) async throws -> Tag? {
        let rows: [Tag] = try await Supabase.shared.select(
            "tags",
            query: "select=\(encoded(tagSelect))&id=eq.\(id)&limit=1"
        )
        return rows.first
    }

    /// Tags the office has sent back.
    ///
    /// The one query worth polling, because it is the only state where the
    /// field crew is blocking somebody else.
    static func rescans() async throws -> [Tag] {
        try await Supabase.shared.select(
            "tags",
            query: "select=\(encoded(tagSelect))&status=eq.rescan_requested&order=created_at.desc"
        )
    }

    static func invoices() async throws -> [Invoice] {
        try await Supabase.shared.select(
            "invoices",
            query: "select=*&order=period_start.desc&limit=24"
        )
    }

    /// Which quarry the phone is standing in, if any.
    ///
    /// Free signal the old pipeline never used: every capture already records
    /// its coordinates and every quarry already has a location on file. When
    /// the printed vendor name does not resolve, this does — and it is
    /// recorded as a `gps` verification so a reviewer can see why.
    static func quarriesNearby(lat: Double, lng: Double) async throws -> [NearbyQuarry] {
        try await Supabase.shared.rpc(
            "quarry_at",
            args: ["p_lat": lat, "p_lng": lng, "p_max_metres": 750]
        )
    }

    /// Register this handset for push. Idempotent; called on every launch,
    /// because a token can be reissued by the system at any time.
    static func registerDevice(token: String) async throws {
        guard let userId = await Supabase.shared.currentUserId else { return }
        try await Supabase.shared.insert(
            "device_tokens",
            values: [
                "profile_id": userId,
                "token": token,
                "platform": "ios",
                "last_seen": ISO8601DateFormatter().string(from: Date()),
                "active": true,
            ],
            upsert: true
        )
    }

    private static func encoded(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: "\n", with: "")
            .addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? raw
    }
}
