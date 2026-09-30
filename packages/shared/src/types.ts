/**
 * Types shared by the mobile app and the office console.
 *
 * These mirror supabase/migrations/001_schema.sql. When the schema changes,
 * change this file in the same commit — it is the only thing keeping the two
 * clients honest about what a tag actually is.
 */

export type UserRole = 'driver' | 'subhauler' | 'office' | 'admin';

/**
 * Who the money is owed to.
 *
 * This is the axis the whole driver/subhauler split turns on. An employee
 * driver's loads land on a settlement; a subhauler's land on an accounts
 * payable invoice to their outfit. They never share a document.
 */
export type PayeeType = 'employee_driver' | 'subhauler';

export type TagStatus =
  | 'queued'
  | 'uploaded'
  | 'extracted'
  | 'needs_review'
  | 'rescan_requested'
  | 'ready'
  | 'approved'
  | 'invoiced'
  | 'rejected';

export type TagSource =
  | 'driver_photo'
  | 'office_scan'
  | 'email_batch'
  | 'quarry_feed'
  | 'manual';

export type RescanReason =
  | 'unreadable'
  | 'cropped'
  | 'wrong_document'
  | 'missing_fields'
  | 'duplicate_check'
  | 'other';

export type RateUnit = 'ton' | 'load' | 'hour';

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void';

/**
 * What read a tag.
 *
 * There is no paid model in this list any more. Apple Vision and ML Kit both
 * run on the device, offline, at no cost per ticket; `office_manual` is
 * somebody typing it in from the photo; `quarry_feed` never involved a picture
 * at all and is the only one whose numbers came off the vendor's own scale.
 */
export type ExtractionEngine =
  | 'apple_vision'
  | 'mlkit'
  | 'tesseract'
  | 'office_manual'
  | 'quarry_feed';

export type VerificationSource =
  | 'extraction'
  | 'second_pass'
  | 'dispatch'
  | 'gps'
  | 'truck_tare_history'
  | 'quarry_invoice'
  | 'arithmetic'
  | 'human';

export interface Profile {
  id: string;
  company_id: string;
  role: UserRole;
  full_name: string;
  phone: string | null;
  email: string | null;
  subhauler_id: string | null;
  active: boolean;
  created_at: string;
}

export interface Subhauler {
  id: string;
  company_id: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  vendor_ref: string | null;
  active: boolean;
}

export interface Quarry {
  id: string;
  company_id: string;
  name: string;
  aliases: string[];
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
}

export interface Material {
  id: string;
  company_id: string;
  code: string | null;
  name: string;
  aliases: string[];
  active: boolean;
}

export interface Job {
  id: string;
  company_id: string;
  number: string | null;
  name: string;
  customer: string | null;
  aliases: string[];
  active: boolean;
}

export interface Truck {
  id: string;
  company_id: string;
  number: string;
  default_driver_id: string | null;
  subhauler_id: string | null;
  legal_capacity_tons: number | null;
  avg_tare_tons: number | null;
  active: boolean;
}

/** One field as the vision model returned it, with its own confidence. */
export interface ExtractedField<T> {
  value: T | null;
  confidence: number;
}

/**
 * The extraction schema the model must fill.
 *
 * The model is instructed to return null rather than guess: a null routes to
 * human review, whereas a hallucinated tonnage silently overpays someone.
 */
export interface ExtractedTag {
  ticket_number: ExtractedField<string>;
  tag_date: ExtractedField<string>;
  tag_time: ExtractedField<string>;
  quarry_text: ExtractedField<string>;
  material_text: ExtractedField<string>;
  job_text: ExtractedField<string>;
  truck_number: ExtractedField<string>;
  gross_tons: ExtractedField<number>;
  tare_tons: ExtractedField<number>;
  net_tons: ExtractedField<number>;
  notes: ExtractedField<string>;
}

export type ExtractedFieldName = keyof ExtractedTag;

export interface TagImage {
  id: string;
  tag_id: string;
  version: number;
  image_path: string;
  image_phash: number | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  captured_at: string | null;
  captured_lat: number | null;
  captured_lng: number | null;
  uploaded_by: string;
  uploaded_at: string;
  is_current: boolean;
}

export interface RescanRequest {
  id: string;
  tag_id: string;
  requested_by: string;
  requested_at: string;
  reason: RescanReason;
  note: string | null;
  prior_image_id: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  new_image_id: string | null;
  cancelled_at: string | null;
}

export interface Tag {
  id: string;
  company_id: string;
  created_by: string;
  created_at: string;
  source: TagSource;
  status: TagStatus;

  payee_type: PayeeType;
  driver_id: string | null;
  subhauler_id: string | null;

  extracted: ExtractedTag | null;
  confidence: Record<string, number> | null;
  model_raw: unknown | null;
  model_version: string | null;
  extracted_at: string | null;

  /** Which reader produced `extracted`. See 010_ondevice_ocr.sql. */
  engine: ExtractionEngine | null;
  engine_version: string | null;
  /**
   * Everything the OCR engine recognised, verbatim.
   *
   * Stored because it is cheap and it is what lets a reviewer find a ticket by
   * any word printed on it, including the ones the parser has no field for.
   * It is also the evidence for the server-side agreement check — a value the
   * client claims to have read confidently had better appear in here.
   */
  ocr_text: string | null;
  /** Milliseconds the device spent recognising. Watched for regressions. */
  ocr_ms: number | null;

  ticket_number: string | null;
  tag_date: string | null;
  quarry_id: string | null;
  material_id: string | null;
  job_id: string | null;
  truck_id: string | null;
  gross_tons: number | null;
  tare_tons: number | null;
  net_tons: number | null;

  matched_rate_id: string | null;
  computed_pay_cents: number | null;

  review_reasons: string[];
  review_notes: string | null;
  rescan_count: number;
  approved_by: string | null;
  approved_at: string | null;
  rejected_reason: string | null;
  invoice_id: string | null;
}

/**
 * A tag joined with the bits a screen needs in one round trip.
 *
 * `submitter` is optional because the field app deliberately does not select
 * it — a driver has no business enumerating who else files tags, and the RLS
 * policy on `profiles` would refuse the join anyway.
 */
export interface TagWithRelations extends Tag {
  tag_images: TagImage[];
  rescan_requests: RescanRequest[];
  quarries: Pick<Quarry, 'id' | 'name'> | null;
  materials: Pick<Material, 'id' | 'name' | 'code'> | null;
  jobs: Pick<Job, 'id' | 'name' | 'number'> | null;
  trucks: Pick<Truck, 'id' | 'number' | 'legal_capacity_tons' | 'avg_tare_tons'> | null;
  submitter?: Pick<Profile, 'id' | 'full_name' | 'role'> | null;
  subhaulers: Pick<Subhauler, 'id' | 'name'> | null;
}

export interface Rate {
  id: string;
  company_id: string;
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

export interface Invoice {
  id: string;
  company_id: string;
  payee_type: PayeeType;
  driver_id: string | null;
  subhauler_id: string | null;
  period_start: string;
  period_end: string;
  status: InvoiceStatus;
  total_cents: number;
  sheet_url: string | null;
  sheet_tab: string | null;
  generated_at: string | null;
}

/**
 * A row of `rate_book` — the rate table with names joined and usage counted.
 *
 * `loads_priced` is the field the rate screen turns on. Zero means this row
 * has never priced a settlement and can be corrected in place; anything else
 * means money was calculated from it and the honest operation is to supersede
 * it rather than rewrite history.
 */
export interface RateBookRow extends Rate {
  driver_name: string | null;
  subhauler_name: string | null;
  quarry_name: string | null;
  material_name: string | null;
  job_name: string | null;
  loads_priced: number;
  in_force: boolean;
  /** How many matching columns are set. app.match_rate orders by this. */
  specificity: number;
}

/** What preview_rate() returns — which rate would win, and what it would pay. */
export interface RatePreview {
  rate_id: string | null;
  matched: boolean;
  unit?: RateUnit;
  rate_cents?: number;
  effective_from?: string;
  effective_to?: string | null;
  specificity?: number;
  pay_cents?: number | null;
  /** Set when there is something the screen should say out loud. */
  why?: string | null;
}

/** What price_tag() returns — a preview, before anything is committed. */
export interface PricePreview {
  rate_id: string | null;
  unit: RateUnit | null;
  rate_cents: number | null;
  net_tons: number | null;
  pay_cents: number | null;
  payee_type: PayeeType;
}
