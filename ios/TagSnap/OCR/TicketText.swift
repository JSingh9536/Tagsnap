import Foundation

/// Turning what Vision returned into something with a type.
///
/// A port of `packages/shared/src/parse/text.ts`. The rule running through
/// every function: **never repair a value into existence**. Character
/// confusion is corrected only where the surrounding evidence makes the
/// correction near-certain — a lone `O` inside a run of digits — and every
/// repair lowers the fit score it returns, so a field that needed fixing
/// arrives at the confidence floors already weakened.
///
/// A misread that routes to a person costs ten seconds. A confident repair
/// that turns 5 into 6 costs a wrong payment and an argument about it later.
enum TicketText {

    /// Uppercase, normalise punctuation and whitespace. Keeps `.` and `,`,
    /// because those are decimal points and a stripped one turns 48.32 into
    /// forty-eight tons.
    static func normalize(_ raw: String) -> String {
        var s = raw
        for dash in ["\u{2010}", "\u{2011}", "\u{2012}", "\u{2013}", "\u{2014}",
                     "\u{2015}", "\u{2212}"] {
            s = s.replacingOccurrences(of: dash, with: "-")
        }
        s = s.replacingOccurrences(of: "\u{2018}", with: "'")
            .replacingOccurrences(of: "\u{2019}", with: "'")
            .replacingOccurrences(of: "\u{201C}", with: "\"")
            .replacingOccurrences(of: "\u{201D}", with: "\"")
        s = s.replacingOccurrences(
            of: "\\s+", with: " ", options: .regularExpression
        )
        return s.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    private static let digitForLetter: [Character: Character] = [
        "O": "0", "Q": "0", "D": "0",
        "I": "1", "L": "1", "|": "1",
        "Z": "2", "A": "4", "S": "5", "G": "6", "T": "7", "B": "8",
    ]

    struct Repair {
        let text: String
        /// 0...1, multiplied into the field's confidence.
        let penalty: Double
    }

    /// Fix letters that are obviously digits, and say how much fixing it took.
    ///
    /// Only applied to a token already believed to be a number — the caller
    /// decides that by having found the token where a number belongs.
    static func repairDigits(_ token: String) -> Repair {
        let chars = Array(token)
        let digits = chars.filter { $0.isNumber }.count
        let letters = chars.filter { digitForLetter[$0] != nil }.count

        // Mostly letters: a word, not a damaged number. Leave it alone.
        if digits == 0 || letters > digits { return Repair(text: token, penalty: 1) }

        var repaired = 0
        let out = String(chars.map { c -> Character in
            if let swap = digitForLetter[c] {
                repaired += 1
                return swap
            }
            return c
        })

        // Each repaired character costs 12%. Two is already at 0.77, under
        // every floor in validation.ts.
        return Repair(text: out, penalty: max(0, 1 - Double(repaired) * 0.12))
    }

    struct NumberRead {
        let value: Double
        /// 0...1. How much the token looked like a clean number to begin with.
        let fit: Double
    }

    private static let numberShape = try! NSRegularExpression(
        pattern: "^[0-9OQDILZSBGAT|,. ]+$"
    )

    /// Read one token as a number.
    ///
    /// Handles the two things OCR does to numbers on a dot-matrix ticket: it
    /// turns some digits into letters, and it puts spaces inside groups it
    /// could not kern. `21, 340` and `21 340` are both 21340.
    static func readNumber(_ rawToken: String) -> NumberRead? {
        var token = rawToken.trimmingCharacters(in: .whitespaces)
        if token.hasPrefix("#") || token.hasPrefix("$") { token.removeFirst() }
        token = token.replacingOccurrences(of: "*", with: "")
        guard !token.isEmpty else { return nil }

        let range = NSRange(token.startIndex..., in: token)
        guard numberShape.firstMatch(in: token, range: range) != nil else { return nil }

        let repair = repairDigits(token.replacingOccurrences(of: " ", with: ""))
        let cleaned = repair.text.replacingOccurrences(
            of: "\\.+", with: ".", options: .regularExpression
        )

        let lastComma = cleaned.lastIndex(of: ",")
        let lastDot = cleaned.lastIndex(of: ".")

        var intPart = cleaned
        var fracPart = ""
        var grouped = false

        let sep: String.Index? = {
            switch (lastComma, lastDot) {
            case let (c?, d?): return max(c, d)
            case let (c?, nil): return c
            case let (nil, d?): return d
            default: return nil
            }
        }()

        if let sep {
            let after = String(cleaned[cleaned.index(after: sep)...])
            intPart = String(cleaned[..<sep])
            fracPart = after

            if after.count == 3, after.allSatisfy(\.isNumber), !intPart.isEmpty {
                // Exactly three digits after: ambiguous. `21,340` is grouped,
                // and `21.340` on a scale ticket almost always is too, because
                // scales print whole pounds.
                grouped = true
            }
        }

        let intDigits = intPart.filter(\.isNumber)
        let fracDigits = fracPart.filter(\.isNumber)
        guard !(intDigits.isEmpty && fracDigits.isEmpty) else { return nil }

        let value: Double? = grouped
            ? Double(intDigits + fracDigits)
            : Double("\(intDigits.isEmpty ? "0" : intDigits).\(fracDigits.isEmpty ? "0" : fracDigits)")

        guard let value, value.isFinite else { return nil }

        let separators = cleaned.filter { $0 == "." || $0 == "," }.count
        let messy = (separators > 1 && !grouped) ? 0.8 : 1.0

        return NumberRead(value: value, fit: repair.penalty * messy)
    }

    private static let months: [String: Int] = [
        "JAN": 1, "JANUARY": 1, "FEB": 2, "FEBRUARY": 2, "MAR": 3, "MARCH": 3,
        "APR": 4, "APRIL": 4, "MAY": 5, "JUN": 6, "JUNE": 6, "JUL": 7, "JULY": 7,
        "AUG": 8, "AUGUST": 8, "SEP": 9, "SEPT": 9, "SEPTEMBER": 9,
        "OCT": 10, "OCTOBER": 10, "NOV": 11, "NOVEMBER": 11, "DEC": 12, "DECEMBER": 12,
    ]

    struct DateRead {
        /// ISO `YYYY-MM-DD`.
        let value: String
        let fit: Double
    }

    private static func iso(_ y: Int, _ m: Int, _ d: Int) -> String? {
        guard (1...12).contains(m), (1...31).contains(d) else { return nil }

        var components = DateComponents()
        components.year = y
        components.month = m
        components.day = d
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!

        // Rejects 31 February and friends: the calendar rolls them forward,
        // and the round trip catches that it moved.
        guard let date = calendar.date(from: components),
              let back = calendar.dateComponents([.year, .month, .day], from: date) as DateComponents?,
              back.year == y, back.month == m, back.day == d
        else { return nil }

        return String(format: "%04d-%02d-%02d", y, m, d)
    }

    /// A scale ticket is a document about something that happened this week,
    /// so the conventional 80-99 split does not really matter — either way a
    /// 1997 ticket is stale and `validate_tag()` stops it.
    private static func fullYear(_ yy: Int) -> Int {
        yy >= 100 ? yy : (yy < 80 ? 2000 + yy : 1900 + yy)
    }

    /// Find a date in a piece of text.
    ///
    /// Returns nil rather than guessing when the year is not printed — a
    /// ticket dated to the wrong year lands in a pay period that is closed.
    static func readDate(_ raw: String) -> DateRead? {
        let text = normalize(raw)

        if let m = match(text, #"\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b"#),
           let out = iso(Int(m[1])!, Int(m[2])!, Int(m[3])!) {
            return DateRead(value: out, fit: 1)
        }

        if let m = match(text, #"\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b"#) {
            var a = Int(m[1])!
            var b = Int(m[2])!
            let y = fullYear(Int(m[3])!)
            var fit = 1.0

            // US order unless the first number cannot be a month.
            if a > 12, b <= 12 {
                swap(&a, &b)
                fit = 0.85
            }
            if let out = iso(y, a, b) {
                return DateRead(value: out, fit: m[3].count == 4 ? fit : fit * 0.95)
            }
        }

        if let m = match(text, #"\b(\d{1,2})[-\s]([A-Z]{3,9})[-\s,]+(\d{2,4})\b"#),
           let month = months[m[2]],
           let out = iso(fullYear(Int(m[3])!), month, Int(m[1])!) {
            return DateRead(value: out, fit: 0.95)
        }

        if let m = match(text, #"\b([A-Z]{3,9})[-\s.]+(\d{1,2})[-\s,]+(\d{2,4})\b"#),
           let month = months[m[1]],
           let out = iso(fullYear(Int(m[3])!), month, Int(m[2])!) {
            return DateRead(value: out, fit: 0.95)
        }

        // A date with no year is not a date. Say nothing rather than assume.
        return nil
    }

    struct TimeRead {
        /// `HH:MM`, 24-hour.
        let value: String
        let fit: Double
    }

    static func readTime(_ raw: String) -> TimeRead? {
        let text = normalize(raw)
        guard let m = match(text, #"\b(\d{1,2})[:.](\d{2})(?::(\d{2}))?\s*(AM|PM)?\b"#)
        else { return nil }

        var hour = Int(m[1])!
        let minute = Int(m[2])!
        let meridiem = m.count > 4 ? m[4] : ""

        guard minute <= 59 else { return nil }
        if meridiem == "PM", hour < 12 { hour += 12 }
        if meridiem == "AM", hour == 12 { hour = 0 }
        guard hour <= 23 else { return nil }

        return TimeRead(
            value: String(format: "%02d:%02d", hour, minute),
            // Without AM/PM a 12-hour clock is genuinely ambiguous. Time never
            // feeds pay, so this is recorded rather than agonised over.
            fit: meridiem.isEmpty ? 0.85 : 1
        )
    }

    /// Whitespace-separated tokens, punctuation trimmed from the ends.
    static func tokens(_ raw: String) -> [String] {
        normalize(raw)
            .components(separatedBy: CharacterSet(charactersIn: " |"))
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ".,;:*")) }
            .filter { !$0.isEmpty }
    }

    // MARK: - Regex helper

    private static var cache: [String: NSRegularExpression] = [:]
    private static let cacheLock = NSLock()

    /// Capture groups as strings, with unmatched optional groups as "".
    ///
    /// Compiled patterns are cached because this runs a few hundred times per
    /// ticket and `NSRegularExpression(pattern:)` is not cheap.
    static func match(_ text: String, _ pattern: String) -> [String]? {
        cacheLock.lock()
        var regex = cache[pattern]
        if regex == nil {
            regex = try? NSRegularExpression(pattern: pattern)
            cache[pattern] = regex
        }
        cacheLock.unlock()

        guard let regex,
              let m = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
        else { return nil }

        return (0..<m.numberOfRanges).map { i in
            guard let r = Range(m.range(at: i), in: text) else { return "" }
            return String(text[r])
        }
    }
}
