package com.tagsnap.core

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.fragment.app.FragmentActivity
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * A fingerprint, a face, or the screen lock in front of the app.
 *
 * This is threat #2 from `Trucktags/docs/SECURITY.md`: a phone left in a truck
 * cab, or borrowed by whoever is next in the yard. It is opt-in and off by
 * default, because forcing it on a driver whose hands are filthy at 5 a.m. gets
 * the app deleted rather than making anything safer.
 *
 * What it protects is modest and worth being honest about: it stops casual
 * access to somebody's pay history and stops a borrowed phone filing a ticket
 * under their name. It does not protect against a determined attacker with the
 * handset — and the real control there is that a driver cannot edit a submitted
 * tag and cannot approve anything.
 */
object Biometrics {

    /**
     * `BIOMETRIC_WEAK or DEVICE_CREDENTIAL`, not strong-only.
     *
     * A driver in a dust mask and safety glasses will fail face unlock all
     * morning, and one who has just been handling aggregate will fail a
     * fingerprint. The PIN fallback is what makes this usable rather than
     * something people turn off on day two.
     */
    private const val ALLOWED =
        BiometricManager.Authenticators.BIOMETRIC_WEAK or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL

    fun isAvailable(activity: FragmentActivity): Boolean =
        BiometricManager.from(activity).canAuthenticate(ALLOWED) ==
            BiometricManager.BIOMETRIC_SUCCESS

    suspend fun authenticate(activity: FragmentActivity, reason: String): Boolean =
        suspendCancellableCoroutine { continuation ->
            val prompt = BiometricPrompt(
                activity,
                androidx.core.content.ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(
                        result: BiometricPrompt.AuthenticationResult
                    ) {
                        if (continuation.isActive) continuation.resume(true)
                    }

                    override fun onAuthenticationError(code: Int, message: CharSequence) {
                        if (continuation.isActive) continuation.resume(false)
                    }

                    // Deliberately not resuming on failure: a single bad
                    // fingerprint should let them try again, not dismiss the
                    // prompt and make them press the button a second time.
                }
            )

            prompt.authenticate(
                BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Unlock TagSnap")
                    .setSubtitle(reason)
                    .setAllowedAuthenticators(ALLOWED)
                    .build()
            )
        }
}
