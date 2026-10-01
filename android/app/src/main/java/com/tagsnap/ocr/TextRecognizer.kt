package com.tagsnap.ocr

import android.graphics.Bitmap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Reading text off a photograph, on the phone, for nothing.
 *
 * This is the piece that replaced a paid vision API. ML Kit's Latin text
 * recogniser runs entirely on the device against a model bundled into the APK
 * — no API key, no quota, no per-call charge, and it works with the phone in
 * aeroplane mode. A 2000-pixel ticket comes back in roughly 200-600 ms on
 * anything made in the last five years.
 *
 * Bundling the model rather than downloading it on first use costs about 4 MB
 * of APK and is declared in the manifest. It matters because a driver's first
 * shift may well start in a dead zone, which is exactly the case this app
 * exists for — and a reader that needs to download itself before it can read
 * anything is a reader that fails on day one.
 */
object TextRecognizer {

    /**
     * @param box normalised 0..1, origin **top left**, y growing downward. ML
     *   Kit reports pixels; the conversion happens here, once, because the
     *   parser's "the line below the label" rule silently becomes "the line
     *   above" if it is missed.
     * @param confidence 0..1. ML Kit does not always populate a per-line
     *   confidence; when it does not, this is 1 and the parser's own pattern
     *   scoring carries the whole signal — which is the right default, because
     *   a made-up confidence is worse than an absent one.
     */
    data class Line(
        val text: String,
        val box: ScaleTicketParser.Box,
        val confidence: Double,
    )

    data class Result(
        val lines: List<Line>,
        val ms: Int,
        /**
         * Recorded on the tag so an accuracy regression is attributable to a
         * model version rather than to "the app".
         */
        val engineVersion: String,
    ) {
        val text: String get() = lines.joinToString("\n") { it.text }

        /**
         * Is there enough here to be worth submitting at all?
         *
         * A blank wall, a thumb over the lens, or a photo taken in the dark
         * produces two or three garbage lines. Submitting that would file a
         * reading of nothing; `extraction_failed()` is the right call, and it
         * puts the photo in front of a person with an honest explanation.
         */
        val isWorthSubmitting: Boolean
            get() = lines.size >= 4 && text.replace(" ", "").length >= 30
    }

    private val recogniser by lazy {
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    }

    suspend fun recognize(bitmap: Bitmap): Result {
        val started = System.currentTimeMillis()
        val width = bitmap.width.toDouble()
        val height = bitmap.height.toDouble()

        // Rotation 0: the bitmap handed in has already been straightened by the
        // document scanner, or by the caller. Passing a rotation here as well
        // would rotate it twice.
        val input = InputImage.fromBitmap(bitmap, 0)

        return suspendCancellableCoroutine { continuation ->
            recogniser.process(input)
                .addOnSuccessListener { text ->
                    val lines = text.textBlocks
                        .flatMap { it.lines }
                        .mapNotNull { line ->
                            val box = line.boundingBox ?: return@mapNotNull null
                            Line(
                                text = line.text,
                                box = ScaleTicketParser.Box(
                                    x = box.left / width,
                                    y = box.top / height,
                                    width = box.width() / width,
                                    height = box.height() / height,
                                ),
                                confidence = line.confidence?.toDouble() ?: 1.0,
                            )
                        }

                    continuation.resume(
                        Result(
                            lines = lines,
                            ms = (System.currentTimeMillis() - started).toInt(),
                            engineVersion = "mlkit-text-v2",
                        )
                    )
                }
                .addOnFailureListener { continuation.resumeWithException(it) }
                .addOnCanceledListener { continuation.cancel() }
        }
    }
}
