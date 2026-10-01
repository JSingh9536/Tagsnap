package com.tagsnap.ocr

/**
 * Turning what ML Kit returned into something with a type.
 *
 * A port of `packages/shared/src/parse/text.ts`. The rule running through every
 * function: **never repair a value into existence**. Character confusion is
 * corrected only where the surrounding evidence makes the correction
 * near-certain — a lone `O` inside a run of digits — and every repair lowers
 * the fit score it returns, so a field that needed fixing arrives at the
 * confidence floors already weakened.
 *
 * A misread that routes to a person costs ten seconds. A confident repair that
 * turns 5 into 6 costs a wrong payment and an argument about it later.
 */
object TicketText {

    private val dashes = Regex("[‐-―−]")
    private val whitespace = Regex("\\s+")

    /**
     * Uppercase, normalise punctuation and whitespace. Keeps `.` and `,`,
     * because those are decimal points, and a stripped one turns 48.32 into
     * forty-eight tons.
     */
    fun normalize(raw: String): String =
        raw.replace(dashes, "-")
            .replace('‘', '\'')
            .replace('’', '\'')
            .replace('“', '"')
            .replace('”', '"')
            .replace(whitespace, " ")
            .trim()
            .uppercase()

    private val digitForLetter = mapOf(
        'O' to '0', 'Q' to '0', 'D' to '0',
        'I' to '1', 'L' to '1', '|' to '1',
        'Z' to '2', 'A' to '4', 'S' to '5', 'G' to '6', 'T' to '7', 'B' to '8',
    )

    data class Repair(val text: String, val penalty: Double)

    /**
     * Fix letters that are obviously digits, and say how much fixing it took.
     *
     * Only applied to a token already believed to be a number — the caller
     * decides that by having found the token where a number belongs.
     */
    fun repairDigits(token: String): Repair {
        val digits = token.count { it.isDigit() }
        val letters = token.count { digitForLetter.containsKey(it) }

        // Mostly letters: a word, not a damaged number. Leave it alone.
        if (digits == 0 || letters > digits) return Repair(token, 1.0)

        var repaired = 0
        val out = buildString {
            for (c in token) {
                val swap = digitForLetter[c]
                if (swap != null) {
                    repaired++
                    append(swap)
                } else {
                    append(c)
                }
            }
        }

        // Each repaired character costs 12%. Two is already at 0.77, under
        // every floor in validation.ts.
        return Repair(out, maxOf(0.0, 1 - repaired * 0.12))
    }

    data class NumberRead(val value: Double, val fit: Double)

    private val numberShape = Regex("^[0-9OQDILZSBGAT|,. ]+$")
    private val repeatedDots = Regex("\\.+")

    /**
     * Read one token as a number.
     *
     * Handles the two things OCR does to numbers on a dot-matrix ticket: it
     * turns some digits into letters, and it puts spaces inside groups it could
     * not kern. `21, 340` and `21 340` are both 21340.
     */
    fun readNumber(rawToken: String): NumberRead? {
        var token = rawToken.trim().removePrefix("#").removePrefix("$").replace("*", "")
        if (token.isEmpty() || !numberShape.matches(token)) return null

        val repair = repairDigits(token.replace(" ", ""))
        val cleaned = repair.text.replace(repeatedDots, ".")

        val sep = maxOf(cleaned.lastIndexOf(','), cleaned.lastIndexOf('.'))

        var intPart = cleaned
        var fracPart = ""
        var grouped = false

        if (sep >= 0) {
            intPart = cleaned.substring(0, sep)
            fracPart = cleaned.substring(sep + 1)

            // Exactly three digits after: ambiguous. `21,340` is grouped, and
            // `21.340` on a scale ticket almost always is too, because scales
            // print whole pounds.
            if (fracPart.length == 3 && fracPart.all { it.isDigit() } && intPart.isNotEmpty()) {
                grouped = true
            }
        }

        val intDigits = intPart.filter { it.isDigit() }
        val fracDigits = fracPart.filter { it.isDigit() }
        if (intDigits.isEmpty() && fracDigits.isEmpty()) return null

        val value = if (grouped) {
            (intDigits + fracDigits).toDoubleOrNull()
        } else {
            val whole = intDigits.ifEmpty { "0" }
            val frac = fracDigits.ifEmpty { "0" }
            "$whole.$frac".toDoubleOrNull()
        } ?: return null

        if (!value.isFinite()) return null

        val separators = cleaned.count { it == '.' || it == ',' }
        val messy = if (separators > 1 && !grouped) 0.8 else 1.0

        return NumberRead(value, repair.penalty * messy)
    }

    private val months = mapOf(
        "JAN" to 1, "JANUARY" to 1, "FEB" to 2, "FEBRUARY" to 2,
        "MAR" to 3, "MARCH" to 3, "APR" to 4, "APRIL" to 4, "MAY" to 5,
        "JUN" to 6, "JUNE" to 6, "JUL" to 7, "JULY" to 7,
        "AUG" to 8, "AUGUST" to 8, "SEP" to 9, "SEPT" to 9, "SEPTEMBER" to 9,
        "OCT" to 10, "OCTOBER" to 10, "NOV" to 11, "NOVEMBER" to 11,
        "DEC" to 12, "DECEMBER" to 12,
    )

    data class DateRead(val value: String, val fit: Double)

    private val daysInMonth = intArrayOf(31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)

    /** Rejects 31 February and friends, without pulling in a calendar. */
    private fun iso(y: Int, m: Int, d: Int): String? {
        if (m !in 1..12 || d < 1) return null
        val leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
        val limit = if (m == 2 && leap) 29 else daysInMonth[m - 1]
        if (d > limit) return null
        return "%04d-%02d-%02d".format(y, m, d)
    }

    /**
     * A scale ticket is a document about something that happened this week, so
     * the conventional 80-99 split does not really matter — either way a 1997
     * ticket is stale and `validate_tag()` stops it.
     */
    private fun fullYear(yy: Int): Int =
        if (yy >= 100) yy else if (yy < 80) 2000 + yy else 1900 + yy

    private val isoDate = Regex("\\b(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})\\b")
    private val numericDate = Regex("\\b(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{2,4})\\b")
    private val dayFirstDate = Regex("\\b(\\d{1,2})[-\\s]([A-Z]{3,9})[-\\s,]+(\\d{2,4})\\b")
    private val monthFirstDate = Regex("\\b([A-Z]{3,9})[-\\s.]+(\\d{1,2})[-\\s,]+(\\d{2,4})\\b")

    /**
     * Find a date in a piece of text.
     *
     * Returns null rather than guessing when the year is not printed — a ticket
     * dated to the wrong year lands in a pay period that is closed.
     */
    fun readDate(raw: String): DateRead? {
        val text = normalize(raw)

        isoDate.find(text)?.let { m ->
            iso(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt())
                ?.let { return DateRead(it, 1.0) }
        }

        numericDate.find(text)?.let { m ->
            var a = m.groupValues[1].toInt()
            var b = m.groupValues[2].toInt()
            val y = fullYear(m.groupValues[3].toInt())
            var fit = 1.0

            // US order unless the first number cannot be a month.
            if (a > 12 && b <= 12) {
                val t = a; a = b; b = t
                fit = 0.85
            }
            iso(y, a, b)?.let {
                return DateRead(it, if (m.groupValues[3].length == 4) fit else fit * 0.95)
            }
        }

        dayFirstDate.find(text)?.let { m ->
            months[m.groupValues[2]]?.let { month ->
                iso(fullYear(m.groupValues[3].toInt()), month, m.groupValues[1].toInt())
                    ?.let { return DateRead(it, 0.95) }
            }
        }

        monthFirstDate.find(text)?.let { m ->
            months[m.groupValues[1]]?.let { month ->
                iso(fullYear(m.groupValues[3].toInt()), month, m.groupValues[2].toInt())
                    ?.let { return DateRead(it, 0.95) }
            }
        }

        // A date with no year is not a date. Say nothing rather than assume.
        return null
    }

    data class TimeRead(val value: String, val fit: Double)

    private val timePattern = Regex("\\b(\\d{1,2})[:.](\\d{2})(?::(\\d{2}))?\\s*(AM|PM)?\\b")

    fun readTime(raw: String): TimeRead? {
        val m = timePattern.find(normalize(raw)) ?: return null

        var hour = m.groupValues[1].toInt()
        val minute = m.groupValues[2].toInt()
        val meridiem = m.groupValues[4]

        if (minute > 59) return null
        if (meridiem == "PM" && hour < 12) hour += 12
        if (meridiem == "AM" && hour == 12) hour = 0
        if (hour > 23) return null

        return TimeRead(
            "%02d:%02d".format(hour, minute),
            // Without AM/PM a 12-hour clock is genuinely ambiguous. Time never
            // feeds pay, so this is recorded rather than agonised over.
            if (meridiem.isEmpty()) 0.85 else 1.0
        )
    }

    private val tokenSplit = Regex("[\\s|]+")

    /** Whitespace-separated tokens, punctuation trimmed from the ends. */
    fun tokens(raw: String): List<String> =
        normalize(raw)
            .split(tokenSplit)
            .map { it.trim('.', ',', ';', ':', '*') }
            .filter { it.isNotEmpty() }
}
