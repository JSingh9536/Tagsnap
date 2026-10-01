package com.tagsnap.ui

import android.Manifest
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Undo
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import com.tagsnap.core.Format
import com.tagsnap.core.LocationProvider
import com.tagsnap.net.NearbyQuarry
import com.tagsnap.net.Tag
import com.tagsnap.ocr.PerceptualHash
import com.tagsnap.ocr.ScaleTicketParser
import com.tagsnap.ocr.TextRecognizer
import com.tagsnap.store.Outbox
import com.tagsnap.store.Uploader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/**
 * The screen the app exists for.
 *
 * One button. Everything after the shutter happens without asking:
 *
 *   1. straighten and shrink the image
 *   2. write the JPEG to disk
 *   3. read it with ML Kit — **on the device, with no network**
 *   4. fingerprint it
 *   5. queue it
 *
 * The whole sequence takes under a second and none of it needs a signal. That
 * last point is the difference the on-device reader made: a driver in a pit
 * with no bars now learns immediately that their photo was unreadable, while
 * retaking it is free. Under the old server-side reader they found out hours
 * later, from an office phone call, having long since left the quarry.
 */
@Composable
fun CaptureScreen(state: AppState, rescanFor: Tag?, onDone: () -> Unit) {

    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val tint = TagSnapColors.tint(state.payeeType)
    val pending by state.uploader.pending.collectAsState()

    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<CaptureResult?>(null) }
    var quarry by remember { mutableStateOf<NearbyQuarry?>(null) }

    val location = remember { LocationProvider(context) }

    val locationPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* Declined is fine. A capture with no coordinates is still a capture. */ }

    LaunchedEffect(Unit) {
        if (!location.hasPermission) {
            locationPermission.launch(Manifest.permission.ACCESS_COARSE_LOCATION)
        } else {
            location.current()?.let { quarry = location.nearbyQuarry(it) }
        }
    }

    /**
     * ML Kit's document scanner.
     *
     * This is the second half of the "imaging costs nothing" answer, and it is
     * worth more to accuracy than any amount of parser tuning. It finds the
     * edges of the paper, corrects the perspective, crops away the truck seat
     * and the dashboard, and boosts contrast on a faded carbon copy — before
     * the recogniser ever sees it. It ships with Play services, and it is the
     * same component Google Drive uses to scan documents.
     *
     * A ticket photographed at an angle across a lap, run through this, reads
     * like a flatbed scan. The same photo from a plain camera intent reads like
     * a photo taken at an angle across a lap.
     */
    val scannerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult()
    ) { activityResult ->
        if (activityResult.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult

        val scan = GmsDocumentScanningResult.fromActivityResultIntent(activityResult.data)
        val uri = scan?.pages?.firstOrNull()?.imageUri ?: return@rememberLauncherForActivityResult

        scope.launch {
            working = true
            error = null
            try {
                result = handleCapture(
                    context = context,
                    uri = uri,
                    state = state,
                    rescanFor = rescanFor,
                    location = location,
                )
                state.uploader.refreshCount()
                Uploader.schedule(context)
                if (rescanFor != null) onDone()
            } catch (e: Exception) {
                error = e.message ?: "That photo could not be saved. Take it again."
            }
            working = false
        }
    }

    fun openScanner() {
        val options = GmsDocumentScannerOptions.Builder()
            // One ticket is one tag. A two-page scan would mean two loads on
            // one record, which is exactly the ambiguity the duplicate controls
            // exist to avoid.
            .setPageLimit(1)
            .setGalleryImportAllowed(false)
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
            // FULL gives the edge-detection and cleanup UI. BASE is a plain
            // camera with a crop box, which throws away the reason for using
            // this at all.
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .build()

        GmsDocumentScanning.getClient(options)
            .getStartScanIntent(context as Activity)
            .addOnSuccessListener { sender ->
                scannerLauncher.launch(IntentSenderRequest.Builder(sender).build())
            }
            .addOnFailureListener {
                error = "The scanner could not start. Check for a Play services update."
            }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp)
    ) {
        if (rescanFor != null) RescanBanner(rescanFor) else Header(state, tint, quarry)

        val current = result
        if (current != null) {
            ReadingSummary(current) { result = null }
        } else {
            Button(
                onClick = { openScanner() },
                enabled = !working,
                colors = ButtonDefaults.buttonColors(containerColor = tint),
                shape = RoundedCornerShape(20.dp),
                modifier = Modifier.fillMaxWidth().height(190.dp)
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Filled.CameraAlt, null, tint = Color.Black, modifier = Modifier.size(44.dp))
                    Spacer(Modifier.height(12.dp))
                    Text(
                        if (rescanFor == null) "Take the photo" else "Retake it",
                        color = Color.Black,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }

            if (working) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(
                        color = TagSnapColors.muted,
                        modifier = Modifier.size(20.dp)
                    )
                    Spacer(Modifier.width(10.dp))
                    Text("Reading it…", color = TagSnapColors.muted, fontSize = 15.sp)
                }
            } else {
                Text(
                    "Hold the ticket flat. It shoots itself once all four corners are in frame.",
                    color = TagSnapColors.faint,
                    fontSize = 14.sp
                )
            }
        }

        error?.let { Text(it, color = TagSnapColors.bad, fontSize = 15.sp) }

        if (pending > 0) {
            Card {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Filled.CloudUpload, null,
                        tint = TagSnapColors.driver,
                        modifier = Modifier.size(22.dp)
                    )
                    Spacer(Modifier.width(10.dp))
                    Column {
                        Text(
                            "$pending waiting to send",
                            color = TagSnapColors.text,
                            fontSize = 16.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                        Text(
                            "They are saved on this phone. They go up on their own when you have signal.",
                            color = TagSnapColors.muted,
                            fontSize = 14.sp
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Header(state: AppState, tint: Color, quarry: NearbyQuarry?) {
    Column {
        Text(
            "Photograph a ticket",
            color = TagSnapColors.text,
            fontSize = 30.sp,
            fontWeight = FontWeight.Bold
        )
        Text(state.payeeType.ledgerLabel, color = tint, fontSize = 15.sp, fontWeight = FontWeight.Medium)

        if (quarry != null) {
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.LocationOn, null,
                    tint = TagSnapColors.muted,
                    modifier = Modifier.size(16.dp)
                )
                Spacer(Modifier.width(6.dp))
                // Not a claim about the ticket — a claim about where the phone
                // is. Shown because it is reassuring, and because it is the
                // signal that resolves the vendor when the printed name does
                // not match anything on file.
                Text(
                    "Looks like you are at ${quarry.name}",
                    color = TagSnapColors.muted,
                    fontSize = 14.sp
                )
            }
        }
    }
}

@Composable
private fun RescanBanner(tag: Tag) {
    val rescan = tag.openRescan
    Column(
        Modifier
            .fillMaxWidth()
            .background(TagSnapColors.attention.copy(alpha = 0.12f), RoundedCornerShape(12.dp))
            .border(1.dp, TagSnapColors.attention.copy(alpha = 0.4f), RoundedCornerShape(12.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Filled.Undo, null,
                tint = TagSnapColors.attention,
                modifier = Modifier.size(18.dp)
            )
            Spacer(Modifier.width(8.dp))
            Text(
                "The office sent this back",
                color = TagSnapColors.attention,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold
            )
        }

        if (rescan != null) {
            Text(
                rescan.reason.label,
                color = TagSnapColors.text,
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold
            )
            // The instruction, not the fault. This is what someone reads while
            // holding a phone in one hand and a ticket in the other.
            Text(
                rescan.note ?: rescan.reason.instruction,
                color = TagSnapColors.muted,
                fontSize = 17.sp
            )
        }

        tag.ticketNumber?.let {
            Text("Ticket #$it", color = TagSnapColors.faint, fontSize = 14.sp)
        }
    }
}

data class CaptureResult(
    val parsed: ScaleTicketParser.Output?,
    val readable: Boolean,
)

/**
 * What the phone read, shown for a moment before the driver moves on.
 *
 * The point is not to ask them to check it — a driver is not the reviewer, and
 * asking them to confirm a tonnage they are paid on is the wrong person to ask.
 * The point is that "we could not read this one" arrives now, while the ticket
 * is still in their hand, rather than tonight from the office.
 */
@Composable
private fun ReadingSummary(result: CaptureResult, onNext: () -> Unit) {
    Card {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                if (result.readable) Icons.Filled.CheckCircle else Icons.Filled.Warning,
                null,
                tint = if (result.readable) TagSnapColors.good else TagSnapColors.attention,
                modifier = Modifier.size(28.dp)
            )
            Spacer(Modifier.width(12.dp))
            Column {
                Text(
                    if (result.readable) "Saved" else "Saved, but hard to read",
                    color = TagSnapColors.text,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    if (result.readable)
                        "It goes to the office as soon as you have signal."
                    else
                        "The office will type this one in from your photo. Retake it if it was blurry.",
                    color = TagSnapColors.muted,
                    fontSize = 14.sp
                )
            }
        }

        val parsed = result.parsed
        if (parsed != null && result.readable) {
            SummaryRow("Ticket", parsed.ticketNumber.value ?: "—")
            SummaryRow("Date", Format.date(parsed.tagDate.value))
            SummaryRow("Net", Format.tons(parsed.netTons.value))
            Text(
                "The office checks every number before anyone is paid.",
                color = TagSnapColors.faint,
                fontSize = 13.sp
            )
        }

        Button(
            onClick = onNext,
            colors = ButtonDefaults.buttonColors(containerColor = TagSnapColors.raised),
            modifier = Modifier.fillMaxWidth()
        ) { Text("Next ticket", color = TagSnapColors.text) }
    }
}

@Composable
private fun SummaryRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = TagSnapColors.muted, fontSize = 15.sp)
        Text(
            value,
            color = TagSnapColors.text,
            fontSize = 17.sp,
            fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.Monospace
        )
    }
}

// ------------------------------------------------------------ the pipeline

/** Longest side a photo is resized to before upload. */
private const val MAX_DIMENSION = 2000

/**
 * Everything between the shutter and the outbox.
 *
 * Off the main thread, and ordered so that the only irreplaceable thing — the
 * photograph — is on disk before anything that can fail is attempted.
 */
private suspend fun handleCapture(
    context: android.content.Context,
    uri: Uri,
    state: AppState,
    rescanFor: Tag?,
    location: LocationProvider,
): CaptureResult = withContext(Dispatchers.IO) {

    val bitmap = context.contentResolver.openInputStream(uri).use { stream ->
        BitmapFactory.decodeStream(stream)
    } ?: throw IllegalStateException("That photo could not be opened.")

    val shrunk = shrink(bitmap)

    val id = UUID.randomUUID().toString()
    val file = File(state.outbox.photosDirectory, "$id.jpg")

    // Disk first, always. Everything after this can fail and be retried
    // without losing the only copy of the evidence.
    file.outputStream().use { out ->
        // 82% keeps dot-matrix print legible to both the recogniser and a human
        // on the review screen, at roughly 400 KB a ticket. Storage is now the
        // only per-ticket cost in the whole system, so this is the cost dial.
        shrunk.compress(Bitmap.CompressFormat.JPEG, 82, out)
    }

    // --- read it, here, now -------------------------------------------------
    var recognised: TextRecognizer.Result? = null
    var parsed: ScaleTicketParser.Output? = null

    try {
        val recognition = TextRecognizer.recognize(shrunk)
        recognised = recognition
        if (recognition.isWorthSubmitting) {
            parsed = ScaleTicketParser.parse(recognition)
        }
    } catch (e: Exception) {
        Log.w("TagSnap/ocr", "recognition failed: ${e.message}")
    }

    val phash = runCatching { PerceptualHash.dHash(shrunk) }.getOrNull()
    val fix = location.current()
    val ok = parsed?.isScaleTicket == true

    state.outbox.enqueue(
        Outbox.Row(
            id = id,
            rescanForTagId = rescanFor?.id,
            payeeType = state.payeeType,
            driverId = state.driverId,
            subhaulerId = state.subhaulerId,
            localPath = file.absolutePath,
            capturedAt = Format.now(),
            capturedLat = fix?.lat,
            capturedLng = fix?.lng,
            phash = phash,
            note = null,
            extractedJson = parsed?.extractedJson()?.toString(),
            confidenceJson = parsed?.confidenceJson()?.toString(),
            rawJson = parsed?.rawJson(recognised?.lines?.size ?: 0)?.toString(),
            ocrText = recognised?.text,
            ocrMs = recognised?.ms ?: 0,
            ocrOk = ok,
            status = "pending",
            attempts = 0,
            lastError = null,
            createdAt = Format.now(),
        )
    )

    if (shrunk !== bitmap) bitmap.recycle()

    CaptureResult(parsed, ok)
}

/**
 * Resize so the longest side is [MAX_DIMENSION].
 *
 * 2000 px keeps dot-matrix print legible to both the recogniser and a human on
 * the review screen. The document scanner already returned an upright,
 * perspective-corrected page, so there is no rotation to undo here.
 */
private fun shrink(bitmap: Bitmap): Bitmap {
    val longest = maxOf(bitmap.width, bitmap.height)
    if (longest <= MAX_DIMENSION) return bitmap

    val scale = MAX_DIMENSION.toFloat() / longest
    return Bitmap.createScaledBitmap(
        bitmap,
        (bitmap.width * scale).toInt(),
        (bitmap.height * scale).toInt(),
        true
    )
}
