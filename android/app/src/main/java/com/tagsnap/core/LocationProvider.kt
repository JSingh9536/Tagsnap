package com.tagsnap.core

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.tagsnap.net.Api
import com.tagsnap.net.NearbyQuarry
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Where a photo was taken.
 *
 * Two uses, both of them free:
 *
 *   * `app.quarry_near_capture()` resolves the vendor when the printed name on
 *     the ticket does not match anything on file — common with a new quarry,
 *     and it used to mean a reviewer typing it in by hand.
 *   * a coordinate on the ticket is the beginning of the dispatch/GPS
 *     cross-verification in `INGESTION.md` tier 3, which is the eventual route
 *     to approving a clean load without anyone looking at it.
 *
 * Coarse location, foreground only, and nothing is tracked in the background.
 * The app wants to know where one photograph was taken, not where a driver has
 * been all day, and the distinction is worth keeping — the second is a
 * surveillance system, would have to be disclosed as one, and buys nothing.
 */
class LocationProvider(private val context: Context) {

    private val client = LocationServices.getFusedLocationProviderClient(context)

    data class Fix(val lat: Double, val lng: Double)

    val hasPermission: Boolean
        get() = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

    /**
     * One fix, now.
     *
     * `BALANCED_POWER_ACCURACY` is plenty: this is deciding which quarry, not
     * where in the yard, and the coarser setting is dramatically cheaper on
     * battery for a phone that is on a windscreen mount all day.
     */
    @SuppressLint("MissingPermission")
    suspend fun current(): Fix? {
        if (!hasPermission) return null

        return suspendCancellableCoroutine { continuation ->
            client.getCurrentLocation(Priority.PRIORITY_BALANCED_POWER_ACCURACY, null)
                .addOnSuccessListener { location ->
                    continuation.resume(
                        location?.let { Fix(it.latitude, it.longitude) }
                    )
                }
                .addOnFailureListener {
                    // Not worth telling a driver about. A capture with no
                    // coordinates is a perfectly good capture; it just loses
                    // one free resolution signal.
                    continuation.resume(null)
                }
        }
    }

    /** Which quarry the phone appears to be standing in, if the server knows. */
    suspend fun nearbyQuarry(fix: Fix): NearbyQuarry? =
        runCatching { Api.quarriesNearby(fix.lat, fix.lng).firstOrNull() }.getOrNull()
}
