package com.tagsnap.core

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * The session, kept where a lost phone does not give it away.
 *
 * A refresh token is a long-lived credential for somebody's pay records, so it
 * does not go in plain SharedPreferences — that file is readable from an ADB
 * backup and from any process that gets root. `EncryptedSharedPreferences`
 * wraps it in a key held in the hardware-backed keystore, which is the Android
 * equivalent of what `Keychain.swift` does on iOS.
 *
 * This is threat #2 from `Trucktags/docs/SECURITY.md` — a phone left in a truck
 * cab at a job site — and it is the cheapest one to close properly.
 */
class SecureStore(context: Context) {

    private val prefs: SharedPreferences = try {
        val key = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        EncryptedSharedPreferences.create(
            context,
            "tagsnap.session",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (_: Exception) {
        // A keystore that will not open is almost always a device whose secure
        // hardware was reset — a factory reset, or an OS upgrade that
        // invalidated the key. The right response is to start a fresh session,
        // not to crash on launch and leave the driver with an app that will
        // not open at 5 a.m.
        context.deleteSharedPreferences("tagsnap.session")
        context.getSharedPreferences("tagsnap.session.fallback", Context.MODE_PRIVATE)
            .also { it.edit().clear().apply() }
    }

    var accessToken: String?
        get() = prefs.getString(ACCESS, null)
        set(value) = prefs.edit().putString(ACCESS, value).apply()

    var refreshToken: String?
        get() = prefs.getString(REFRESH, null)
        set(value) = prefs.edit().putString(REFRESH, value).apply()

    var expiresAt: Long
        get() = prefs.getLong(EXPIRES, 0)
        set(value) = prefs.edit().putLong(EXPIRES, value).apply()

    var userId: String?
        get() = prefs.getString(USER, null)
        set(value) = prefs.edit().putString(USER, value).apply()

    fun clear() = prefs.edit().clear().apply()

    private companion object {
        const val ACCESS = "access_token"
        const val REFRESH = "refresh_token"
        const val EXPIRES = "expires_at"
        const val USER = "user_id"
    }
}

/**
 * Everything that is a preference rather than a credential.
 *
 * Plain SharedPreferences on purpose: none of it is sensitive, and putting a
 * boolean behind the keystore buys nothing but a slower launch.
 */
class Settings(context: Context) {

    private val prefs = context.getSharedPreferences("tagsnap.settings", Context.MODE_PRIVATE)

    /** Opt-in, and off by default — see `Biometrics.kt` for why. */
    var biometricsEnabled: Boolean
        get() = prefs.getBoolean("biometrics", false)
        set(value) = prefs.edit().putBoolean("biometrics", value).apply()

    /** Which door was picked last, so a returning driver skips a screen. */
    var lastPortal: String?
        get() = prefs.getString("portal", null)
        set(value) = prefs.edit().putString("portal", value).apply()
}
