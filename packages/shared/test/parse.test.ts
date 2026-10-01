/**
 * Conformance suite for the ticket parser.
 *
 * Run with `npm run test --workspace @tagsnap/shared`. Node strips the types
 * and runs it directly; there is no build step and no test framework to
 * install, because a test suite that needs a toolchain is a test suite that
 * stops being run.
 *
 * These fixtures are the contract. The Swift and Kotlin ports carry the same
 * cases in their own test targets, and all three must agree on both the values
 * and the confidence bands — not the exact confidences, which will drift as
 * the lexicon grows, but which side of the floors in validation.ts they land
 * on. That is the thing that decides whether a human sees the ticket.
 *
 * Layouts covered, because these are the four shapes real tickets come in:
 *
 *   label: value      on one line
 *   label | value     in two columns
 *   label above value under a column header
 *   no label at all   — the header block, and the free-text fields
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseScaleTicket } from '../src/parse/parse';
import { buildExtractionPayload, isWorthSubmitting } from '../src/parse/index';
import type { OcrLine, OcrResult } from '../src/parse/types';
import { CONFIDENCE_FLOOR, PAY_CRITICAL_FLOOR } from '../src/validation';

// --------------------------------------------------------------- fixtures

/**
 * Build an OcrResult from a rough page layout.
 *
 * A row is either one full-width line or a list of columns. Boxes are laid out
 * the way a scale ticket actually is — evenly spaced rows, columns sharing the
 * width — which is enough geometry for the same-row and directly-below rules
 * to be exercised properly rather than merely satisfied.
 */
function page(rows: (string | string[])[], confidence = 0.95): OcrResult {
  const lines: OcrLine[] = [];
  const rowHeight = 0.9 / (rows.length + 1);

  rows.forEach((row, r) => {
    const cells = Array.isArray(row) ? row : [row];
    const cellWidth = 0.92 / cells.length;

    cells.forEach((text, c) => {
      if (text.length === 0) return;
      lines.push({
        text,
        confidence,
        box: {
          x: 0.04 + c * cellWidth,
          y: 0.04 + r * rowHeight,
          // Roughly proportional to the text, capped inside its column.
          width: Math.min(cellWidth * 0.95, 0.012 * text.length),
          height: rowHeight * 0.6,
        },
      });
    });
  });

  return { lines, engine: 'apple_vision', engineVersion: 'test', ms: 40 };
}

/** The common case: one vendor, one line per field, weights in tons. */
const CLEAN_TONS = page([
  'VULCAN MATERIALS COMPANY',
  'GRANITE QUARRY - PLANT 0412',
  'SCALE TICKET NO 0245871',
  'DATE 08/25/2026    TIME 09:14 AM',
  'TRUCK NO 118',
  'MATERIAL 57 CRUSHED STONE',
  'JOB NO 4471',
  'GROSS WT 78.42 TON',
  'TARE WT 30.10 TON',
  'NET WT 48.32 TON',
]);

/** The other common case: pounds, and a two-column layout. */
const CLEAN_POUNDS = page([
  'MARTIN MARIETTA AGGREGATES',
  ['TICKET NO', '118422'],
  ['DATE', '03/04/26'],
  ['TRUCK', 'T-42'],
  ['PRODUCT', 'ASPHALT BASE 19MM'],
  ['PROJECT', 'HWY 41 PHASE 2'],
  ['GROSS WEIGHT', '76,480 LB'],
  ['TARE WEIGHT', '30,120 LB'],
  ['NET WEIGHT', '46,360 LB'],
]);

// ------------------------------------------------------------------ tests

test('a clean ticket in tons reads every field', () => {
  const { parsed, confidence } = parseScaleTicket(CLEAN_TONS);

  assert.equal(parsed.ticket_number.value, '0245871');
  assert.equal(parsed.tag_date.value, '2026-08-25');
  assert.equal(parsed.tag_time.value, '09:14');
  assert.equal(parsed.truck_number.value, '118');
  assert.equal(parsed.gross_tons.value, 78.42);
  assert.equal(parsed.tare_tons.value, 30.1);
  assert.equal(parsed.net_tons.value, 48.32);
  assert.equal(parsed.is_scale_ticket, true);

  assert.match(String(parsed.material_text.value), /CRUSHED STONE/);
  assert.equal(parsed.job_text.value, '4471');

  // Net tonnage is what gets paid, so it is the one field that has to clear
  // the higher bar on a ticket this clean. If this assertion ever fails, every
  // ticket goes to a reviewer and the app is a camera with extra steps.
  assert.ok(
    confidence.net_tons! >= PAY_CRITICAL_FLOOR,
    `net_tons confidence ${confidence.net_tons} is under the pay-critical floor`
  );
  assert.ok(confidence.ticket_number! >= CONFIDENCE_FLOOR);
});

test('pounds are converted to tons, and the conversion is disclosed', () => {
  const { parsed } = parseScaleTicket(CLEAN_POUNDS);

  assert.equal(parsed.gross_tons.value, 38.24);
  assert.equal(parsed.tare_tons.value, 15.06);
  assert.equal(parsed.net_tons.value, 23.18);
  assert.match(String(parsed.notes.value), /pounds/i);
});

test('values in a second column are found', () => {
  const { parsed, trace } = parseScaleTicket(CLEAN_POUNDS);

  assert.equal(parsed.ticket_number.value, '118422');
  assert.equal(parsed.truck_number.value, 'T-42');
  assert.equal(parsed.tag_date.value, '2026-03-04');

  const net = trace.find((t) => t.field === 'net_tons');
  assert.equal(net?.how, 'label_right');
});

test('a column-header layout puts the value under the label', () => {
  const { parsed, trace } = parseScaleTicket(
    page([
      'ACME SAND AND GRAVEL',
      'TICKET 55901   DATE 01/09/2026',
      ['GROSS', 'TARE', 'NET'],
      ['80,140', '31,200', '48,940'],
      'MATERIAL CLASS 5 BASE',
    ])
  );

  assert.equal(parsed.gross_tons.value, 40.07);
  assert.equal(parsed.tare_tons.value, 15.6);
  assert.equal(parsed.net_tons.value, 24.47);

  const net = trace.find((t) => t.field === 'net_tons');
  assert.equal(net?.how, 'label_below');
});

test('weights that disagree drop below the pay-critical floor', () => {
  // 78.42 - 30.10 is 48.32, not 43.82. A transposition, which is exactly the
  // error the arithmetic check exists to catch.
  const { parsed, confidence } = parseScaleTicket(
    page([
      'VULCAN MATERIALS COMPANY',
      'TICKET NO 0245871',
      'DATE 08/25/2026',
      'GROSS WT 78.42 TON',
      'TARE WT 30.10 TON',
      'NET WT 43.82 TON',
    ])
  );

  assert.equal(parsed.net_tons.value, 43.82);
  assert.ok(
    confidence.net_tons! < PAY_CRITICAL_FLOOR,
    'a ticket whose weights contradict each other must not be trusted'
  );
  assert.match(String(parsed.notes.value), /off by/i);
});

test('the price line is not mistaken for a weight', () => {
  const { parsed } = parseScaleTicket(
    page([
      'GRANITE ROCK CO',
      'TICKET NO 771204',
      'DATE 11/02/2026',
      'GROSS WT 74,220 LB',
      'TARE WT 29,980 LB',
      'NET WT 44,240 LB',
      'NET AMOUNT DUE $ 486.64',
      'RATE PER TON $ 22.00',
    ])
  );

  // 486.64 sits on a line labelled NET. Taking it would hand a reviewer a
  // plausible wrong tonnage, which is worse than handing them nothing.
  assert.equal(parsed.net_tons.value, 22.12);
});

test('a date with no year is not a date', () => {
  const { parsed } = parseScaleTicket(
    page([
      'PIONEER AGGREGATE',
      'TICKET NO 4410',
      'DATE 08/25',
      'GROSS 61,400 LB',
      'TARE 30,000 LB',
      'NET 31,400 LB',
    ])
  );

  assert.equal(parsed.tag_date.value, null);
  assert.equal(parsed.tag_date.confidence, 0);
});

test('cubic yards are detected and never converted', () => {
  const { parsed } = parseScaleTicket(
    page([
      'RIVERBEND SAND',
      'TICKET NO 9912',
      'DATE 06/14/2026',
      'MATERIAL FILL SAND',
      'NET QTY 12.0 CY',
    ])
  );

  assert.equal(parsed.net_tons.value, null);
  assert.match(String(parsed.notes.value), /cubic yards/i);
});

test('a photo of nothing is not a scale ticket', () => {
  const { parsed } = parseScaleTicket(page(['BLURRY', 'IMG 4471']));
  assert.equal(parsed.is_scale_ticket, false);
  assert.equal(parsed.net_tons.value, null);
});

test('the vendor name is guessed from the header, but never confidently', () => {
  const { parsed, trace } = parseScaleTicket(
    page([
      'CAPITOL AGGREGATES INC',
      'TICKET NO 30021',
      'DATE 02/02/2026',
      'GROSS 70,000 LB',
      'TARE 30,000 LB',
      'NET 40,000 LB',
    ])
  );

  assert.equal(parsed.quarry_text.value, 'CAPITOL AGGREGATES INC');

  const q = trace.find((t) => t.field === 'quarry_text');
  assert.equal(q?.how, 'heuristic');

  // A guess from page position must always reach a person. If this ever
  // cleared the floor, a wrongly resolved quarry would price the load against
  // another vendor's rate without anybody looking.
  assert.ok(parsed.quarry_text.confidence <= 0.7);
});

test('characters repaired into digits cost confidence', () => {
  // "NET WT 4S.32" — the S is a 5. Repairable, but not for free.
  const clean = parseScaleTicket(
    page(['TICKET NO 1001', 'DATE 05/05/2026', 'NET WT 45.32 TON'])
  );
  const damaged = parseScaleTicket(
    page(['TICKET NO 1001', 'DATE 05/05/2026', 'NET WT 4S.32 TON'])
  );

  assert.equal(damaged.parsed.net_tons.value, 45.32);
  assert.ok(
    damaged.confidence.net_tons! < clean.confidence.net_tons!,
    'a repaired digit must reduce confidence'
  );
});

test('gross and net reading the same number is flagged', () => {
  const { parsed } = parseScaleTicket(
    page([
      'TICKET NO 8080',
      'DATE 07/07/2026',
      'GROSS WT 44.00 TON',
      'TARE WT 30.00 TON',
      'NET WT 44.00 TON',
    ])
  );

  assert.match(String(parsed.notes.value), /same number/i);
  assert.ok(parsed.net_tons.confidence < PAY_CRITICAL_FLOOR);
});

test('net is never computed from gross minus tare', () => {
  const { parsed } = parseScaleTicket(
    page([
      'TICKET NO 6060',
      'DATE 09/09/2026',
      'GROSS WT 72.00 TON',
      'TARE WT 30.00 TON',
    ])
  );

  // The number is stated in the notes for the reviewer's benefit and left out
  // of the field, because a machine's arithmetic must not become the figure
  // somebody is paid on.
  assert.equal(parsed.net_tons.value, null);
  assert.match(String(parsed.notes.value), /42/);
});

test('a ticket marked VOID says so in the notes', () => {
  const { parsed } = parseScaleTicket(
    page([
      'TICKET NO 2020',
      'VOID - REWEIGH',
      'DATE 04/04/2026',
      'NET WT 20.00 TON',
    ])
  );
  assert.match(String(parsed.notes.value), /VOID/);
});

test('the payload matches what apply_extraction expects', () => {
  const payload = buildExtractionPayload(
    '11111111-2222-3333-4444-555555555555',
    CLEAN_TONS
  );

  assert.equal(payload.p_engine, 'apple_vision');
  assert.equal(typeof payload.p_ocr_text, 'string');
  assert.ok(payload.p_ocr_text.includes('VULCAN'));
  assert.equal(typeof payload.p_ocr_ms, 'number');

  // The server's agreement check reads confidence off the top level and the
  // value out of `{field,value}`. Both shapes have to be right or every tag
  // lands in review with `no_ocr_text`.
  const extracted = payload.p_extracted as Record<string, { value: unknown }>;
  assert.equal(extracted.net_tons!.value, 48.32);
  assert.equal(typeof payload.p_confidence.net_tons, 'number');
});

test('an empty read is refused before it is submitted', () => {
  assert.equal(isWorthSubmitting(page(['A', 'B'])), false);
  assert.equal(isWorthSubmitting(CLEAN_TONS), true);
});

// ------------------------------------------- worse handwriting, same safety
//
// Handwriting varies a lot and the OCR text gets messier than a dot-matrix
// print. These lock in two things at once: the parser reads more of that mess
// correctly, and it still refuses to invent a value rather than guess one.

test('letters standing in for digits are read across all three weights', () => {
  // Heavy OCR damage on every weight, but the three still agree arithmetically:
  // 7B.42 -> 78.42, 3O.1O -> 30.10, 4B.32 -> 48.32, and 78.42 - 30.10 = 48.32.
  const { parsed } = parseScaleTicket(
    page([
      'VULCAN MATERIALS COMPANY',
      'TICKET NO 0245871',
      'DATE 08/25/2026',
      'GROSS WT 7B.42 TON',
      'TARE WT 3O.1O TON',
      'NET WT 4B.32 TON',
    ])
  );

  assert.equal(parsed.gross_tons.value, 78.42);
  assert.equal(parsed.tare_tons.value, 30.1);
  assert.equal(parsed.net_tons.value, 48.32);
  // The output shape a reviewer and the server depend on is unchanged.
  assert.equal(parsed.is_scale_ticket, true);
});

test('a crossed 7 read as T and an open 4 read as A are repaired in a weight', () => {
  const t = parseScaleTicket(
    page(['TICKET NO 1', 'DATE 05/05/2026', 'NET WT T7.50 TON'])
  );
  assert.equal(t.parsed.net_tons.value, 77.5); // T -> 7

  const a = parseScaleTicket(
    page(['TICKET NO 1', 'DATE 05/05/2026', 'NET WT A1.20 TON'])
  );
  assert.equal(a.parsed.net_tons.value, 41.2); // A -> 4
});

test('a T-for-7 repair costs confidence, like any repair', () => {
  const clean = parseScaleTicket(
    page(['TICKET NO 1', 'DATE 05/05/2026', 'NET WT 71.50 TON'])
  );
  const damaged = parseScaleTicket(
    page(['TICKET NO 1', 'DATE 05/05/2026', 'NET WT T1.50 TON'])
  );

  assert.equal(damaged.parsed.net_tons.value, 71.5);
  assert.ok(
    damaged.confidence.net_tons! < clean.confidence.net_tons!,
    'a repaired digit must still weaken the field, even a handwriting one'
  );
});

test('a token of only look-alike letters is never read as a weight', () => {
  // TOA is three digit-look-alike letters (T, O, A) with no actual digit. It
  // must stay null rather than become a plausible number — null over guess.
  const { parsed } = parseScaleTicket(
    page(['TICKET NO 9', 'DATE 05/05/2026', 'NET WT TOA TON'])
  );
  assert.equal(parsed.net_tons.value, null);
});
