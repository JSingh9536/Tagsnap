package com.tagsnap

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.tagsnap.net.Supabase

class TagSnapApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        Supabase.init(this)
        createChannels()
    }

    /**
     * Two channels, and deliberately only two.
     *
     * `rescans` is high importance because the office is blocked on the driver
     * — that one is allowed to make a noise in a truck cab. `default` carries
     * approvals, which people want but nobody needs interrupting for.
     *
     * Splitting them matters more than it looks: a driver who mutes the app
     * because approvals buzz all afternoon has also muted the one notification
     * the system exists to deliver. Separate channels let them mute the right
     * half.
     */
    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = getSystemService(NotificationManager::class.java)

        manager.createNotificationChannel(
            NotificationChannel(
                "rescans",
                "Ticket sent back",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "The office needs a new photo of a ticket you sent."
            }
        )

        manager.createNotificationChannel(
            NotificationChannel(
                "default",
                "Approvals",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "A ticket you sent was approved."
            }
        )
    }
}
