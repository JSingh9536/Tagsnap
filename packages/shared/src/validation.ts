/**
 * The controls from Trucktags/docs/ARCHITECTURE.md section 6, as pure
 * functions.
 *
 * `validate_tag()` in supabase/migrations/005_resolution.sql is the
 * authoritative version — it decides what status a tag actually lands in, and
 * it runs where a client cannot skip it. This is the same rule set, expressed
 * the same way, so the office console can show a reviewer live feedback on
 * unsaved edits without a round trip. Keeping the two in one shared file is
 * what stops them drifting into disagreeing about the rules.
 *
 * Note what is NOT here, and never should be: the duplicate-ticket check and
 * separation of duties. Those are database constraints, because a check that
 * runs in a client is a check that can be skipped by not using the client.
 */

import type { ExtractedTag, Tag, Truck } from './types';

/** Any field below this forces a human look. */
export const CONFIDENCE_FLOOR = 0.9;

/**
 * Fields that feed the pay calculation are held to a higher bar. A misread
 * job name is an annoyance; a misread net tonnage is a wrong payment.
 */
export const PAY_CRITICAL_FLOOR = 0.95;

export const PAY_CRITICAL_FIELDS = [
  'net_tons',
  'material_text',
  'quarry_text',
  'job_text',
] as const;

/** gross - tare must equal net within this many tons. */
export const WEIGHT_TOLERANCE = 0.05;

/** How far back a tag may be dated before it needs a deliberate exception. */
export const MAX_TAG_AGE_DAYS = 45;

export interface ReviewReason {
  code: string;
  field: string | null;
  /** Shown verbatim to the reviewer, so it says what to do, not what failed. */
  message: string;
}

export interface ValidationInput {
  extracted: ExtractedTag | null;
  tag: Partial<Tag>;
  truck?: Pick<Truck, 'legal_capacity_tons' | 'avg_tare_tons'> | null;
  /** Defaults to today; injectable so tests are not time-dependent. */
  now?: Date;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

/**
 * Every reason a tag should not sail through unlooked-at. An empty array means
 * the automated controls all passed — which makes the tag `ready`, not
 * `approved`. A human still puts their name on it.
 */
export function validateTag(input: ValidationInput): ReviewReason[] {
  const { extracted, tag, truck } = input;
  const now = input.now ?? new Date();
  const reasons: ReviewReason[] = [];

  // --- confidence floors -------------------------------------------------
  if (extracted) {
    for (const [field, cell] of Object.entries(extracted)) {
      const conf = num((cell as { confidence?: unknown })?.confidence);
      const value = (cell as { value?: unknown })?.value;

      if (value === null || value === undefined) {
        // A null is the model declining to guess, which is the behaviour we
        // asked for. `notes` being empty is normal and not worth flagging.
        if (field !== 'notes' && field !== 'tag_time') {
          reasons.push({
            code: 'field_missing',
            field,
            message: `The model could not read ${label(field)}.`,
          });
        }
        continue;
      }

      const isCritical = (PAY_CRITICAL_FIELDS as readonly string[]).includes(field);
      const floor = isCritical ? PAY_CRITICAL_FLOOR : CONFIDENCE_FLOOR;

      if (conf !== null && conf < floor) {
        reasons.push({
          code: 'low_confidence',
          field,
          message:
            `${label(field)} was read with ${(conf * 100).toFixed(0)}% ` +
            `confidence, below the ${(floor * 100).toFixed(0)}% bar` +
            (isCritical ? ' for fields that affect pay.' : '.'),
        });
      }
    }
  }

  // --- arithmetic --------------------------------------------------------
  // Free, and it catches most digit errors on its own: three fields checking
  // each other with no external data.
  const gross = num(tag.gross_tons);
  const tare = num(tag.tare_tons);
  const net = num(tag.net_tons);

  if (gross !== null && tare !== null && net !== null) {
    const drift = Math.abs(gross - tare - net);
    if (drift > WEIGHT_TOLERANCE) {
      reasons.push({
        code: 'weights_disagree',
        field: 'net_tons',
        message:
          `Gross minus tare is ${(gross - tare).toFixed(2)} t but the ticket ` +
          `says net is ${net.toFixed(2)} t — off by ${drift.toFixed(2)} t. ` +
          `At least one number was misread.`,
      });
    }
  }

  // --- impossible loads --------------------------------------------------
  // Also catches transcription errors like 223.2 for 22.32.
  const capacity = num(truck?.legal_capacity_tons);
  if (net !== null && capacity !== null && net > capacity) {
    reasons.push({
      code: 'over_capacity',
      field: 'net_tons',
      message:
        `${net.toFixed(2)} t exceeds this truck's legal capacity of ` +
        `${capacity.toFixed(2)} t.`,
    });
  }

  if (net !== null && net <= 0) {
    reasons.push({
      code: 'non_positive_net',
      field: 'net_tons',
      message: 'Net tonnage must be greater than zero.',
    });
  }

  // --- tare against this truck's own history -----------------------------
  // Tare barely changes. A tare far off the running average is either a
  // misread or something genuinely worth knowing about.
  const avgTare = num(truck?.avg_tare_tons);
  if (tare !== null && avgTare !== null && Math.abs(tare - avgTare) > 0.5) {
    reasons.push({
      code: 'tare_unusual',
      field: 'tare_tons',
      message:
        `Tare of ${tare.toFixed(2)} t is off this truck's usual ` +
        `${avgTare.toFixed(2)} t.`,
    });
  }

  // --- dates -------------------------------------------------------------
  if (tag.tag_date) {
    const d = new Date(`${tag.tag_date}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) {
      reasons.push({
        code: 'bad_date',
        field: 'tag_date',
        message: 'The ticket date could not be understood.',
      });
    } else {
      const age = daysBetween(now, d);
      if (age < -1) {
        reasons.push({
          code: 'future_date',
          field: 'tag_date',
          message: 'The ticket is dated in the future.',
        });
      } else if (age > MAX_TAG_AGE_DAYS) {
        reasons.push({
          code: 'stale_date',
          field: 'tag_date',
          message:
            `The ticket is ${age} days old, past the ${MAX_TAG_AGE_DAYS}-day ` +
            `window. Approving it needs a deliberate exception.`,
        });
      }
    }
  } else {
    reasons.push({
      code: 'field_missing',
      field: 'tag_date',
      message: 'No ticket date.',
    });
  }

  // --- resolution --------------------------------------------------------
  if (!tag.quarry_id) {
    reasons.push({
      code: 'quarry_unresolved',
      field: 'quarry_text',
      message: 'The quarry on the ticket does not match any on file.',
    });
  }
  if (!tag.material_id) {
    reasons.push({
      code: 'material_unresolved',
      field: 'material_text',
      message: 'The material on the ticket does not match any on file.',
    });
  }
  if (!tag.ticket_number) {
    reasons.push({
      code: 'field_missing',
      field: 'ticket_number',
      message: 'No ticket number, so this cannot be checked for duplicates.',
    });
  }

  // --- the payee split ---------------------------------------------------
  // Belt and braces against the database constraint. If this ever fires, a
  // client built the row wrong and the insert is about to be rejected anyway.
  if (tag.payee_type === 'subhauler' && !tag.subhauler_id) {
    reasons.push({
      code: 'payee_missing',
      field: null,
      message: 'This load is billed to a subhauler, but no outfit is set.',
    });
  }
  if (tag.payee_type === 'employee_driver' && !tag.driver_id) {
    reasons.push({
      code: 'payee_missing',
      field: null,
      message: 'This load is on the employee ledger, but no driver is set.',
    });
  }

  return reasons;
}

const LABELS: Record<string, string> = {
  ticket_number: 'the ticket number',
  tag_date: 'the ticket date',
  tag_time: 'the ticket time',
  quarry_text: 'the quarry',
  material_text: 'the material',
  job_text: 'the job',
  truck_number: 'the truck number',
  gross_tons: 'gross weight',
  tare_tons: 'tare weight',
  net_tons: 'net tonnage',
  notes: 'the notes',
};

export function label(field: string): string {
  return LABELS[field] ?? field.replace(/_/g, ' ');
}
