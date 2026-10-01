package com.tagsnap.store

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.tagsnap.net.PayeeType
import java.io.File

/**
 * What the phone is holding that the server has not got yet.
 *
 * The order of operations at capture is the whole point of this file:
 *
 *   1. write the JPEG to disk
 *   2. read it with ML Kit, **on the device, with no network**
 *   3. insert a row here
 *   4. tell the driver it is saved
 *
 * Only then, whenever there is signal, does anything get uploaded. A quarry
 * scale house is frequently a metal building at the bottom of a pit, and the
 * app has to behave as though there is no connectivity at all — because often
 * there is not.
 *
 * Moving OCR onto the device made this strictly better than the old pipeline.
 * Reading used to require reaching a server, so a driver in a dead zone waited
 * hours to find out their photo was unreadable — by which time they had left
 * the quarry. Now they find out in half a second, standing next to the scale
 * house, while retaking it costs nothing.
 */
class Outbox(context: Context) : SQLiteOpenHelper(context, DB, null, VERSION) {

    private val appContext = context.applicationContext

    /** A capture waiting to go up. */
    data class Row(
        val id: String,
        val rescanForTagId: String?,
        val payeeType: PayeeType,
        val driverId: String?,
        val subhaulerId: String?,
        val localPath: String,
        val capturedAt: String,
        val capturedLat: Double?,
        val capturedLng: Double?,
        val phash: Long?,
        val note: String?,

        /**
         * The reading, taken at capture time. Null when ML Kit found nothing
         * usable — that submits `extraction_failed()` instead, which puts the
         * photo in front of a person rather than filing a reading of nothing.
         */
        val extractedJson: String?,
        val confidenceJson: String?,
        val rawJson: String?,
        val ocrText: String?,
        val ocrMs: Int,
        val ocrOk: Boolean,

        val status: String,
        val attempts: Int,
        val lastError: String?,
        val createdAt: String,
    )

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            create table outbox (
              id                text primary key,
              rescan_for_tag_id text,
              payee_type        text not null,
              driver_id         text,
              subhauler_id      text,
              local_path        text not null,
              captured_at       text not null,
              captured_lat      real,
              captured_lng      real,
              phash             integer,
              note              text,
              extracted_json    text,
              confidence_json   text,
              raw_json          text,
              ocr_text          text,
              ocr_ms            integer not null default 0,
              ocr_ok            integer not null default 0,
              status            text not null default 'pending',
              attempts          integer not null default 0,
              last_error        text,
              created_at        text not null,
              sent_at           text
            )
            """.trimIndent()
        )
        db.execSQL("create index outbox_pending on outbox (status, created_at)")
    }

    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) {
        // There has only ever been one version. When there is a second, migrate
        // rather than dropping — a dropped outbox is a lost load, and the photo
        // on disk would be orphaned with nothing pointing at it.
    }

    // ------------------------------------------------------------------ writes

    fun enqueue(row: Row) {
        val values = ContentValues().apply {
            put("id", row.id)
            put("rescan_for_tag_id", row.rescanForTagId)
            put("payee_type", row.payeeType.wire)
            put("driver_id", row.driverId)
            put("subhauler_id", row.subhaulerId)
            put("local_path", row.localPath)
            put("captured_at", row.capturedAt)
            put("captured_lat", row.capturedLat)
            put("captured_lng", row.capturedLng)
            put("phash", row.phash)
            put("note", row.note)
            put("extracted_json", row.extractedJson)
            put("confidence_json", row.confidenceJson)
            put("raw_json", row.rawJson)
            put("ocr_text", row.ocrText)
            put("ocr_ms", row.ocrMs)
            put("ocr_ok", if (row.ocrOk) 1 else 0)
            put("status", "pending")
            put("attempts", 0)
            put("created_at", row.createdAt)
        }
        writableDatabase.insertWithOnConflict(
            "outbox", null, values, SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    fun markUploading(id: String) {
        writableDatabase.execSQL(
            "update outbox set status = 'uploading', attempts = attempts + 1 where id = ?",
            arrayOf(id)
        )
    }

    fun markSent(id: String) {
        writableDatabase.execSQL(
            "update outbox set status = 'sent', last_error = null, " +
                "sent_at = datetime('now') where id = ?",
            arrayOf(id)
        )
    }

    fun markFailed(id: String, message: String) {
        writableDatabase.execSQL(
            "update outbox set status = 'pending', last_error = ? where id = ?",
            arrayOf(message.take(300), id)
        )
    }

    // ------------------------------------------------------------------- reads

    /**
     * Everything still waiting, oldest first.
     *
     * Oldest first because a driver who took eight tickets in a dead zone wants
     * them to land in the order they hauled them, and because the oldest is the
     * one closest to falling outside the 45-day window.
     */
    fun pending(): List<Row> = query(
        "select * from outbox where status in ('pending','uploading') " +
            "order by created_at asc limit 50"
    )

    fun pendingCount(): Int =
        readableDatabase.rawQuery(
            "select count(*) from outbox where status in ('pending','uploading')", null
        ).use { if (it.moveToFirst()) it.getInt(0) else 0 }

    /** Anything stuck: too many attempts, and a person should be told. */
    fun stuck(): List<Row> = query(
        "select * from outbox where status = 'pending' and attempts >= 8 order by created_at asc"
    )

    /**
     * Delete sent rows and hand back the files that can now go.
     *
     * Kept for an hour after sending rather than deleted immediately, so a
     * driver who checks their list right after a sync still sees the photo
     * rather than a grey box while the server round trip catches up.
     */
    fun pruneSent(): List<String> {
        val rows = query(
            "select * from outbox where status = 'sent' and sent_at < datetime('now', '-1 hour')"
        )
        for (row in rows) {
            writableDatabase.execSQL("delete from outbox where id = ?", arrayOf(row.id))
        }
        return rows.map { it.localPath }
    }

    private fun query(sql: String): List<Row> =
        readableDatabase.rawQuery(sql, null).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(read(cursor))
            }
        }

    private fun read(c: Cursor): Row = Row(
        id = c.str("id") ?: "",
        rescanForTagId = c.str("rescan_for_tag_id"),
        payeeType = if (c.str("payee_type") == "subhauler") {
            PayeeType.SUBHAULER
        } else {
            PayeeType.EMPLOYEE_DRIVER
        },
        driverId = c.str("driver_id"),
        subhaulerId = c.str("subhauler_id"),
        localPath = c.str("local_path") ?: "",
        capturedAt = c.str("captured_at") ?: "",
        capturedLat = c.dbl("captured_lat"),
        capturedLng = c.dbl("captured_lng"),
        phash = c.lng("phash"),
        note = c.str("note"),
        extractedJson = c.str("extracted_json"),
        confidenceJson = c.str("confidence_json"),
        rawJson = c.str("raw_json"),
        ocrText = c.str("ocr_text"),
        ocrMs = c.getInt(c.getColumnIndexOrThrow("ocr_ms")),
        ocrOk = c.getInt(c.getColumnIndexOrThrow("ocr_ok")) == 1,
        status = c.str("status") ?: "pending",
        attempts = c.getInt(c.getColumnIndexOrThrow("attempts")),
        lastError = c.str("last_error"),
        createdAt = c.str("created_at") ?: "",
    )

    private fun Cursor.str(name: String): String? {
        val i = getColumnIndexOrThrow(name)
        return if (isNull(i)) null else getString(i)
    }

    private fun Cursor.dbl(name: String): Double? {
        val i = getColumnIndexOrThrow(name)
        return if (isNull(i)) null else getDouble(i)
    }

    private fun Cursor.lng(name: String): Long? {
        val i = getColumnIndexOrThrow(name)
        return if (isNull(i)) null else getLong(i)
    }

    /**
     * Where the JPEGs live until they are safely uploaded.
     *
     * Internal storage, not the shared media store: these are somebody's pay
     * evidence, and they have no business appearing in the phone's gallery next
     * to family photos.
     */
    val photosDirectory: File
        get() = File(appContext.filesDir, "photos").apply { mkdirs() }

    private companion object {
        const val DB = "tagsnap.db"
        const val VERSION = 1
    }
}
