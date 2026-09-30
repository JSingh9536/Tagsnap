/**
 * The contract between an OCR engine and the ticket parser.
 *
 * Three engines feed this: Apple Vision on iOS, ML Kit on Android, and
 * Tesseract in the office console. They disagree about almost everything —
 * coordinate origin, whether confidence exists, whether words are exposed —
 * so each adapter normalises into this shape and the parser sees one thing.
 *
 * Geometry is normalised to 0..1 with the origin at the TOP LEFT, y growing
 * downward, in the orientation the ticket is read in. Apple's Vision returns
 * bottom-left origin and ML Kit returns pixels; both adapters convert. Getting
 * this wrong silently inverts "the line below" into "the line above", which is
 * the single most likely way a port of this parser goes wrong.
 */

export interface Box {
  /** Left edge, 0..1 from the left of the image. */
  x: number;
  /** Top edge, 0..1 from the top of the image. */
  y: number;
  width: number;
  height: number;
}

export function boxRight(b: Box): number {
  return b.x + b.width;
}

export function boxBottom(b: Box): number {
  return b.y + b.height;
}

export function boxCenterY(b: Box): number {
  return b.y + b.height / 2;
}

export interface OcrLine {
  text: string;
  box: Box;
  /**
   * 0..1. Engines that do not report per-line confidence pass 1 and let the
   * parser's own pattern scoring carry the whole signal — which is the right
   * default, because a made-up confidence is worse than an absent one.
   */
  confidence: number;
}

export type EngineId =
  | 'apple_vision'
  | 'mlkit'
  | 'tesseract'
  | 'office_manual'
  | 'quarry_feed';

export interface OcrResult {
  lines: OcrLine[];
  engine: EngineId;
  /** Engine build string, recorded so an accuracy regression is attributable. */
  engineVersion: string;
  /** Wall-clock milliseconds the recognition took on the device. */
  ms: number;
}

/** The fields the parser fills. Mirrors ExtractedTag in ../types.ts. */
export type FieldName =
  | 'ticket_number'
  | 'tag_date'
  | 'tag_time'
  | 'quarry_text'
  | 'material_text'
  | 'job_text'
  | 'truck_number'
  | 'gross_tons'
  | 'tare_tons'
  | 'net_tons'
  | 'notes';

/**
 * Why a field ended up with the value it has.
 *
 * Kept because a parser nobody can debug is a parser nobody will trust enough
 * to raise the confidence floors on. This rides along in `model_raw`, so when
 * a reviewer corrects a field the office can see exactly which line on the
 * ticket the wrong value came from.
 */
export interface FieldTrace {
  field: FieldName;
  /** The label text that anchored the match, or null for a heuristic hit. */
  label: string | null;
  /** The raw OCR text the value was taken from. */
  source: string | null;
  /** 'label_same_line' | 'label_right' | 'label_below' | 'heuristic' | 'none' */
  how: string;
  confidence: number;
  /** Each multiplier that produced the confidence, for tuning. */
  parts?: Record<string, number>;
}

export interface ParsedField<T> {
  value: T | null;
  confidence: number;
}

export interface ParsedTicket {
  ticket_number: ParsedField<string>;
  tag_date: ParsedField<string>;
  tag_time: ParsedField<string>;
  quarry_text: ParsedField<string>;
  material_text: ParsedField<string>;
  job_text: ParsedField<string>;
  truck_number: ParsedField<string>;
  gross_tons: ParsedField<number>;
  tare_tons: ParsedField<number>;
  net_tons: ParsedField<number>;
  notes: ParsedField<string>;
  is_scale_ticket: boolean;
}

export interface ParseOutput {
  parsed: ParsedTicket;
  confidence: Record<string, number>;
  /** Everything the engine recognised, joined by newlines. Stored on the tag. */
  text: string;
  trace: FieldTrace[];
  /** 'lb' | 'ton' | null — what the weights were printed in, once decided. */
  weightUnit: 'lb' | 'ton' | null;
}
