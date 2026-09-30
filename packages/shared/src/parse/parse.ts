/**
 * The scale ticket parser.
 *
 * This is what replaced the vision model. It runs on the phone, in about 40
 * milliseconds, on text an on-device OCR engine already produced for free.
 *
 * The design constraint that shapes everything below: **it must be worse than
 * the model in a visible way rather than a plausible one.** A vision model
 * that misreads a ticket hands back a confident, well-formed, wrong number. A
 * parser that misreads one usually finds no label, or finds a value that fails
 * a shape test, and says null — which routes to a person. So every rule here
 * prefers "I did not find it" to "here is my best effort", and confidence is
 * built up from evidence rather than assumed and then discounted.
 *
 * How a field gets a value, in order of preference:
 *
 *   1. a label on the same line, value after it        — "NET WT 21.34"
 *   2. a label with the value to its right             — two columns
 *   3. a label with the value directly beneath it      — a column header
 *   4. a shape heuristic with no label at all          — capped at 0.70, so
 *                                                        it can never clear
 *                                                        the floors alone
 *
 * Where the ceiling comes from: PAY_CRITICAL_FLOOR in validation.ts is 0.95.
 * A field that reaches that had a strong label, a clean numeric token, no
 * character repairs, and — for the weights — three numbers that agree with
 * each other. Anything less goes in front of a reviewer, which is the whole
 * point of the review step existing.
 */

import {
  HEADER_NOISE,
  LABELS,
  MONEY_MARKERS,
  TICKET_MARKERS,
  UNIT_TOKENS,
  type LabelSpec,
} from './lexicon';
import {
  normalize,
  normalizeLabel,
  readDate,
  readNumber,
  readTime,
  tokens,
} from './text';
import {
  boxBottom,
  boxCenterY,
  boxRight,
  type Box,
  type FieldName,
  type FieldTrace,
  type OcrLine,
  type OcrResult,
  type ParseOutput,
  type ParsedTicket,
} from './types';

/** A heuristic match can never clear the floors on its own. Deliberate. */
const HEURISTIC_CEILING = 0.7;

/** Nothing is ever certain. 0.99 leaves room to mean "as good as it gets". */
const CEILING = 0.99;

/** How much of a line height counts as "the same row" for a right-hand value. */
const ROW_TOLERANCE = 0.7;

/** How far below a label to look for its value, in line heights. */
const BELOW_REACH = 1.8;

interface Prepared {
  index: number;
  raw: string;
  norm: string;
  label: string;
  box: Box;
  conf: number;
  hasMoney: boolean;
}

interface Candidate {
  text: string;
  line: Prepared;
  how: 'label_same_line' | 'label_right' | 'label_below';
  proximity: number;
  spec: LabelSpec;
}

interface Hit<T> {
  value: T;
  confidence: number;
  trace: FieldTrace;
  /** Kept for the weight pass, which decides units across all three at once. */
  raw?: number;
  unit?: 'lb' | 'ton' | 'cy' | null;
}

export function parseScaleTicket(ocr: OcrResult): ParseOutput {
  const lines = prepare(ocr.lines);
  const fullText = lines.map((l) => l.raw).join('\n');
  const upper = normalize(fullText);
  const trace: FieldTrace[] = [];
  const notes: string[] = [];

  // --- the straightforward fields ----------------------------------------

  const ticketNumber = best(lines, 'ticket_number', readTicketNumber);
  const date = best(lines, 'tag_date', (text) => {
    const d = readDate(text);
    return d ? { value: d.value, fit: d.fit } : null;
  });
  const time = best(lines, 'tag_time', (text) => {
    const t = readTime(text);
    return t ? { value: t.value, fit: t.fit } : null;
  });

  const quarry = best(lines, 'quarry_text', readFreeText) ?? headerQuarry(lines);
  const material = best(lines, 'material_text', readFreeText);
  const job = best(lines, 'job_text', readJob);
  const truck = best(lines, 'truck_number', readIdentifier);

  // --- weights, decided together ------------------------------------------
  // Units, magnitude sanity and the arithmetic check all need to see all three
  // at once, so they are read raw here and resolved in one pass below.

  const grossHit = best(lines, 'gross_tons', readWeight);
  const tareHit = best(lines, 'tare_tons', readWeight);
  const netHit = best(lines, 'net_tons', readWeight);

  const weights = resolveWeights(grossHit, tareHit, netHit, upper, notes);

  // --- assemble ------------------------------------------------------------

  for (const h of [ticketNumber, date, time, quarry, material, job, truck]) {
    if (h) trace.push(h.trace);
  }
  trace.push(...weights.trace);

  // Anything a reviewer would want to know that has no field of its own.
  for (const line of lines) {
    if (/\b(VOID|CORRECTED|REPRINT|DUPLICATE|AMENDED|REWEIGH)\b/.test(line.norm)) {
      notes.push(`Ticket is marked: ${line.raw.trim()}`);
    }
  }

  const parsed: ParsedTicket = {
    ticket_number: cell(ticketNumber),
    tag_date: cell(date),
    tag_time: cell(time),
    quarry_text: cell(quarry),
    material_text: cell(material),
    job_text: cell(job),
    truck_number: cell(truck),
    gross_tons: weights.gross,
    tare_tons: weights.tare,
    net_tons: weights.net,
    notes: {
      value: notes.length > 0 ? notes.join(' ') : null,
      // Notes are an observation about the parse, not a reading of the ticket.
      // Full confidence in "here is what I noticed" is honest.
      confidence: notes.length > 0 ? 1 : 0,
    },
    is_scale_ticket: looksLikeTicket(upper, weights),
  };

  const confidence: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value && typeof value === 'object' && 'confidence' in value) {
      confidence[key] = round(value.confidence as number);
    }
  }

  return {
    parsed,
    confidence,
    text: fullText,
    trace,
    weightUnit: weights.unit,
  };
}

// ------------------------------------------------------------------ setup

function prepare(lines: OcrLine[]): Prepared[] {
  return lines
    .map((l, index) => {
      const norm = normalize(l.text);
      return {
        index,
        raw: l.text,
        norm,
        label: normalizeLabel(l.text),
        box: l.box,
        conf: clamp(l.confidence, 0, 1),
        hasMoney: MONEY_MARKERS.some((m) => norm.includes(m)),
      };
    })
    .filter((l) => l.norm.length > 0)
    .sort((a, b) =>
      Math.abs(a.box.y - b.box.y) < 0.01 ? a.box.x - b.box.x : a.box.y - b.box.y
    );
}

// -------------------------------------------------------------- label hunt

interface LabelHit {
  spec: LabelSpec;
  /** What is left on the line after the label and its separator. */
  remainder: string;
}

/**
 * Between the words of a label, and between the label and its value, tickets
 * put any of these — or several of them, or none.
 */
const LABEL_GAP = '[\\s.:#*_\\-]';

const LABEL_PATTERNS = new Map<string, RegExp>();

/**
 * `NET WT` becomes /(^|[^A-Z0-9])NET[\s.:#*_-]+WT(?![A-Z])/ — tolerant of the
 * punctuation between the words, strict about the boundaries either side.
 *
 * The boundaries are what stop "SUBNET" matching NET and "GROSSLY" matching
 * GROSS. Compiled once per label and cached, because this runs a few hundred
 * times per ticket on a phone.
 */
function labelPattern(label: string): RegExp {
  let re = LABEL_PATTERNS.get(label);
  if (!re) {
    const parts = label.split(' ').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    re = new RegExp(`(^|[^A-Z0-9])(${parts.join(`${LABEL_GAP}+`)})(?![A-Z])`);
    LABEL_PATTERNS.set(label, re);
  }
  return re;
}

/**
 * Find the strongest label for `field` on this line, and return what follows.
 *
 * The remainder is taken from the *unmodified* normalised text, not from a
 * punctuation-stripped copy. That distinction is load-bearing: stripping `.`
 * to make labels match turns `48.32` into `48 32`, and the parser then reads
 * a ticket for forty-eight tons instead of forty-eight point three two.
 *
 * Longest label wins within a field, which is why LABELS is ordered
 * longest-first — "NET WT" beats "NET" on the same line.
 */
function labelOn(line: Prepared, field: FieldName): LabelHit | null {
  for (const spec of LABELS[field]) {
    const m = labelPattern(spec.label).exec(line.norm);
    if (!m) continue;

    const end = m.index + m[1]!.length + m[2]!.length;
    const remainder = line.norm.slice(end).replace(/^[\s.:#*_\-]+/, '').trim();
    return { spec, remainder };
  }
  return null;
}

function candidates(lines: Prepared[], field: FieldName): Candidate[] {
  const out: Candidate[] = [];

  for (const line of lines) {
    const hit = labelOn(line, field);
    if (!hit) continue;

    // 1. the rest of this line
    if (hit.remainder.length > 0) {
      out.push({
        text: hit.remainder,
        line,
        how: 'label_same_line',
        proximity: 1,
        spec: hit.spec,
      });
    }

    // 2. the nearest thing to the right, on the same row
    const band = line.box.height * ROW_TOLERANCE;
    const right = lines
      .filter(
        (o) =>
          o.index !== line.index &&
          o.box.x >= boxRight(line.box) - line.box.width * 0.1 &&
          Math.abs(boxCenterY(o.box) - boxCenterY(line.box)) <= band
      )
      .sort((a, b) => a.box.x - b.box.x)[0];

    if (right) {
      out.push({
        text: right.norm,
        line: right,
        how: 'label_right',
        // A neighbouring column is nearly as good as the same line, but not
        // quite — a wide gap is how a value from the next field over gets
        // picked up.
        proximity: right.box.x - boxRight(line.box) < 0.15 ? 0.95 : 0.8,
        spec: hit.spec,
      });
    }

    // 3. directly beneath, for column-header layouts
    const below = lines
      .filter(
        (o) =>
          o.index !== line.index &&
          o.box.y > line.box.y &&
          o.box.y - boxBottom(line.box) < line.box.height * BELOW_REACH &&
          overlapX(o.box, line.box) > 0.4
      )
      .sort((a, b) => a.box.y - b.box.y)[0];

    if (below) {
      out.push({
        text: below.norm,
        line: below,
        how: 'label_below',
        proximity: 0.85,
        spec: hit.spec,
      });
    }
  }

  return out;
}

function overlapX(a: Box, b: Box): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(boxRight(a), boxRight(b));
  if (right <= left) return 0;
  return (right - left) / Math.min(a.width, b.width);
}

// ------------------------------------------------------------------ scoring

interface Read<T> {
  value: T;
  fit: number;
  unit?: 'lb' | 'ton' | 'cy' | null;
  raw?: number;
}

/** Try every candidate for a field and keep the best-scoring one. */
function best<T>(
  lines: Prepared[],
  field: FieldName,
  read: (text: string, line: Prepared) => Read<T> | null
): Hit<T> | null {
  let winner: Hit<T> | null = null;

  for (const c of candidates(lines, field)) {
    // A candidate that is itself a label is a column header, not a value. On
    // a two-column ticket the row below a label is the *next* label, and
    // without this the truck number reads as the word PRODUCT.
    if (isPureLabel(c.text)) continue;

    const got = read(c.text, c.line);
    if (!got) continue;

    // A weight read off a line that also mentions money is very likely the
    // quarry's price, not a weight. It stays a candidate — some tickets do put
    // the extension on the same row — but it cannot win against a clean one.
    const moneyPenalty = c.line.hasMoney && isWeight(field) ? 0.35 : 1;

    const parts = {
      ocr: c.line.conf,
      label: c.spec.weight,
      fit: got.fit,
      proximity: c.proximity,
      money: moneyPenalty,
    };

    const score = clamp(
      parts.ocr * parts.label * parts.fit * parts.proximity * parts.money,
      0,
      CEILING
    );

    if (!winner || score > winner.confidence) {
      winner = {
        value: got.value,
        confidence: score,
        raw: got.raw,
        unit: got.unit,
        trace: {
          field,
          label: c.spec.label,
          source: c.line.raw,
          how: c.how,
          confidence: round(score),
          parts,
        },
      };
    }
  }

  return winner;
}

/** Every label the lexicon knows, for the header-versus-value test above. */
const ALL_LABELS: Set<string> = new Set(
  Object.values(LABELS).flatMap((specs) => specs.map((s) => s.label))
);

function isPureLabel(text: string): boolean {
  return ALL_LABELS.has(text.trim());
}

function isWeight(field: FieldName): boolean {
  return field === 'gross_tons' || field === 'tare_tons' || field === 'net_tons';
}

// -------------------------------------------------------------- field reads

/**
 * A ticket number is the longest mostly-numeric token that is not a date, a
 * time, or a weight.
 */
function readTicketNumber(text: string): Read<string> | null {
  for (const token of tokens(text)) {
    const stripped = token.replace(/^[#:]+/, '');
    if (stripped.length < 3 || stripped.length > 16) continue;
    if (/[-/]/.test(stripped) && readDate(stripped)) continue; // that's a date
    if (/^\d{1,2}[:.]\d{2}/.test(stripped)) continue; // that's a time
    if (/\./.test(stripped) && /^\d+\.\d{1,2}$/.test(stripped)) continue; // weight

    const digits = (stripped.match(/\d/g) ?? []).length;
    if (digits < 3) continue;

    // Mostly digits with an optional short alpha prefix — "A-10422", "0245871"
    if (!/^[A-Z]{0,3}[-]?\d[\dA-Z-]*$/.test(stripped)) continue;

    const purity = digits / stripped.replace(/-/g, '').length;
    return { value: stripped, fit: 0.7 + 0.3 * purity };
  }
  return null;
}

/** Free text: a vendor, a material, a project name. */
function readFreeText(text: string): Read<string> | null {
  const cleaned = text.replace(/^[:#\-.\s]+/, '').trim();
  if (cleaned.length < 2) return null;

  // A bare number is not a name. This is what stops "MATERIAL 57" from
  // resolving the material to nothing useful while looking confident.
  const letters = (cleaned.match(/[A-Z]/g) ?? []).length;
  if (letters < 2) return null;
  if (HEADER_NOISE.some((n) => cleaned === n)) return null;

  // Long lines are usually an address or a legal footer that happened to sit
  // under the label, not the name itself.
  const fit = cleaned.length <= 40 ? 1 : 0.6;
  return { value: cleaned.slice(0, 80), fit };
}

/**
 * A truck or unit number: short, alphanumeric, and containing a digit.
 *
 * The digit requirement is what keeps a neighbouring word from becoming a
 * truck number. Fleet numbering is always numeric somewhere — "118", "T-42",
 * "42B" — and a purely alphabetic token in that position is a label, a
 * carrier name, or OCR noise.
 */
function readIdentifier(text: string): Read<string> | null {
  for (const token of tokens(text)) {
    const stripped = token.replace(/^[#:]+/, '');
    if (stripped.length < 1 || stripped.length > 12) continue;
    if (!/^[A-Z0-9][A-Z0-9\-/]*$/.test(stripped)) continue;
    if (!/\d/.test(stripped)) continue;
    if (readDate(stripped)) continue;
    if (UNIT_TOKENS[stripped] !== undefined) continue;

    // A single character is almost always noise from a box edge or a tick.
    const fit = stripped.length >= 2 ? 1 : 0.4;
    return { value: stripped, fit };
  }
  return null;
}

/**
 * A job is either a name or a number, and both are common on the same fleet.
 *
 * "HWY 41 PHASE 2" and "4471" both have to work, so this tries the name first
 * — a name carries more for the reviewer and resolves better against the job
 * alias list — and falls back to a bare identifier.
 */
function readJob(text: string): Read<string> | null {
  const letters = (text.match(/[A-Z]/g) ?? []).length;
  return letters >= 2 ? readFreeText(text) : readIdentifier(text);
}

/**
 * A weight, plus whatever unit was printed beside it.
 *
 * Returns the number exactly as printed. Converting to tons needs all three
 * weights, so it happens in `resolveWeights`.
 */
function readWeight(text: string): Read<number> | null {
  const ts = tokens(text);

  for (let i = 0; i < ts.length; i++) {
    const num = readNumber(ts[i]!);
    if (!num || num.value <= 0) continue;

    // The unit is the next token, or glued to the end of this one.
    let unit: 'lb' | 'ton' | 'cy' | null = null;
    const next = ts[i + 1];
    if (next && UNIT_TOKENS[next] !== undefined) unit = UNIT_TOKENS[next]!;

    const glued = ts[i]!.match(/([A-Z#]+)$/);
    if (!unit && glued && UNIT_TOKENS[glued[1]!] !== undefined) {
      unit = UNIT_TOKENS[glued[1]!]!;
    }

    return { value: num.value, raw: num.value, unit, fit: num.fit };
  }
  return null;
}

// ------------------------------------------------------------- weight pass

interface WeightResult {
  gross: { value: number | null; confidence: number };
  tare: { value: number | null; confidence: number };
  net: { value: number | null; confidence: number };
  unit: 'lb' | 'ton' | null;
  trace: FieldTrace[];
}

/**
 * Decide the unit, convert, and let the three numbers vote on each other.
 *
 * The arithmetic check is the single most valuable thing in this file. Three
 * numbers that agree to within a hundredth of a ton were almost certainly all
 * read correctly; if one digit had been misread they would not. That is a real
 * verification, not a heuristic, and it is what lets a deterministic parser
 * reach the 0.95 floor that pay-critical fields are held to.
 */
function resolveWeights(
  grossHit: Hit<number> | null,
  tareHit: Hit<number> | null,
  netHit: Hit<number> | null,
  upperText: string,
  notes: string[]
): WeightResult {
  const trace: FieldTrace[] = [];
  for (const h of [grossHit, tareHit, netHit]) if (h) trace.push(h.trace);

  const printed = [grossHit?.raw, tareHit?.raw, netHit?.raw].filter(
    (v): v is number => typeof v === 'number'
  );

  // --- what unit is this ticket in? --------------------------------------
  const explicit = [grossHit?.unit, tareHit?.unit, netHit?.unit].filter(
    (u): u is 'lb' | 'ton' | 'cy' => u === 'lb' || u === 'ton' || u === 'cy'
  );

  let unit: 'lb' | 'ton' | null = null;
  let unitFit = 1;

  if (explicit.includes('cy')) {
    // Cubic yards. Density varies by material by enough that a fixed factor
    // would be a guess with a dollar sign attached, so this goes to a person.
    notes.push(
      'This ticket appears to be measured in cubic yards, not tons. Someone needs to confirm the tonnage.'
    );
    unit = null;
    unitFit = 0.3;
  } else if (explicit.includes('lb')) {
    unit = 'lb';
  } else if (explicit.includes('ton')) {
    unit = 'ton';
  } else if (printed.length > 0) {
    // No unit printed anywhere. Magnitude decides: a loaded truck is 60,000-
    // 90,000 lb or 30-45 tons, and those ranges do not overlap.
    const largest = Math.max(...printed);
    if (largest >= 1000) {
      unit = 'lb';
    } else if (largest <= 200) {
      unit = 'ton';
    } else {
      // 200-1000 is neither. Something was misread; do not pick a side.
      unit = null;
      unitFit = 0.4;
      notes.push(
        `Weights read as ${printed.join(', ')} — too large for tons and too small for pounds. Check the photo.`
      );
    }

    if (unit === 'lb' && !upperText.includes('LB') && !upperText.includes('#')) {
      // Inferred from magnitude with nothing on the ticket confirming it.
      unitFit = 0.9;
    }
  }

  const toTons = (v: number | undefined): number | null => {
    if (typeof v !== 'number') return null;
    if (unit === null) return null;
    return unit === 'lb' ? round2(v / 2000) : round2(v);
  };

  if (unit === 'lb' && printed.length > 0) {
    notes.push('Weights were printed in pounds and converted to tons.');
  }

  let gross = toTons(grossHit?.raw);
  let tare = toTons(tareHit?.raw);
  let net = toTons(netHit?.raw);

  let gConf = (grossHit?.confidence ?? 0) * unitFit;
  let tConf = (tareHit?.confidence ?? 0) * unitFit;
  let nConf = (netHit?.confidence ?? 0) * unitFit;

  // --- the three numbers check each other ---------------------------------
  if (gross !== null && tare !== null && net !== null) {
    const drift = Math.abs(gross - tare - net);

    if (drift <= 0.05) {
      // They agree. This is genuine independent confirmation of all three, and
      // it is the only route by which this parser reaches the pay-critical
      // floor. Nothing else here is allowed to.
      gConf = clamp(gConf * 1.2, 0, CEILING);
      tConf = clamp(tConf * 1.2, 0, CEILING);
      nConf = clamp(nConf * 1.2, 0, CEILING);
    } else {
      // They disagree, so at least one is wrong and there is no way to tell
      // which. All three drop hard, and the note says what was found so the
      // reviewer is not left comparing numbers themselves.
      gConf *= 0.5;
      tConf *= 0.5;
      nConf *= 0.5;
      notes.push(
        `Gross minus tare is ${round2(gross - tare)} t but net reads ${net} t — off by ${round2(drift)} t.`
      );
    }

    // A tare heavier than the gross is a swapped pair, not a small error.
    if (tare > gross) {
      notes.push('Tare reads heavier than gross. The two may be swapped.');
      gConf *= 0.4;
      tConf *= 0.4;
    }
  } else if (gross !== null && tare !== null && net === null) {
    // Deliberately NOT computed. Gross minus tare is what the ticket says net
    // should be, not what it says net is — and net is the number that gets
    // paid. A reviewer types it from the photo, which takes three seconds and
    // keeps a machine's arithmetic out of a financial record.
    notes.push(
      `Net was not readable. Gross minus tare would be ${round2(gross - tare)} t — confirm against the photo.`
    );
  }

  // Two fields reading the same number usually means one label found the other
  // field's value.
  if (gross !== null && net !== null && gross === net) {
    gConf *= 0.5;
    nConf *= 0.5;
    notes.push('Gross and net read as the same number.');
  }

  return {
    gross: { value: gross, confidence: round(gConf) },
    tare: { value: tare, confidence: round(tConf) },
    net: { value: net, confidence: round(nConf) },
    unit,
    trace,
  };
}

// --------------------------------------------------------------- fallbacks

/**
 * The quarry name when no label found it.
 *
 * Scale tickets put the vendor's name at the top in the largest type on the
 * page, which is a shape the geometry can find even when the words mean
 * nothing to the lexicon. Capped at the heuristic ceiling, so it always lands
 * in front of a reviewer — but a reviewer with the right answer already typed
 * in, and one correction teaches learn_alias() the vendor's printed name for
 * every future ticket.
 */
function headerQuarry(lines: Prepared[]): Hit<string> | null {
  const header = lines.filter(
    (l) =>
      l.box.y < 0.25 &&
      l.norm.length >= 4 &&
      (l.norm.match(/[A-Z]/g) ?? []).length >= 3 &&
      !HEADER_NOISE.some((n) => l.norm.includes(n))
  );
  if (header.length === 0) return null;

  // Biggest type wins; ties go to whatever is highest on the page.
  const chosen = header.sort(
    (a, b) => b.box.height - a.box.height || a.box.y - b.box.y
  )[0]!;

  const score = clamp(chosen.conf * 0.8, 0, HEURISTIC_CEILING);

  return {
    value: chosen.raw.trim().slice(0, 80),
    confidence: score,
    trace: {
      field: 'quarry_text',
      label: null,
      source: chosen.raw,
      how: 'heuristic',
      confidence: round(score),
      parts: { ocr: chosen.conf, heuristic: 0.8 },
    },
  };
}

/**
 * Is this a scale ticket at all, or a photo of a thumb?
 *
 * Used only to route to review, never to reject. A wrong "no" costs a driver a
 * pointless retake, so the bar is low on purpose.
 */
function looksLikeTicket(upper: string, weights: WeightResult): boolean {
  const found = TICKET_MARKERS.filter((m) =>
    new RegExp(`\\b${m}\\b`).test(upper)
  ).length;

  const weightsRead =
    [weights.gross.value, weights.tare.value, weights.net.value].filter(
      (v) => v !== null
    ).length;

  return found >= 3 || weightsRead >= 2;
}

// ----------------------------------------------------------------- helpers

function cell<T>(hit: Hit<T> | null): { value: T | null; confidence: number } {
  return hit
    ? { value: hit.value, confidence: round(hit.confidence) }
    : { value: null, confidence: 0 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
