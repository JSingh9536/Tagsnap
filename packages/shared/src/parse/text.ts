/**
 * Turning what OCR returned into something with a type.
 *
 * The rule running through every function here: **never repair a value into
 * existence**. Character confusion is corrected only where the surrounding
 * evidence makes the correction near-certain — a lone `O` inside a run of
 * digits — and every repair lowers the fit score it returns, so a field that
 * needed fixing arrives at the confidence floors already weakened.
 *
 * A misread that routes to a person costs ten seconds. A confident repair that
 * turns 5 into 6 costs a wrong payment and an argument about it later.
 */

/** Uppercase, normalise punctuation and whitespace. Keeps digits and `.`/`,`. */
export function normalize(raw: string): string {
  return raw
    .replace(/[‐-―−]/g, '-') // every dash OCR invents
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** As `normalize`, but also strips the punctuation labels are printed with. */
export function normalizeLabel(raw: string): string {
  return normalize(raw)
    .replace(/[.:#*_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DIGIT_FOR_LETTER: Record<string, string> = {
  O: '0',
  Q: '0',
  D: '0',
  I: '1',
  L: '1',
  '|': '1',
  Z: '2',
  S: '5',
  B: '8',
  G: '6',
};

/**
 * Fix letters that are obviously digits, and say how much fixing it took.
 *
 * Only applied to a token already believed to be a number — the caller decides
 * that, by having found the token where a number belongs. Returns the repaired
 * string and a penalty in 0..1 that multiplies into the field's confidence.
 */
export function repairDigits(token: string): { text: string; penalty: number } {
  const chars = [...token];
  const digits = chars.filter((c) => c >= '0' && c <= '9').length;
  const letters = chars.filter((c) => DIGIT_FOR_LETTER[c] !== undefined).length;

  // Mostly letters: this is a word, not a damaged number. Leave it alone.
  if (digits === 0 || letters > digits) return { text: token, penalty: 1 };

  let repaired = 0;
  const out = chars
    .map((c) => {
      const swap = DIGIT_FOR_LETTER[c];
      if (swap === undefined) return c;
      repaired++;
      return swap;
    })
    .join('');

  // Each repaired character costs 12% of the field's confidence. Two is
  // already down at 0.77, which is under every floor in validation.ts.
  return { text: out, penalty: Math.max(0, 1 - repaired * 0.12) };
}

export interface NumberRead {
  value: number;
  /** 0..1. How much the token looked like a clean number to begin with. */
  fit: number;
  /** True when a thousands separator was present — a strong weight signal. */
  grouped: boolean;
  /** Digits after the decimal point, or 0. */
  decimals: number;
}

const NUMBER_SHAPE = /^[0-9OQDILZSBG|,. ]+$/;

/**
 * Read one token as a number.
 *
 * Handles the two things OCR does to numbers on a dot-matrix ticket: it turns
 * some digits into letters, and it puts spaces inside groups it could not
 * kern. `21, 340` and `21 340` are both 21340.
 */
export function readNumber(rawToken: string): NumberRead | null {
  const token = rawToken.trim().replace(/^[#$]/, '').replace(/[*]/g, '');
  if (token.length === 0 || !NUMBER_SHAPE.test(token)) return null;

  const { text, penalty } = repairDigits(token.replace(/ /g, ''));

  // A decimal point OCR read as a comma, or the other way round. Whichever
  // separator appears last and has 1-3 digits after it is the decimal.
  const cleaned = text.replace(/,/g, ',').replace(/\.+/g, '.');
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  let intPart: string;
  let fracPart = '';
  let grouped = false;

  const sep = Math.max(lastComma, lastDot);
  if (sep === -1) {
    intPart = cleaned;
  } else {
    const after = cleaned.slice(sep + 1);
    if (/^\d{1,3}$/.test(after) && after.length !== 3) {
      // 1 or 2 digits after: a decimal, unambiguously.
      intPart = cleaned.slice(0, sep);
      fracPart = after;
    } else if (/^\d{3}$/.test(after) && cleaned.slice(0, sep).length > 0) {
      // Exactly 3 digits after: ambiguous. `21,340` is grouped; `21.340` on a
      // scale ticket is almost always grouped too, because scales print whole
      // pounds. Treat as grouping, and record that it was.
      intPart = cleaned.slice(0, sep);
      fracPart = after;
      grouped = true;
    } else {
      intPart = cleaned.slice(0, sep);
      fracPart = after;
    }
  }

  const digitsOnly = (intPart + fracPart).replace(/[^0-9]/g, '');
  if (digitsOnly.length === 0) return null;

  const intDigits = intPart.replace(/[^0-9]/g, '');
  const value = grouped
    ? Number(intDigits + fracPart)
    : Number(`${intDigits || '0'}.${fracPart || '0'}`);

  if (!Number.isFinite(value)) return null;

  // Stray separators, or a token that needed several repairs, both reduce fit.
  const separators = (cleaned.match(/[.,]/g) ?? []).length;
  const messy = separators > 1 && !grouped ? 0.8 : 1;

  return {
    value,
    fit: penalty * messy,
    grouped,
    decimals: grouped ? 0 : fracPart.length,
  };
}

const MONTHS: Record<string, number> = {
  JAN: 1, JANUARY: 1,
  FEB: 2, FEBRUARY: 2,
  MAR: 3, MARCH: 3,
  APR: 4, APRIL: 4,
  MAY: 5,
  JUN: 6, JUNE: 6,
  JUL: 7, JULY: 7,
  AUG: 8, AUGUST: 8,
  SEP: 9, SEPT: 9, SEPTEMBER: 9,
  OCT: 10, OCTOBER: 10,
  NOV: 11, NOVEMBER: 11,
  DEC: 12, DECEMBER: 12,
};

export interface DateRead {
  /** ISO YYYY-MM-DD. */
  value: string;
  fit: number;
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null; // 31 February and friends
  }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Two-digit years.
 *
 * A scale ticket is a document about something that happened this week. 80-99
 * being the nineteen-hundreds is the conventional split and it does not matter
 * here — either way, a 1997 ticket is forty-five days stale and validate_tag()
 * stops it.
 */
function fullYear(yy: number): number {
  if (yy >= 100) return yy;
  return yy < 80 ? 2000 + yy : 1900 + yy;
}

/**
 * Find a date in a piece of text.
 *
 * Returns null rather than guessing when the year is not printed. That is the
 * instruction the old vision prompt carried, and it is right for the same
 * reason: a ticket dated to the wrong year lands in a closed pay period.
 */
export function readDate(raw: string): DateRead | null {
  const text = normalize(raw);

  // 2026-08-25, and the ISO-ish variants scale software emits.
  const isoMatch = text.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (isoMatch) {
    const out = iso(+isoMatch[1]!, +isoMatch[2]!, +isoMatch[3]!);
    if (out) return { value: out, fit: 1 };
  }

  // 08/25/2026, 8/25/26, 08-25-26
  const numeric = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (numeric) {
    let a = +numeric[1]!;
    let b = +numeric[2]!;
    const y = fullYear(+numeric[3]!);

    // US order unless the first number cannot be a month.
    let fit = 1;
    if (a > 12 && b <= 12) {
      const t = a;
      a = b;
      b = t;
      fit = 0.85; // day-first is unusual on a US ticket; flag the uncertainty
    }
    const out = iso(y, a, b);
    if (out) return { value: out, fit: numeric[3]!.length === 4 ? fit : fit * 0.95 };
  }

  // 25-AUG-2026 / 25 AUG 26
  const dayFirst = text.match(/\b(\d{1,2})[-\s]([A-Z]{3,9})[-\s,]+(\d{2,4})\b/);
  if (dayFirst) {
    const m = MONTHS[dayFirst[2]!];
    if (m) {
      const out = iso(fullYear(+dayFirst[3]!), m, +dayFirst[1]!);
      if (out) return { value: out, fit: 0.95 };
    }
  }

  // AUG 25, 2026
  const monthFirst = text.match(/\b([A-Z]{3,9})[-\s.]+(\d{1,2})[-\s,]+(\d{2,4})\b/);
  if (monthFirst) {
    const m = MONTHS[monthFirst[1]!];
    if (m) {
      const out = iso(fullYear(+monthFirst[3]!), m, +monthFirst[2]!);
      if (out) return { value: out, fit: 0.95 };
    }
  }

  // A date with no year is not a date. Say nothing rather than assume.
  return null;
}

export interface TimeRead {
  /** HH:MM, 24-hour. */
  value: string;
  fit: number;
}

export function readTime(raw: string): TimeRead | null {
  const text = normalize(raw);
  const m = text.match(/\b(\d{1,2})[:.](\d{2})(?::(\d{2}))?\s*(AM|PM)?\b/);
  if (!m) return null;

  let h = +m[1]!;
  const min = +m[2]!;
  const meridiem = m[4];

  if (min > 59) return null;
  if (meridiem === 'PM' && h < 12) h += 12;
  if (meridiem === 'AM' && h === 12) h = 0;
  if (h > 23) return null;

  return {
    value: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`,
    // Without AM/PM a 12-hour clock is genuinely ambiguous. Time never feeds
    // pay, so this is recorded rather than agonised over.
    fit: meridiem ? 1 : 0.85,
  };
}

/** Split a line into whitespace-separated tokens, punctuation trimmed. */
export function tokens(raw: string): string[] {
  return normalize(raw)
    .split(/[\s|]+/)
    .map((t) => t.replace(/^[.,;:*]+|[.,;:*]+$/g, ''))
    .filter((t) => t.length > 0);
}

/** Levenshtein-free similarity, good enough for label matching. */
export function tokenOverlap(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}
