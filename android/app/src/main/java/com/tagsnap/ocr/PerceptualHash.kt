package com.tagsnap.ocr

import android.graphics.Bitmap
import androidx.core.graphics.scale

/**
 * A difference hash of a tag photo.
 *
 * The unique constraint on `(quarry_id, ticket_number)` catches the same ticket
 * filed twice. It does not catch the same physical ticket photographed from a
 * different angle and filed with one digit of the ticket number changed — which
 * is the version of that someone actually tries, because it looks like an
 * honest typo if anyone asks.
 *
 * dHash catches it. The method is deliberately crude: shrink to 9×8 greyscale,
 * then record whether each pixel is brighter than the one to its right. That
 * yields 64 bits describing the *structure* of the image, which survives a
 * different angle, different lighting, and a different phone, while two
 * genuinely different documents diverge immediately.
 *
 * This must produce the same bits as the iOS implementation in
 * `ios/TagSnap/OCR/PerceptualHash.swift`, because the two are compared against
 * each other by `similar_tag_images()` in 008 — a mixed fleet is the normal
 * case, and a re-photograph is just as worth catching across platforms as
 * within one. Three things keep them in step: the same 9×8 grid, the same
 * Rec. 601 luma weights, and an upright bitmap on both sides.
 */
object PerceptualHash {

    private const val WIDTH = 9
    private const val HEIGHT = 8

    /**
     * Returns a signed 64-bit value, because Postgres `bigint` is signed and
     * the XOR-and-popcount distance works on the bit pattern regardless.
     */
    fun dHash(bitmap: Bitmap): Long {
        val grey = downsampleToGrey(bitmap)

        var hash = 0L
        var bit = 0

        for (y in 0 until HEIGHT) {
            for (x in 0 until WIDTH - 1) {
                val left = grey[y * WIDTH + x]
                val right = grey[y * WIDTH + x + 1]
                if (left > right) {
                    hash = hash or (1L shl (63 - bit))
                }
                bit++
            }
        }

        return hash
    }

    /**
     * Average every source pixel that falls in each destination cell.
     *
     * Nearest-neighbour sampling would be faster and would make the hash
     * sensitive to exactly the thing it must ignore — a one-pixel shift from a
     * slightly different camera angle. `scale(filter = true)` is a box filter,
     * which is what makes the result stable across two photos of the same sheet
     * of paper.
     */
    private fun downsampleToGrey(bitmap: Bitmap): DoubleArray {
        val small = bitmap.scale(WIDTH, HEIGHT, filter = true)
        val pixels = IntArray(WIDTH * HEIGHT)
        small.getPixels(pixels, 0, WIDTH, 0, 0, WIDTH, HEIGHT)
        if (small !== bitmap) small.recycle()

        // Rec. 601 luma. Scale tickets are near-monochrome anyway, but
        // weighting properly keeps a red carbon copy from reading as
        // near-black.
        return DoubleArray(pixels.size) { i ->
            val p = pixels[i]
            0.299 * ((p shr 16) and 0xFF) +
                0.587 * ((p shr 8) and 0xFF) +
                0.114 * (p and 0xFF)
        }
    }
}
