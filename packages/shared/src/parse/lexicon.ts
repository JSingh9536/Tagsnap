/**
 * What scale tickets call things.
 *
 * Every quarry prints its own layout, but the vocabulary is small and it has
 * barely changed in forty years, because most of these tickets come off scale
 * software that predates the web. That is what makes a deterministic parser
 * viable here where it would not be on, say, an invoice.
 *
 * Adding a label is the cheapest possible accuracy improvement and it costs
 * nothing at runtime — when the office corrects the same field on the same
 * vendor twice, look at `ocr_text` on those tags and add what it says here.
 *
 * `weight` is how much the label being present should be trusted. An exact
 * "NET WT" is unambiguous; a bare "NET" could be a net price. Ambiguous
 * labels are kept because a weak match still beats no match, but they cannot
 * on their own carry a field past the confidence floor.
 */

import type { FieldName } from './types';

export interface LabelSpec {
  /** Matched against normalised text: uppercase, punctuation stripped. */
  label: string;
  weight: number;
}

/**
 * Longest first within each field. The matcher takes the longest label that
 * fits, so "NET WT" wins over "NET" on a line that says "NET WT 21.34".
 */
export const LABELS: Record<FieldName, LabelSpec[]> = {
  ticket_number: [
    { label: 'SCALE TICKET NO', weight: 1.0 },
    { label: 'WEIGHT TICKET NO', weight: 1.0 },
    { label: 'TRANSACTION NO', weight: 0.95 },
    { label: 'DELIVERY TICKET', weight: 0.95 },
    { label: 'SCALE TICKET', weight: 1.0 },
    { label: 'TICKET NUMBER', weight: 1.0 },
    { label: 'TICKET NO', weight: 1.0 },
    { label: 'TICKET NUM', weight: 1.0 },
    { label: 'TRANS NO', weight: 0.9 },
    { label: 'LOAD NO', weight: 0.85 },
    { label: 'TICKET', weight: 0.95 },
    { label: 'TKT NO', weight: 0.95 },
    { label: 'TRANS', weight: 0.8 },
    { label: 'TKT', weight: 0.9 },
    // A bare "NO." next to a number in the header block is usually the ticket
    // number, but it is also how a job number or a truck number gets printed.
    { label: 'NO', weight: 0.55 },
  ],

  tag_date: [
    { label: 'DATE IN', weight: 0.9 },
    { label: 'DATE OUT', weight: 0.9 },
    { label: 'SHIP DATE', weight: 0.95 },
    { label: 'LOAD DATE', weight: 0.95 },
    { label: 'DATE', weight: 1.0 },
    { label: 'DATED', weight: 0.9 },
  ],

  tag_time: [
    { label: 'TIME IN', weight: 0.9 },
    { label: 'TIME OUT', weight: 0.9 },
    { label: 'TIME', weight: 1.0 },
  ],

  quarry_text: [
    { label: 'SHIPPED FROM', weight: 1.0 },
    { label: 'SHIP FROM', weight: 1.0 },
    { label: 'PLANT NAME', weight: 1.0 },
    { label: 'ORIGIN', weight: 0.95 },
    { label: 'QUARRY', weight: 1.0 },
    { label: 'SOURCE', weight: 0.9 },
    { label: 'PLANT', weight: 0.95 },
    { label: 'SITE', weight: 0.85 },
    { label: 'YARD', weight: 0.8 },
    { label: 'FROM', weight: 0.7 },
  ],

  material_text: [
    { label: 'MATERIAL DESC', weight: 1.0 },
    { label: 'PRODUCT DESC', weight: 1.0 },
    { label: 'DESCRIPTION', weight: 0.85 },
    { label: 'COMMODITY', weight: 0.95 },
    { label: 'MATERIAL', weight: 1.0 },
    { label: 'PRODUCT', weight: 1.0 },
    { label: 'ITEM', weight: 0.8 },
    { label: 'MIX', weight: 0.8 },
    { label: 'DESC', weight: 0.8 },
  ],

  job_text: [
    { label: 'PROJECT NO', weight: 1.0 },
    { label: 'JOB NUMBER', weight: 1.0 },
    { label: 'PURCHASE ORDER', weight: 0.9 },
    { label: 'DELIVER TO', weight: 0.85 },
    { label: 'SHIP TO', weight: 0.85 },
    { label: 'PROJECT', weight: 1.0 },
    { label: 'JOB NO', weight: 1.0 },
    { label: 'JOB', weight: 0.95 },
    { label: 'PO NO', weight: 0.85 },
    { label: 'PO', weight: 0.7 },
  ],

  truck_number: [
    { label: 'TRUCK NO', weight: 1.0 },
    { label: 'VEHICLE NO', weight: 1.0 },
    { label: 'UNIT NO', weight: 0.95 },
    { label: 'TRUCK', weight: 1.0 },
    { label: 'VEHICLE', weight: 0.95 },
    { label: 'HAULER', weight: 0.8 },
    { label: 'CARRIER', weight: 0.75 },
    { label: 'UNIT', weight: 0.85 },
    { label: 'TRK', weight: 0.9 },
  ],

  gross_tons: [
    { label: 'GROSS WEIGHT', weight: 1.0 },
    { label: 'GROSS TONS', weight: 1.0 },
    { label: 'GROSS WT', weight: 1.0 },
    { label: 'GROSS', weight: 0.95 },
    { label: 'GVW', weight: 0.9 },
    { label: 'GR WT', weight: 0.9 },
    { label: 'LOADED', weight: 0.8 },
  ],

  tare_tons: [
    { label: 'TARE WEIGHT', weight: 1.0 },
    { label: 'TARE TONS', weight: 1.0 },
    { label: 'EMPTY WEIGHT', weight: 0.95 },
    { label: 'TARE WT', weight: 1.0 },
    { label: 'TARE', weight: 0.95 },
    { label: 'EMPTY WT', weight: 0.9 },
    { label: 'EMPTY', weight: 0.8 },
    { label: 'TR WT', weight: 0.85 },
  ],

  net_tons: [
    { label: 'NET WEIGHT', weight: 1.0 },
    { label: 'NET TONS', weight: 1.0 },
    { label: 'NET TON', weight: 1.0 },
    { label: 'NET WT', weight: 1.0 },
    { label: 'NET QTY', weight: 0.95 },
    { label: 'QUANTITY', weight: 0.7 },
    { label: 'NET', weight: 0.9 },
    { label: 'TONS', weight: 0.75 },
    { label: 'QTY', weight: 0.7 },
  ],

  // Never label-matched. Assembled from what the parser noticed.
  notes: [],
};

/**
 * Words that mean "this is a scale ticket" rather than a photo of a thumb.
 *
 * Deliberately generous, and it is only ever used to route to review rather
 * than to reject anything — a false negative here would send a good ticket to
 * a person, which costs ten seconds, and there is no false positive that can
 * cost money because nothing here approves anything.
 */
export const TICKET_MARKERS = [
  'SCALE',
  'TICKET',
  'GROSS',
  'TARE',
  'NET',
  'TONS',
  'TON',
  'LBS',
  'QUARRY',
  'AGGREGATE',
  'MATERIAL',
  'PLANT',
  'HAUL',
  'WEIGHT',
  'WT',
  'CY',
];

/**
 * Units, and what they mean in tons.
 *
 * `CY` — cubic yards — is here to be *detected*, not converted. Aggregate
 * density varies enough by material that a fixed factor would be a guess with
 * a dollar sign on it, so a ticket priced in cubic yards routes to a person.
 */
export const UNIT_TOKENS: Record<string, 'lb' | 'ton' | 'cy'> = {
  LB: 'lb',
  LBS: 'lb',
  POUND: 'lb',
  POUNDS: 'lb',
  '#': 'lb',
  T: 'ton',
  TN: 'ton',
  TON: 'ton',
  TONS: 'ton',
  NT: 'ton',
  CY: 'cy',
  CYD: 'cy',
  YD: 'cy',
  YDS: 'cy',
};

/**
 * Header lines that are never the quarry name, even though they sit in the
 * header block where the quarry name usually is.
 */
export const HEADER_NOISE = [
  'SCALE TICKET',
  'WEIGHT TICKET',
  'DELIVERY TICKET',
  'ORIGINAL',
  'DUPLICATE',
  'CUSTOMER COPY',
  'DRIVER COPY',
  'OFFICE COPY',
  'THANK YOU',
  'INVOICE',
  'REMIT TO',
  'PAGE',
];

/**
 * Text that means a number nearby is money rather than weight.
 *
 * This matters more than it looks. The dollar figure on a scale ticket is the
 * quarry billing their customer — it has nothing to do with what we owe a
 * hauler, and a parser that picked it up as a weight would put a plausible
 * wrong number in front of a reviewer, which is the worst kind.
 */
export const MONEY_MARKERS = [
  '$',
  'PRICE',
  'AMOUNT',
  'TOTAL DUE',
  'SUBTOTAL',
  'TAX',
  'RATE',
  'EXT',
  'CHARGE',
  'BALANCE',
  'PER TON',
  'UNIT PRICE',
];
