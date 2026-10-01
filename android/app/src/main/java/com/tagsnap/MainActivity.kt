package com.tagsnap

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.ListAlt
import androidx.compose.material.icons.filled.Paid
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.compose.ui.platform.LocalLifecycleOwner
import com.tagsnap.ui.AccountScreen
import com.tagsnap.ui.AppState
import com.tagsnap.ui.CaptureScreen
import com.tagsnap.ui.LockScreen
import com.tagsnap.ui.PayScreen
import com.tagsnap.ui.PortalScreen
import com.tagsnap.ui.SignInScreen
import com.tagsnap.ui.TagDetailScreen
import com.tagsnap.ui.TagSnapColors
import com.tagsnap.ui.TagSnapTheme
import com.tagsnap.ui.TagsScreen
import com.tagsnap.ui.WrongPortalScreen

/**
 * `FragmentActivity` rather than `ComponentActivity`, because `BiometricPrompt`
 * requires one. Everything visible is Compose regardless.
 */
class MainActivity : FragmentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // A tapped notification names a ticket. Read here as well as in the
        // messaging service, because a tap that cold-starts the app arrives as
        // an intent extra rather than as a live callback.
        val launchTagId = intent?.getStringExtra("tagId")

        setContent {
            TagSnapTheme {
                val state: AppState = viewModel()
                LaunchedEffect(launchTagId) {
                    launchTagId?.let { state.openTag(it) }
                }
                Root(state)
            }
        }
    }
}

@Composable
private fun Root(state: AppState) {
    val phase by state.phase.collectAsState()
    val locked by state.locked.collectAsState()

    // Lock on the way out, not on the way in: deciding at the moment the app
    // backgrounds means the lock screen is already in place behind the app
    // switcher thumbnail.
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_STOP -> state.lockIfEnabled()
                // Returning to the foreground is the cheapest moment to drain
                // the outbox: the driver has just pulled out of a pit and has
                // signal again.
                Lifecycle.Event.ON_START -> state.sync()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
    }

    Box(
        Modifier.fillMaxSize().background(TagSnapColors.background),
        contentAlignment = Alignment.Center
    ) {
        when (val p = phase) {
            is AppState.Phase.Starting ->
                CircularProgressIndicator(color = TagSnapColors.driver)

            is AppState.Phase.ChoosingPortal -> PortalScreen(state)

            is AppState.Phase.SigningIn -> SignInScreen(state, p.portal)

            is AppState.Phase.WrongPortal -> WrongPortalScreen(state, p.actual)

            is AppState.Phase.Ready -> MainTabs(state)
        }

        if (locked && phase is AppState.Phase.Ready) {
            LockScreen(state)
        }
    }
}

private enum class Tab(val label: String) {
    CAPTURE("Capture"),
    TICKETS("Tickets"),
    PAY("Pay"),
}

/**
 * Three tabs and no more.
 *
 * A driver opens this app to do one of three things: photograph a ticket, check
 * whether one went through, or see what they are owed. Anything else belongs
 * behind the account screen.
 */
@Composable
private fun MainTabs(state: AppState) {
    var tab by remember { mutableStateOf(Tab.CAPTURE) }
    val navController = rememberNavController()
    val pending by state.uploader.pending.collectAsState()
    val pendingTagId by state.pendingTagId.collectAsState()

    // A tapped notification opens the ticket it is about, not the app's front
    // door. Landing on the capture screen after tapping "retake this ticket" is
    // how a driver ends up filing a second tag for one load, which is the exact
    // duplicate this system exists to prevent.
    LaunchedEffect(pendingTagId) {
        pendingTagId?.let { id ->
            tab = Tab.TICKETS
            navController.navigate("tag/$id")
            state.consumePendingTag()
        }
    }

    Scaffold(
        containerColor = TagSnapColors.background,
        bottomBar = {
            NavigationBar(containerColor = TagSnapColors.surface) {
                Tab.entries.forEach { entry ->
                    NavigationBarItem(
                        selected = tab == entry,
                        onClick = {
                            tab = entry
                            navController.popBackStack("tabs", inclusive = false)
                        },
                        icon = {
                            val icon = when (entry) {
                                Tab.CAPTURE -> Icons.Filled.CameraAlt
                                Tab.TICKETS -> Icons.Filled.ListAlt
                                Tab.PAY -> Icons.Filled.Paid
                            }
                            if (entry == Tab.TICKETS && pending > 0) {
                                BadgedBox(badge = { Badge { Text("$pending") } }) {
                                    Icon(icon, entry.label)
                                }
                            } else {
                                Icon(icon, entry.label)
                            }
                        },
                        label = { Text(entry.label) }
                    )
                }
            }
        }
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = "tabs",
            modifier = Modifier.padding(padding)
        ) {
            composable("tabs") {
                when (tab) {
                    Tab.CAPTURE -> CaptureScreen(state, rescanFor = null, onDone = {})
                    Tab.TICKETS -> TagsScreen(
                        state,
                        onOpen = { navController.navigate("tag/$it") },
                        onAccount = { navController.navigate("account") }
                    )
                    Tab.PAY -> PayScreen(state)
                }
            }
            composable("tag/{id}") { entry ->
                TagDetailScreen(
                    state = state,
                    tagId = entry.arguments?.getString("id").orEmpty(),
                    onBack = { navController.popBackStack() }
                )
            }
            composable("account") {
                AccountScreen(state, onBack = { navController.popBackStack() })
            }
        }
    }
}
