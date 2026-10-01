package com.tagsnap.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.DocumentScanner
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tagsnap.core.Format
import com.tagsnap.net.Api
import com.tagsnap.net.SupabaseException
import com.tagsnap.net.Tag
import com.tagsnap.net.TagStatus
import kotlinx.coroutines.launch

/**
 * Every ticket this person has filed, newest first, with anything the office is
 * waiting on pinned to the top.
 *
 * Read-only by design. A submitter who can edit their own tonnage after the
 * fact is threat #1 in `Trucktags/docs/SECURITY.md`, and the RLS policy would
 * refuse the write anyway — but the screen should not offer it either, or
 * somebody will spend a morning trying.
 */
@Composable
fun TagsScreen(state: AppState, onOpen: (String) -> Unit, onAccount: () -> Unit) {

    val scope = rememberCoroutineScope()
    val pending by state.uploader.pending.collectAsState()
    val syncing by state.uploader.syncing.collectAsState()

    var tags by remember { mutableStateOf<List<Tag>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        error = null
        try {
            tags = Api.myTags()
        } catch (_: SupabaseException.SignedOut) {
            state.signOut()
        } catch (e: Exception) {
            // A failed refresh in a dead zone is normal, not an incident. Keep
            // whatever is already on screen and say so quietly.
            error = "Could not refresh. Showing what was last loaded."
        }
        loading = false
    }

    LaunchedEffect(Unit) { load() }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                "Tickets",
                color = TagSnapColors.text,
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f)
            )
            IconButton(onClick = onAccount) {
                Icon(Icons.Filled.AccountCircle, "Account", tint = TagSnapColors.muted)
            }
        }

        when {
            loading && tags.isEmpty() ->
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = TagSnapColors.driver)
                }

            tags.isEmpty() && pending == 0 -> Empty()

            else -> LazyColumn(
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    horizontal = 20.dp, vertical = 8.dp
                ),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                if (pending > 0) {
                    item {
                        // Shown as one line rather than as individual rows: a
                        // driver who took eight tickets in a dead zone wants to
                        // know that eight are safe, not to scroll through eight
                        // identical grey placeholders.
                        Card {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    if (syncing) Icons.Filled.CloudUpload else Icons.Filled.WifiOff,
                                    null,
                                    tint = TagSnapColors.driver,
                                    modifier = Modifier.size(22.dp)
                                )
                                Spacer(Modifier.width(12.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        "$pending on this phone",
                                        color = TagSnapColors.text,
                                        fontSize = 17.sp,
                                        fontWeight = FontWeight.SemiBold
                                    )
                                    Text(
                                        if (syncing) "Sending…"
                                        else "Saved. They go up when you have signal.",
                                        color = TagSnapColors.muted,
                                        fontSize = 14.sp
                                    )
                                }
                                if (!syncing) {
                                    TextButton(onClick = {
                                        scope.launch { state.uploader.sync(); load() }
                                    }) {
                                        Text("Send", color = TagSnapColors.driver)
                                    }
                                }
                            }
                        }
                    }
                }

                val rescans = tags.filter { it.status == TagStatus.RESCAN_REQUESTED }
                val rest = tags.filter { it.status != TagStatus.RESCAN_REQUESTED }

                if (rescans.isNotEmpty()) {
                    item { SectionHeader("Waiting on you") }
                    items(rescans, key = { it.id }) { TagRow(it) { onOpen(it.id) } }
                }
                if (rest.isNotEmpty()) {
                    item { SectionHeader("Filed") }
                    items(rest, key = { it.id }) { TagRow(it) { onOpen(it.id) } }
                }

                error?.let { message ->
                    item { Text(message, color = TagSnapColors.bad, fontSize = 14.sp) }
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(
        title,
        color = TagSnapColors.faint,
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 8.dp)
    )
}

@Composable
private fun TagRow(tag: Tag, onClick: () -> Unit) {
    Card(Modifier.clickable(onClick = onClick)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    tag.ticketNumber?.let { "Ticket #$it" } ?: "No ticket number yet",
                    color = TagSnapColors.text,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    buildString {
                        append(Format.date(tag.tagDate ?: tag.createdAt))
                        tag.quarries?.name?.let { append(" · $it") }
                    },
                    color = TagSnapColors.muted,
                    fontSize = 14.sp
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                StatusPill(tag.status)
                Spacer(Modifier.height(6.dp))
                Text(
                    Format.tons(tag.netTons),
                    color = TagSnapColors.muted,
                    fontSize = 15.sp,
                    fontFamily = FontFamily.Monospace
                )
            }
        }
    }
}

@Composable
private fun Empty() {
    Column(
        Modifier.fillMaxSize().padding(40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(
            Icons.Filled.DocumentScanner, null,
            tint = TagSnapColors.faint,
            modifier = Modifier.size(44.dp)
        )
        Spacer(Modifier.height(12.dp))
        Text(
            "Nothing here yet",
            color = TagSnapColors.text,
            fontSize = 20.sp,
            fontWeight = FontWeight.SemiBold
        )
        Text(
            "Photograph a ticket on the Capture tab and it will show up here.",
            color = TagSnapColors.muted,
            fontSize = 15.sp
        )
    }
}
