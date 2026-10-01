package com.tagsnap.core

import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Display helpers.
 *
 * Deliberately the same wording and rounding as `packages/shared/src/format.ts`
 * and the Swift `Format` enum. A driver and the office reading the same tonnage
 * differently is a phone call, and this app exists to remove phone calls.
 */
object Format {

    private val currency = java.text.NumberFormat.getCurrencyInstance(Locale.US)
    private val dayMonthYear = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US)

    fun cents(value: Int?): String =
        if (value == null) "—" else currency.format(value / 100.0)

    fun tons(value: Double?): String =
        if (value == null) "—" else String.format(Locale.US, "%.2f t", value)

    /**
     * Handles both a bare `yyyy-MM-dd` from `tags.tag_date` and a full
     * timestamp from `created_at`, because the same row carries both and the
     * screens do not want to care which they were handed.
     */
    fun date(iso: String?): String {
        if (iso.isNullOrBlank()) return "—"
        return try {
            if (iso.length == 10) {
                LocalDate.parse(iso).format(dayMonthYear)
            } else {
                OffsetDateTime.parse(iso).toLocalDate().format(dayMonthYear)
            }
        } catch (_: Exception) {
            iso
        }
    }

    fun now(): String = OffsetDateTime.now().toString()
}
