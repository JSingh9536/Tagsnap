package com.tagsnap.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Undo
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tagsnap.core.Format
import com.tagsnap.net.Api
import com.tagsnap.net.ExtractionEngine
import com.tagsnap.net.Supabase
import com.tagsnap.net.Tag
import com.tagsnap.net.TagStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.URL

/**
 * One ticket, as filed.
 *
 * Deliberately flat: the photo, what was read off it, where it is in the
 * process, and — if the office has sent it back — one button that opens the
 * camera with the reason printed across it.
 *
 * Nothing here is editable. The values shown are what the office is looking at,
 * and if they are wrong the fix is a correction on the review screen by
 * somebody who is not the person being paid for the load.
 */
@Composable
fun TagDetailScreen(state: AppState, tagId: String, onBack: () -> Unit) {

    var tag by remember { mutableStateOf<Tag?>(null) }
    var photo by remember { mutableStateOf<Bitmap?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var retaking by remember { mutableStateOf(false) }

    LaunchedEffect(tagId) {
        try {
            val fetched = Api.tag(tagId)
            tag = fetched
            fetched?.currentImage?.imagePath?.let { path ->
                photo = runCatching {
                    val url = Supabase.signedImageUrl(path)
                    withContext(Dispatchers.IO) {
                        URL(url).openStream().use { BitmapFactory.decodeStream(it) }
                    }
                }.getOrNull()
            }
        } catch (e: Exception) {
            error = e.message ?: "Could not load that ticket."
        }
        loading = false
    }

    val current = tag

    if (retaking && current != null) {
        CaptureScreen(state, rescanFor = current, onDone = { retaking = false })
        return
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onBack) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack, "Back",
                    tint = TagSnapColors.text
                )
            }
            Text(
                current?.ticketNumber?.let { "#$it" } ?: "Ticket",
                color = TagSnapColors.text,
                fontSize = 20.sp,
                fontWeight = FontWeight.SemiBold
            )
        }

        when {
            loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = TagSnapColors.driver)
            }

            current == null -> Text(
                error ?: "That ticket could not be loaded.",
                color = TagSnapColors.bad,
                modifier = Modifier.padding(20.dp)
            )

            else -> Column(
                Modifier
                    .verticalScroll(rememberScrollState())
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp)
            ) {
                current.openRescan?.let { rescan ->
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .background(
                                TagSnapColors.attention.copy(alpha = 0.12f),
                                RoundedCornerShape(12.dp)
                            )
                            .border(
                                1.dp,
                                TagSnapColors.attention.copy(alpha = 0.4f),
                                RoundedCornerShape(12.dp)
                            )
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Filled.Undo, null,
                                tint = TagSnapColors.attention,
                                modifier = Modifier.size(18.dp)
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "Retake this one",
                                color = TagSnapColors.attention,
                                fontSize = 15.sp,
                                fontWeight = FontWeight.SemiBold
                            )
                        }
                        Text(
                            rescan.reason.label,
                            color = TagSnapColors.text,
                            fontSize = 22.sp,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            rescan.note ?: rescan.reason.instruction,
                            color = TagSnapColors.muted,
                            fontSize = 17.sp
                        )
                        Button(
                            onClick = { retaking = true },
                            colors = ButtonDefaults.buttonColors(
                                containerColor = TagSnapColors.attention
                            ),
                            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)
                        ) {
                            Text("Open the camera", color = Color.Black, fontSize = 18.sp)
                        }
                    }
                }

                val bitmap = photo
                if (bitmap != null) {
                    Image(
                        bitmap = bitmap.asImageBitmap(),
                        contentDescription = "The ticket photo",
                        contentScale = ContentScale.FillWidth,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(TagSnapColors.surface, RoundedCornerShape(12.dp))
                    )
                } else {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(180.dp)
                            .background(TagSnapColors.surface, RoundedCornerShape(12.dp)),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            "The photo has not reached the office yet",
                            color = TagSnapColors.faint,
                            fontSize = 14.sp
                        )
                    }
                }

                Card {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        StatusPill(current.status)
                        Text(
                            current.payeeType.ledgerLabel,
                            color = TagSnapColors.faint,
                            fontSize = 13.sp
                        )
                    }
                    Text(explain(current), color = TagSnapColors.muted, fontSize = 15.sp)
                }

                Card {
                    Text(
                        "What was read",
                        color = TagSnapColors.faint,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                    DetailRow("Ticket", current.ticketNumber ?: "—")
                    DetailRow("Date", Format.date(current.tagDate))
                    DetailRow("Quarry", current.quarries?.name ?: "—")
                    DetailRow("Material", current.materials?.name ?: "—")
                    DetailRow("Job", current.jobs?.name ?: "—")
                    DetailRow("Truck", current.trucks?.number ?: "—")

                    HorizontalDivider(color = TagSnapColors.line)

                    DetailRow("Gross", Format.tons(current.grossTons))
                    DetailRow("Tare", Format.tons(current.tareTons))
                    DetailRow("Net", Format.tons(current.netTons), emphasised = true)

                    current.engine?.let {
                        Text(readBy(it, current.ocrMs), color = TagSnapColors.faint, fontSize = 12.sp)
                    }
                }

                if (current.status == TagStatus.APPROVED || current.status == TagStatus.INVOICED) {
                    Card {
                        Text(
                            "Approved",
                            color = TagSnapColors.faint,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                        Text(
                            Format.cents(current.computedPayCents),
                            color = TagSnapColors.good,
                            fontSize = 34.sp,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            if (current.status == TagStatus.INVOICED) "On your invoice."
                            else "Frozen. It will land on your next invoice.",
                            color = TagSnapColors.muted,
                            fontSize = 14.sp
                        )
                    }
                }

                current.reviewNotes?.takeIf { it.isNotBlank() }?.let { notes ->
                    Card {
                        Text(
                            "From the office",
                            color = TagSnapColors.faint,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                        Text(notes, color = TagSnapColors.text, fontSize = 16.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String, emphasised: Boolean = false) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = TagSnapColors.muted, fontSize = 15.sp)
        Text(
            value,
            color = TagSnapColors.text,
            fontSize = if (emphasised) 20.sp else 16.sp,
            fontWeight = if (emphasised) FontWeight.Bold else FontWeight.Normal,
            fontFamily = FontFamily.Monospace
        )
    }
}

/** What the status means for this person, in their terms. */
private fun explain(tag: Tag): String = when (tag.status) {
    TagStatus.QUEUED -> "Saved on your phone. It goes up when you have signal."
    TagStatus.UPLOADED -> "The office has your photo. Nothing has read it yet."
    TagStatus.EXTRACTED -> "Being checked."
    TagStatus.NEEDS_REVIEW -> "The office is looking at this one."
    TagStatus.READY -> "Waiting for someone in the office to approve it."
    TagStatus.RESCAN_REQUESTED -> "The office needs a new photo of this ticket."
    TagStatus.APPROVED -> "Approved and frozen. Nothing changes it from here."
    TagStatus.INVOICED -> "On an invoice."
    TagStatus.REJECTED -> tag.rejectedReason?.let { "Rejected: $it" } ?: "Rejected."
}

private fun readBy(engine: ExtractionEngine, ms: Int?): String {
    val who = when (engine) {
        ExtractionEngine.MLKIT -> "Read on your phone"
        ExtractionEngine.APPLE_VISION -> "Read on the phone"
        ExtractionEngine.TESSERACT -> "Read in the office"
        ExtractionEngine.OFFICE_MANUAL -> "Typed in by the office"
        ExtractionEngine.QUARRY_FEED -> "Sent by the quarry"
    }
    return if (ms != null && ms > 0) "$who, $ms ms" else who
}
