package com.tagsnap.store

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.tagsnap.net.Api
import com.tagsnap.net.ExtractionEngine
import com.tagsnap.net.Profile
import com.tagsnap.net.Supabase
import com.tagsnap.net.SupabaseException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The upload worker.
 *
 * Four steps per capture, in this order and for a reason:
 *
 *   1. create the `tags` row       — the storage policy in 004 checks that the
 *                                    tag exists and is not frozen, so the row
 *                                    has to land first
 *   2. upload the image            — straight to the private bucket
 *   3. create the `tag_images` row — this is what supersedes any prior photo
 *                                    and closes an open rescan request
 *   4. submit the reading          — `apply_extraction`, or
 *                                    `extraction_failed` if the phone could
 *                                    not read it
 *
 * Every step is idempotent. Step 1 upserts on a client-generated primary key,
 * step 2 overwrites the same object path, step 3 is skipped when a row for that
 * version already exists, and step 4 can be re-run on a tag that is already
 * `extracted`. A worker killed mid-flight and restarted lands in the same
 * place, which matters because in this line of work it will be.
 */
class Uploader(private val context: Context, private val outbox: Outbox) {

    private val _pending = MutableStateFlow(0)
    val pending: StateFlow<Int> = _pending

    private val _syncing = MutableStateFlow(false)
    val syncing: StateFlow<Boolean> = _syncing

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError

    private val lock = Mutex()

    /** Give up on a row after this many tries and let the driver see it stuck. */
    private val maxAttempts = 8

    var profile: Profile? = null

    fun refreshCount() {
        _pending.value = outbox.pendingCount()
    }

    suspend fun sync(): Int = lock.withLock {
        _syncing.value = true
        var sent = 0

        try {
            for (row in outbox.pending()) {
                if (row.attempts >= maxAttempts) continue
                try {
                    outbox.markUploading(row.id)
                    upload(row)
                    outbox.markSent(row.id)
                    sent++
                    _lastError.value = null
                } catch (e: Exception) {
                    outbox.markFailed(row.id, e.message ?: e.toString())
                    _lastError.value = e.message
                    Log.w(TAG, "upload failed: ${e.message}")
                }
            }

            for (path in outbox.pruneSent()) {
                runCatching { File(path).delete() }
            }
        } finally {
            _syncing.value = false
            refreshCount()
        }

        sent
    }

    // -------------------------------------------------------------- one capture

    private suspend fun upload(row: Outbox.Row) {
        val isRescan = row.rescanForTagId != null
        val tagId = row.rescanForTagId ?: row.id

        val userId = Supabase.currentUserId ?: throw SupabaseException.SignedOut
        val me = profile ?: Api.myProfile().also { profile = it }

        // --- 1. the tag row ---------------------------------------------------
        if (!isRescan) {
            val values = JSONObject()
                .put("id", tagId)
                .put("company_id", me.companyId)
                .put("payee_type", row.payeeType.wire)
                .put("source", "driver_photo")
                .put("status", "uploaded")
                .put("driver_id", row.driverId ?: JSONObject.NULL)
                .put("subhauler_id", row.subhaulerId ?: JSONObject.NULL)

            row.note?.let { values.put("review_notes", it) }

            try {
                Supabase.insert("tags", values, upsert = true)
            } catch (_: SupabaseException.Duplicate) {
                // A previous attempt already got this far. That is success.
            }
        }

        // --- 2. the image ------------------------------------------------------
        val version = nextVersion(tagId)
        val path = "${me.companyId}/$tagId/v$version.jpg"

        val file = File(row.localPath)
        if (!file.exists()) {
            // The photo is gone from disk. Nothing to retry forever over, and
            // pretending otherwise leaves a row that never clears.
            throw SupabaseException.Server("That photo is no longer on this device.")
        }
        val bytes = file.readBytes()

        Supabase.uploadImage(bytes, path)

        // --- 3. the image row ---------------------------------------------------
        // Last of the storage steps, because this is the one that supersedes
        // the previous photo and closes an open rescan. If the process dies
        // before it, step 2 just re-runs harmlessly.
        val image = JSONObject()
            .put("tag_id", tagId)
            .put("version", version)
            .put("image_path", path)
            .put("bytes", bytes.size)
            .put("captured_at", row.capturedAt)
            .put("uploaded_by", userId)
            .put("is_current", true)
            .put("captured_lat", row.capturedLat ?: JSONObject.NULL)
            .put("captured_lng", row.capturedLng ?: JSONObject.NULL)
            // Postgres bigint over JSON: sent as a string so a 64-bit value
            // cannot lose its low bits to a double on the way through
            // PostgREST.
            .put("image_phash", row.phash?.toString() ?: JSONObject.NULL)

        try {
            Supabase.insert("tag_images", image)
        } catch (_: SupabaseException.Duplicate) {
            // Already attached on a previous attempt.
        }

        // --- 4. the reading ------------------------------------------------------
        // This is the step that used to be a paid server-side model call. It is
        // now a plain database write of work the phone already did, for free,
        // possibly hours ago in a dead zone.
        if (row.ocrOk && row.extractedJson != null && row.confidenceJson != null) {
            Supabase.rpc(
                "apply_extraction",
                JSONObject()
                    .put("p_tag_id", tagId)
                    .put("p_extracted", JSONObject(row.extractedJson))
                    .put("p_confidence", JSONObject(row.confidenceJson))
                    .put("p_engine", ExtractionEngine.MLKIT.wire)
                    .put("p_engine_version", "mlkit-text-v2")
                    .put("p_ocr_text", row.ocrText ?: JSONObject.NULL)
                    .put("p_ocr_ms", row.ocrMs)
                    .put(
                        "p_raw",
                        row.rawJson?.let { JSONObject(it) } ?: JSONObject.NULL
                    )
            )
        } else {
            Supabase.rpc(
                "extraction_failed",
                JSONObject()
                    .put("p_tag_id", tagId)
                    .put("p_engine", ExtractionEngine.MLKIT.wire)
                    .put("p_reason", "ocr_unreadable")
                    .put("p_ocr_text", row.ocrText ?: JSONObject.NULL)
            )
        }
    }

    /**
     * The next image version for a tag.
     *
     * The database assigns this too, in a trigger — this is only so the storage
     * path is predictable before the row exists. A collision is harmless
     * because the trigger has the final say on the column.
     */
    private suspend fun nextVersion(tagId: String): Int {
        val body = Supabase.selectRaw(
            "tag_images",
            "select=version&tag_id=eq.$tagId&order=version.desc&limit=1"
        )
        val array = org.json.JSONArray(body)
        return if (array.length() == 0) 1 else array.getJSONObject(0).getInt("version") + 1
    }

    companion object {
        private const val TAG = "TagSnap/upload"
        private const val WORK = "tagsnap-upload"

        /**
         * Ask WorkManager to drain the outbox when there is a connection.
         *
         * This is the Android half of what `NWPathMonitor` does on iOS, and it
         * is better: the OS wakes the app when coverage returns, so a driver's
         * morning uploads itself while the phone is in a cup holder.
         */
        fun schedule(context: Context) {
            val request = OneTimeWorkRequestBuilder<UploadWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()

            WorkManager.getInstance(context)
                // KEEP, not REPLACE: every capture calls this, and replacing
                // would reset the backoff on every photo taken in a dead zone —
                // turning eight captures into eight immediate retries.
                .enqueueUniqueWork(WORK, ExistingWorkPolicy.KEEP, request)
        }
    }
}

/** The background half. Runs even if the app has been swiped away. */
class UploadWorker(context: Context, params: WorkerParameters) :
    CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val outbox = Outbox(applicationContext)
        val uploader = Uploader(applicationContext, outbox)

        return try {
            uploader.sync()
            // Anything left is either backing off or genuinely stuck. Asking
            // WorkManager to retry keeps the constraint-driven wake-up alive
            // without this worker spinning.
            if (outbox.pendingCount() > 0) Result.retry() else Result.success()
        } catch (e: Exception) {
            Log.w("TagSnap/worker", "sync failed: ${e.message}")
            Result.retry()
        }
    }
}
