package com.tagsnap.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.fragment.app.FragmentActivity
import com.tagsnap.BuildConfig
import com.tagsnap.core.Biometrics
import com.tagsnap.core.Format
import com.tagsnap.core.Settings

/**
 * Who you are, what is stuck, and the way out.
 *
 * Small on purpose. Everything a driver needs day to day is on the other three
 * screens; this is where the two things that occasionally go wrong live — a
 * capture that will not upload, and a phone that needs signing out.
 */
@Composable
fun AccountScreen(state: AppState, onBack: () -> Unit) {

    val context = LocalContext.current
    val settings = remember { Settings(context) }
    val profile by state.profile.collectAsState()
    val pending by state.uploader.pending.collectAsState()

    var biometricsOn by remember { mutableStateOf(settings.biometricsEnabled) }
    var confirmSignOut by remember { mutableStateOf(false) }
    val stuck = remember { state.outbox.stuck() }

    val notificationPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* Declined is fine; the in-app list still shows a rescan. */ }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onBack) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack, "Back",
                    tint = TagSnapColors.text
                )
            }
            Text(
                "Account",
                color = TagSnapColors.text,
                fontSize = 20.sp,
                fontWeight = FontWeight.SemiBold
            )
        }

        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp)
        ) {
            Card {
                Text(
                    profile?.fullName ?: "—",
                    color = TagSnapColors.text,
                    fontSize = 24.sp,
                    fontWeight = FontWeight.Bold
                )
                Row {
                    Text(
                        profile?.role?.label ?: "",
                        color = TagSnapColors.tint(state.payeeType),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                    if (profile?.subhaulerId != null) {
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "· paid to your outfit",
                            color = TagSnapColors.faint,
                            fontSize = 14.sp
                        )
                    }
                }
                profile?.phone?.let {
                    Text(it, color = TagSnapColors.muted, fontSize = 15.sp)
                }
            }

            // Captures that have failed enough times to need a person.
            //
            // Left visible rather than retried forever in silence, because the
            // photo is still on the phone and somebody in the office can be
            // told about it in a phone call. A silent permanent failure is how
            // a load stops being paid for.
            if (stuck.isNotEmpty()) {
                Card {
                    Text(
                        "${stuck.size} will not send",
                        color = TagSnapColors.bad,
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                    stuck.forEach { row ->
                        Column {
                            Text(
                                Format.date(row.capturedAt),
                                color = TagSnapColors.text,
                                fontSize = 14.sp,
                                fontWeight = FontWeight.Medium
                            )
                            Text(
                                row.lastError ?: "Unknown problem.",
                                color = TagSnapColors.muted,
                                fontSize = 13.sp
                            )
                        }
                    }
                    Text(
                        "The photos are still on this phone. Call the office and tell them the date.",
                        color = TagSnapColors.faint,
                        fontSize = 13.sp
                    )
                }
            }

            Card {
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Require unlock", color = TagSnapColors.text, fontSize = 16.sp)
                        Text(
                            "Ask every time the app is reopened.",
                            color = TagSnapColors.faint,
                            fontSize = 13.sp
                        )
                    }
                    Switch(
                        checked = biometricsOn,
                        onCheckedChange = {
                            biometricsOn = it
                            settings.biometricsEnabled = it
                        },
                        enabled = (context as? FragmentActivity)
                            ?.let { Biometrics.isAvailable(it) } ?: false
                    )
                }

                HorizontalDivider(color = TagSnapColors.line)

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    Text(
                        "Turn on notifications so you know when the office needs a ticket retaken.",
                        color = TagSnapColors.muted,
                        fontSize = 14.sp
                    )
                    Button(
                        onClick = {
                            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = TagSnapColors.raised
                        ),
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("Turn on notifications", color = TagSnapColors.text) }
                }

                if (!BuildConfig.HAS_PUSH) {
                    Text(
                        "This build has no push configured, so the office cannot buzz your " +
                            "phone. Check the Tickets tab for anything sent back.",
                        color = TagSnapColors.faint,
                        fontSize = 13.sp
                    )
                }
            }

            Button(
                onClick = { confirmSignOut = true },
                colors = ButtonDefaults.buttonColors(containerColor = TagSnapColors.bad),
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)
            ) { Text("Sign out", color = Color.White, fontSize = 18.sp) }

            if (pending > 0) {
                Text(
                    "$pending still waiting to send. Signing out keeps them on the phone but " +
                        "nothing will upload until you sign back in.",
                    color = TagSnapColors.attention,
                    fontSize = 13.sp
                )
            }

            Text(
                "TagSnap ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                color = TagSnapColors.faint,
                fontSize = 12.sp
            )
        }
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text("Sign out?") },
            text = { Text("Anything already photographed stays on this phone.") },
            confirmButton = {
                TextButton(onClick = { confirmSignOut = false; state.signOut() }) {
                    Text("Sign out", color = TagSnapColors.bad)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmSignOut = false }) { Text("Stay signed in") }
            }
        )
    }
}
