package com.tagsnap.net

import org.json.JSONObject

/**
 * Reads for the field app.
 *
 * Every one of these is scoped by Row Level Security rather than by a filter
 * written here — a driver gets their own tags and a subhauler gets their
 * outfit's because `002_rls.sql` says so, not because this file remembered.
 * That is deliberate: a forgotten filter here would be a cosmetic bug, a
 * forgotten policy would be a data leak, and there is no way to forget a
 * policy.
 */
object Api {

    /**
     * The joins a phone screen needs, in one round trip.
     *
     * The submitter is deliberately not selected: a driver has no business
     * enumerating who else files tickets, and the policy on `profiles` would
     * refuse the join anyway.
     */
    private const val TAG_SELECT =
        "*,tag_images(*),rescan_requests(*),quarries(id,name)," +
            "materials(id,name,code),jobs(id,name,number)," +
            "trucks(id,number,legal_capacity_tons,avg_tare_tons),subhaulers(id,name)"

    suspend fun myProfile(): Profile {
        val id = Supabase.currentUserId ?: throw SupabaseException.SignedOut
        return Supabase.select<Profile>("profiles", "select=*&id=eq.$id&limit=1")
            .firstOrNull() ?: throw SupabaseException.SignedOut
    }

    suspend fun myTags(limit: Int = 100): List<Tag> =
        Supabase.select("tags", "select=$TAG_SELECT&order=created_at.desc&limit=$limit")

    suspend fun tag(id: String): Tag? =
        Supabase.select<Tag>("tags", "select=$TAG_SELECT&id=eq.$id&limit=1").firstOrNull()

    /**
     * Tags the office has sent back.
     *
     * The one query worth polling, because it is the only state where the field
     * crew is blocking somebody else.
     */
    suspend fun rescans(): List<Tag> =
        Supabase.select(
            "tags",
            "select=$TAG_SELECT&status=eq.rescan_requested&order=created_at.desc"
        )

    suspend fun invoices(): List<Invoice> =
        Supabase.select("invoices", "select=*&order=period_start.desc&limit=24")

    /**
     * Which quarry the phone is standing in, if any.
     *
     * Free signal the old pipeline never used: every capture already records
     * its coordinates and every quarry already has a location on file. When the
     * printed vendor name does not resolve, this does — and it is recorded as a
     * `gps` verification so a reviewer can see why.
     */
    suspend fun quarriesNearby(lat: Double, lng: Double): List<NearbyQuarry> =
        Supabase.rpcAs(
            "quarry_at",
            JSONObject().put("p_lat", lat).put("p_lng", lng).put("p_max_metres", 750)
        )

    /**
     * Register this handset for push. Idempotent; called on every launch,
     * because FCM can reissue a token at any time.
     */
    suspend fun registerDevice(token: String) {
        val id = Supabase.currentUserId ?: return
        Supabase.insert(
            "device_tokens",
            JSONObject()
                .put("profile_id", id)
                .put("token", token)
                .put("platform", "android")
                .put("active", true),
            upsert = true
        )
    }
}
