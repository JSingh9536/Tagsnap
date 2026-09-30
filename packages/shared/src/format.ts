/**
 * Display helpers. Shared so a driver and the office see a status spelled
 * exactly the same way — ambiguity here generates phone calls.
 */

import type { PayeeType, RescanReason, TagStatus, UserRole } from './types';

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

export function formatTons(tons: number | null | undefined): string {
  if (tons === null || tons === undefined) return '—';
  return `${Number(tons).toFixed(2)} t`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * What the field crew is told a status means.
 *
 * Deliberately written from their point of view: "we are reading it" rather
 * than "extracted". They do not care what the pipeline calls its stages, only
 * whether their money is moving.
 */
export const DRIVER_STATUS_LABEL: Record<TagStatus, string> = {
  queued: 'Waiting for signal',
  uploaded: 'Sent',
  extracted: 'Being read',
  needs_review: 'With the office',
  rescan_requested: 'Rescan needed',
  ready: 'With the office',
  approved: 'Approved',
  invoiced: 'On your invoice',
  rejected: 'Rejected',
};

/** The office wants the real pipeline stage, because they act on it. */
export const OFFICE_STATUS_LABEL: Record<TagStatus, string> = {
  queued: 'On device',
  uploaded: 'Uploaded',
  extracted: 'Extracted',
  needs_review: 'Needs review',
  rescan_requested: 'Awaiting rescan',
  ready: 'Ready to approve',
  approved: 'Approved',
  invoiced: 'Invoiced',
  rejected: 'Rejected',
};

export type StatusTone = 'pending' | 'attention' | 'good' | 'bad';

export const STATUS_TONE: Record<TagStatus, StatusTone> = {
  queued: 'pending',
  uploaded: 'pending',
  extracted: 'pending',
  needs_review: 'attention',
  rescan_requested: 'attention',
  ready: 'pending',
  approved: 'good',
  invoiced: 'good',
  rejected: 'bad',
};

export const RESCAN_REASON_LABEL: Record<RescanReason, string> = {
  unreadable: "Can't read it",
  cropped: 'Part of the ticket is cut off',
  wrong_document: 'Not a scale ticket',
  missing_fields: 'A needed field is missing',
  duplicate_check: 'Possible duplicate',
  other: 'Other',
};

/** What the driver is told to do about each reason — not what went wrong. */
export const RESCAN_REASON_INSTRUCTION: Record<RescanReason, string> = {
  unreadable:
    'Retake it in better light. Hold the ticket flat and keep your shadow off it.',
  cropped: 'Retake it with all four corners of the ticket inside the frame.',
  wrong_document: 'That was not a scale ticket. Photograph the ticket for this load.',
  missing_fields: 'Retake it so the whole ticket is visible, including the margins.',
  duplicate_check:
    'This looks like a ticket already submitted. Retake it, or reply to the office if it is a separate load.',
  other: 'Retake the photo. See the note from the office.',
};

export const ROLE_LABEL: Record<UserRole, string> = {
  driver: 'Driver',
  subhauler: 'Subhauler',
  office: 'Office',
  admin: 'Admin',
};

export const PAYEE_LABEL: Record<PayeeType, string> = {
  employee_driver: 'Company driver',
  subhauler: 'Subhauler',
};

/** What the payee is owed against — a settlement, or a vendor payable. */
export const PAYEE_LEDGER_LABEL: Record<PayeeType, string> = {
  employee_driver: 'Driver settlement',
  subhauler: 'Subhauler payable',
};

/** Which portal a role signs into. Used to catch a wrong-portal sign-in. */
export function portalForRole(role: UserRole): 'driver' | 'subhauler' | 'office' {
  if (role === 'subhauler') return 'subhauler';
  if (role === 'driver') return 'driver';
  return 'office';
}

export function payeeForRole(role: UserRole): PayeeType {
  return role === 'subhauler' ? 'subhauler' : 'employee_driver';
}
