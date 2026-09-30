import { supabase, FUNCTIONS_URL, accessToken } from './supabase';
import type {
  Invoice,
  InvoiceStatus,
  Job,
  Material,
  PayeeType,
  PricePreview,
  Profile,
  Quarry,
  RateBookRow,
  RatePreview,
  RateUnit,
  RescanReason,
  Subhauler,
  Tag,
  TagWithRelations,
  Truck,
} from '@tagsnap/shared';

const TAG_SELECT = `
  *,
  tag_images ( * ),
  rescan_requests ( * ),
  quarries ( id, name ),
  materials ( id, name, code ),
  jobs ( id, name, number ),
  trucks ( id, number, legal_capacity_tons, avg_tare_tons ),
  submitter:profiles!tags_created_by_fkey ( id, full_name, role ),
  subhaulers ( id, name )
`;

export type QueueFilter = 'all' | 'needs_review' | 'ready' | 'rescan_requested';
export type PayeeFilter = 'all' | 'employee_driver' | 'subhauler';

export async function fetchQueue(
  status: QueueFilter,
  payee: PayeeFilter
): Promise<TagWithRelations[]> {
  let q = supabase
    .from('tags')
    .select(TAG_SELECT)
    .in('status', [
      'uploaded',
      'extracted',
      'needs_review',
      'ready',
      'rescan_requested',
    ]);

  if (status !== 'all') q = q.eq('status', status);
  if (payee !== 'all') q = q.eq('payee_type', payee);

  const { data, error } = await q.order('created_at', { ascending: true }).limit(200);
  if (error) throw new Error(error.message);

  // Blocking work first, oldest within each band. Sorted here rather than in
  // the query because PostgREST cannot express the CASE ordering, and at 200
  // rows the client sort costs nothing.
  const rank: Record<string, number> = {
    needs_review: 0,
    ready: 1,
    rescan_requested: 2,
  };
  return ((data ?? []) as unknown as TagWithRelations[]).sort(
    (a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3)
  );
}

export async function fetchTag(id: string): Promise<TagWithRelations> {
  const { data, error } = await supabase
    .from('tags')
    .select(TAG_SELECT)
    .eq('id', id)
    .single();

  if (error) throw new Error(error.message);
  return data as unknown as TagWithRelations;
}

/**
 * Save a reviewer's corrections.
 *
 * Deliberately narrow: the reviewer may fix what the tag says, not who it pays
 * or what it is worth. `computed_pay_cents` and `matched_rate_id` are set by
 * approve_tag() from the rate table and nowhere else, so a typo in this form
 * can never become a payment amount.
 */
export type Correction = Partial<
  Pick<
    Tag,
    | 'ticket_number'
    | 'tag_date'
    | 'quarry_id'
    | 'material_id'
    | 'job_id'
    | 'truck_id'
    | 'gross_tons'
    | 'tare_tons'
    | 'net_tons'
    | 'review_notes'
  >
>;

export async function saveCorrection(
  id: string,
  patch: Correction
): Promise<TagWithRelations> {
  const { error } = await supabase.from('tags').update(patch).eq('id', id);
  if (error) throw new Error(friendly(error));

  // Re-run the same controls the extractor ran, so a hand-corrected tag is
  // held to exactly the rules an automatically-read one was.
  await supabase.rpc('validate_tag', { p_tag_id: id });

  return fetchTag(id);
}

/**
 * Teach the system a vendor's spelling.
 *
 * Called when a reviewer picks the right quarry for text that did not match.
 * The raw OCR text joins that entity's alias list, and the next ticket from
 * the same vendor resolves on its own.
 */
export async function learnAlias(
  kind: 'quarry' | 'material' | 'job',
  entityId: string,
  rawText: string
): Promise<void> {
  const { error } = await supabase.rpc('learn_alias', {
    p_kind: kind,
    p_entity_id: entityId,
    p_raw_text: rawText,
  });
  if (error) throw new Error(error.message);
}

export async function priceTag(id: string): Promise<PricePreview> {
  const { data, error } = await supabase.rpc('price_tag', { p_tag_id: id });
  if (error) throw new Error(error.message);
  return data as PricePreview;
}

/**
 * Approve.
 *
 * The one action that turns a suggestion into a financial record. Everything
 * that matters about it — separation of duties, the rate lookup, the pay
 * calculation, the freeze — happens inside the database function, in one
 * transaction. There is no version of this that a client could get wrong.
 */
export async function approveTag(id: string): Promise<TagWithRelations> {
  const { error } = await supabase.rpc('approve_tag', { p_tag_id: id });
  if (error) throw new Error(friendly(error));
  return fetchTag(id);
}

/**
 * Send it back to the field for a new photo.
 *
 * The reason is not bookkeeping — it is what the driver reads on their camera
 * screen. A vague one produces a second identical bad photo.
 */
export async function requestRescan(
  tagId: string,
  reason: RescanReason,
  note: string | null,
  priorImageId: string | null
): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Signed out.');

  const { error } = await supabase.from('rescan_requests').insert({
    tag_id: tagId,
    requested_by: auth.user.id,
    reason,
    note,
    prior_image_id: priorImageId,
  });

  // The trigger in 003 moves the tag to 'rescan_requested' from here, so the
  // status and the request can never disagree.
  if (error) throw new Error(friendly(error));
}

export async function cancelRescan(requestId: string): Promise<void> {
  const { error } = await supabase
    .from('rescan_requests')
    .update({ cancelled_at: new Date().toISOString() })
    .eq('id', requestId);
  if (error) throw new Error(friendly(error));
}

export async function rejectTag(id: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from('tags')
    .update({ status: 'rejected', rejected_reason: reason })
    .eq('id', id);
  if (error) throw new Error(friendly(error));
}

/*
 * There is deliberately no "read it again" here any more.
 *
 * Reading happens on the device that took the photo — Apple Vision or ML Kit,
 * on-device and free — so there is no server-side reader for the console to
 * ask a second time. When a reading is wrong the console does the thing that
 * was always going to happen anyway: a person corrects the field with the
 * photo beside them, and `learnAlias` teaches the resolver the vendor's
 * printed name so the next ticket from them lands clean.
 *
 * If a photo genuinely cannot be read, the reviewer sends it back for a
 * rescan. That is a better answer than re-running the same reader on the same
 * pixels and expecting a different result.
 */

export async function signedImageUrl(path: string): Promise<string> {
  const token = await accessToken();
  if (!token) throw new Error('Signed out.');

  const res = await fetch(`${FUNCTIONS_URL}/sign-image`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
  });

  if (!res.ok) throw new Error('Could not load the photo.');
  const body = (await res.json()) as { url: string };
  return body.url;
}

export interface ReferenceData {
  quarries: Quarry[];
  materials: Material[];
  jobs: Job[];
  trucks: Truck[];
}

export async function fetchReferenceData(): Promise<ReferenceData> {
  const [quarries, materials, jobs, trucks] = await Promise.all([
    supabase.from('quarries').select('*').eq('active', true).order('name'),
    supabase.from('materials').select('*').eq('active', true).order('name'),
    supabase.from('jobs').select('*').eq('active', true).order('name'),
    supabase.from('trucks').select('*').eq('active', true).order('number'),
  ]);

  return {
    quarries: (quarries.data ?? []) as Quarry[],
    materials: (materials.data ?? []) as Material[],
    jobs: (jobs.data ?? []) as Job[],
    trucks: (trucks.data ?? []) as Truck[],
  };
}

export function currentImage(tag: TagWithRelations) {
  return tag.tag_images?.find((i) => i.is_current) ?? null;
}

export function openRescan(tag: TagWithRelations) {
  return (
    tag.rescan_requests?.find((r) => !r.resolved_at && !r.cancelled_at) ?? null
  );
}

/**
 * Database errors, translated.
 *
 * The constraint names in 001 are precise and mean nothing to a person in an
 * office. Each of these corresponds to a control that just did its job, so the
 * message says what the control caught rather than which constraint fired.
 */
function friendly(error: { message: string; code?: string }): string {
  const m = error.message;

  if (m.includes('no_duplicate_ticket')) {
    return 'That ticket number already exists for this quarry. Check whether this load was submitted twice.';
  }
  if (m.includes('approver_is_not_submitter') || m.includes('separation of duties')) {
    return 'You submitted this tag, so you cannot approve it. Someone else has to.';
  }
  if (m.includes('weights_are_consistent')) {
    return 'Gross minus tare does not equal net. Fix the weights before saving.';
  }
  if (m.includes('already approved')) {
    return 'This tag is already approved and is now immutable. A correction goes on the next period as a reversing entry.';
  }
  if (m.includes('no rate on file')) {
    return 'No rate on file for this driver, quarry, material and date. Add the rate before approving.';
  }
  if (m.includes('rescan is still outstanding')) {
    return 'A rescan is still outstanding. Cancel it or wait for the new photo.';
  }
  if (m.includes('payee_target_is_consistent')) {
    return 'This load is billed to a subhauler but no outfit is set on it.';
  }
  if (m.includes('missing fields required to price')) {
    return 'Fill in the date, quarry, and net tonnage before approving.';
  }
  if (m.includes('has not finished yet')) {
    return 'That period has not finished yet. Pick an end date on or before today.';
  }
  if (m.includes('ends before it starts')) {
    return 'The end date is before the start date.';
  }
  if (m.includes('already') && m.includes('invoice')) {
    return 'That invoice has already been issued. Void it first, or close the next period instead.';
  }
  if (m.includes('refusing to issue an invoice for zero')) {
    return 'That invoice has no lines on it. Nothing to issue.';
  }
  if (m.includes('use a reversing entry')) {
    return 'That invoice is already paid. Money that has left needs a reversing entry on the next period, not a void.';
  }
  if (m.includes('voiding an invoice needs a reason')) {
    return 'Voiding an invoice needs a reason — it is recorded permanently.';
  }
  return m;
}

/* ------------------------------------------------------- period close ---- */

export interface ClosePreviewRow {
  payee_type: PayeeType;
  payee_id: string;
  payee_name: string;
  loads: number;
  total_tons: number;
  total_cents: number;
  already_invoiced: boolean;
}

export interface CloseResultRow {
  invoice_id: string;
  payee_name: string;
  loads: number;
  total_cents: number;
}

export interface InvoiceSummary extends Invoice {
  payee_name: string;
  line_count: number;
  total_tons: number;
}

/**
 * What a close would produce, without producing it.
 *
 * Read before every close. A close that surprises somebody gets reversed, and
 * reversing one costs far more than reading a table first did.
 */
export async function previewClose(
  start: string,
  end: string,
  payeeType: PayeeType | null
): Promise<ClosePreviewRow[]> {
  const { data, error } = await supabase.rpc('preview_close', {
    p_start: start,
    p_end: end,
    p_payee_type: payeeType,
  });
  if (error) throw new Error(friendly(error));
  return (data ?? []) as ClosePreviewRow[];
}

export async function closePeriod(
  start: string,
  end: string,
  payeeType: PayeeType | null
): Promise<CloseResultRow[]> {
  const { data, error } = await supabase.rpc('close_period', {
    p_start: start,
    p_end: end,
    p_payee_type: payeeType,
  });
  if (error) throw new Error(friendly(error));
  return (data ?? []) as CloseResultRow[];
}

export async function fetchInvoices(): Promise<InvoiceSummary[]> {
  const { data, error } = await supabase
    .from('invoice_summary')
    .select('*')
    .order('period_start', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as InvoiceSummary[];
}

export async function issueInvoice(id: string): Promise<void> {
  const { error } = await supabase.rpc('issue_invoice', { p_invoice_id: id });
  if (error) throw new Error(friendly(error));
}

export async function voidInvoice(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_invoice', {
    p_invoice_id: id,
    p_reason: reason,
  });
  if (error) throw new Error(friendly(error));
}

export async function markInvoicePaid(id: string): Promise<void> {
  const { error } = await supabase
    .from('invoices')
    .update({ status: 'paid' satisfies InvoiceStatus })
    .eq('id', id);
  if (error) throw new Error(friendly(error));
}

// ------------------------------------------------------------- the rate book
//
// Rates are the one thing on this console that changes what people are paid
// *in future* rather than recording what happened. That difference drives the
// shape of everything below: reads come from the `rate_book` view so the
// screen and the pricer agree about specificity, and every write that touches
// an existing row goes through a database function rather than a bare update.

export interface RateTargets {
  drivers: Pick<Profile, 'id' | 'full_name'>[];
  subhaulers: Pick<Subhauler, 'id' | 'name'>[];
}

/** Who a rate can be scoped to. Reference data comes from fetchReferenceData. */
export async function fetchRateTargets(): Promise<RateTargets> {
  const [drivers, subhaulers] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, full_name')
      .eq('role', 'driver')
      .eq('active', true)
      .order('full_name'),
    supabase
      .from('subhaulers')
      .select('id, name')
      .eq('active', true)
      .order('name'),
  ]);

  return {
    drivers: (drivers.data ?? []) as Pick<Profile, 'id' | 'full_name'>[],
    subhaulers: (subhaulers.data ?? []) as Pick<Subhauler, 'id' | 'name'>[],
  };
}

/**
 * The whole book, most specific first.
 *
 * Ordered the way `app.match_rate` resolves — specificity descending, then
 * effective_from descending — so reading down the list is reading the same
 * decision the pricer makes. A rate screen sorted alphabetically would be
 * easier to build and would teach the wrong mental model.
 */
export async function fetchRateBook(): Promise<RateBookRow[]> {
  const { data, error } = await supabase
    .from('rate_book')
    .select('*')
    .order('payee_type')
    .order('specificity', { ascending: false })
    .order('effective_from', { ascending: false });

  if (error) throw new Error(friendly(error));
  return (data ?? []) as RateBookRow[];
}

export interface RateDraft {
  payee_type: PayeeType;
  driver_id: string | null;
  subhauler_id: string | null;
  quarry_id: string | null;
  material_id: string | null;
  job_id: string | null;
  unit: RateUnit;
  rate_cents: number;
  effective_from: string;
  effective_to: string | null;
}

export async function createRate(
  companyId: string,
  draft: RateDraft
): Promise<void> {
  const { error } = await supabase.from('rates').insert({
    company_id: companyId,
    ...draft,
    source_row: 'entered in the office console',
  });
  if (error) throw new Error(friendly(error));
}

/**
 * Correct a rate in place.
 *
 * Only offered by the screen when `loads_priced` is zero. A row that has
 * already priced a settlement is history, and the operation for those is
 * `supersedeRate`. The database does not enforce that distinction — an admin
 * can rewrite any row, and the audit trigger in 003 records it either way —
 * but the console should not make the wrong thing the easy thing.
 */
export async function updateRate(
  id: string,
  draft: RateDraft
): Promise<void> {
  const { error } = await supabase.from('rates').update(draft).eq('id', id);
  if (error) throw new Error(friendly(error));
}

/**
 * Raise or lower a rate from a date. One transaction, no gap, no overlap.
 *
 * See supersede_rate() in 012 for why this is not two client-side writes.
 */
export async function supersedeRate(
  id: string,
  rateCents: number,
  from: string
): Promise<void> {
  const { error } = await supabase.rpc('supersede_rate', {
    p_rate_id: id,
    p_rate_cents: rateCents,
    p_from: from,
  });
  if (error) throw new Error(friendly(error));
}

/** Stop a rate applying, without replacing it. */
export async function endRate(id: string, on: string): Promise<void> {
  const { error } = await supabase.rpc('end_rate', {
    p_rate_id: id,
    p_on: on,
  });
  if (error) throw new Error(friendly(error));
}

/**
 * Which rate would win for a hypothetical load, and what it would pay.
 *
 * Runs the same `app.match_rate` the pricer uses rather than reimplementing
 * "most specific wins" in TypeScript. Two implementations of that rule would
 * disagree eventually, and the screen disagreeing with the settlement is the
 * worst place for it to happen.
 */
export async function previewRate(input: {
  payee_type: PayeeType;
  driver_id?: string | null;
  subhauler_id?: string | null;
  quarry_id?: string | null;
  material_id?: string | null;
  job_id?: string | null;
  on: string;
  net_tons?: number | null;
}): Promise<RatePreview> {
  const { data, error } = await supabase.rpc('preview_rate', {
    p_payee_type: input.payee_type,
    p_driver: input.driver_id ?? null,
    p_subhauler: input.subhauler_id ?? null,
    p_quarry: input.quarry_id ?? null,
    p_material: input.material_id ?? null,
    p_job: input.job_id ?? null,
    p_date: input.on,
    p_net_tons: input.net_tons ?? null,
  });

  if (error) throw new Error(friendly(error));
  return data as RatePreview;
}
