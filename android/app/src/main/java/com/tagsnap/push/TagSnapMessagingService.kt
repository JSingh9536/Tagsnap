package com.tagsnap.push

import android.app.PendingIntent
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.tagsnap.MainActivity
import com.tagsnap.R
import com.tagsnap.net.Api
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Push, delivered by FCM and sent by `supabase/functions/push-rescan`.
 *
 * Two notifications, and deliberately only two:
 *
 *   * a rescan request, because the office is now blocked on this person
 *   * an approval, because it is the one people actually want
 *
 * A notification for every status change trains people to swipe them away, and
 * then the rescan gets swiped away too.
 *
 * FCM is free at any volume this system will reach. It is the only delivery
 * path to a Play-services device, which is why Firebase appears on Android and
 * nowhere in the iOS target — that one talks to APNs directly.
 */
class TagSnapMessagingService : FirebaseMessagingService() {

    /**
     * FCM can reissue a token at any time — a restore, a reinstall, a data
     * clear. Registering it again is a plain upsert, so this is safe to call as
     * often as it fires.
     */
    override fun onNewToken(token: String) {
        CoroutineScope(Dispatchers.IO).launch {
            runCatching { Api.registerDevice(token) }
                .onFailure { Log.w(TAG, "could not register token: ${it.message}") }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val notification = message.notification
        val tagId = message.data["tagId"]
        val kind = message.data["kind"] ?: "default"

        val channel = if (kind == "rescan") "rescans" else "default"

        // A tap opens the ticket it is about, not the app's front door. Landing
        // on the capture screen after tapping "retake this ticket" is how a
        // driver ends up filing a second tag for one load.
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("tagId", tagId)
        }

        val pending = PendingIntent.getActivity(
            this,
            tagId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val built = NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notification?.title ?: "TagSnap")
            .setContentText(notification?.body ?: "")
            .setStyle(NotificationCompat.BigTextStyle().bigText(notification?.body ?: ""))
            .setPriority(
                if (kind == "rescan") NotificationCompat.PRIORITY_HIGH
                else NotificationCompat.PRIORITY_DEFAULT
            )
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()

        runCatching {
            NotificationManagerCompat.from(this)
                .notify(tagId?.hashCode() ?: 1, built)
        }.onFailure {
            // POST_NOTIFICATIONS not granted on Android 13+. Nothing to do —
            // the ticket list still shows the rescan, which is why that screen
            // pins them to the top.
            Log.i(TAG, "notification not shown: ${it.message}")
        }
    }

    companion object {
        private const val TAG = "TagSnap/push"

        /**
         * Fetch and register the current token.
         *
         * Called after sign-in rather than at launch, because a token
         * registered against no profile is a token nothing can ever deliver to.
         */
        fun register() {
            runCatching {
                FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                    CoroutineScope(Dispatchers.IO).launch {
                        runCatching { Api.registerDevice(token) }
                    }
                }
            }.onFailure {
                // No google-services.json in this build. Expected, and stated
                // on the account screen rather than failing silently.
                Log.i(TAG, "push is not configured in this build")
            }
        }
    }
}
