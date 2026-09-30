/**
 * On-device ticket reading.
 *
 * The canonical implementation lives here, in TypeScript, for three reasons:
 * the office console runs it directly in the browser; it is the only version
 * that can be unit-tested against fixtures without a device in the room; and
 * the Swift and Kotlin ports were written from it line by line, so when a
 * label is added it is added here first and then in the other two.
 *
 *   Swift:  ios/TagSnap/Sources/OCR/ScaleTicketParser.swift
 *   Kotlin: android/app/src/main/java/com/tagsnap/ocr/ScaleTicketParser.kt
 *
 * All three must produce the same fields and the same confidences on the same
 * text. `packages/shared/test/parse.test.ts` is the shared conformance suite —
 * the fixtures in it are duplicated into the Swift and Kotlin test targets.
 */

export * from './types';
export * from './lexicon';
export * from './text';
export * from './parse';

import { parseScaleTicket } from './parse';
import type { EngineId, OcrResult } from './types';

/**
 * Everything `apply_extraction()` in 010_ondevice_ocr.sql expects, in one
 * object. Built here rather than at each call site so the three clients cannot
 * drift on the shape of the payload.
 */
export interface ExtractionPayload {
  p_tag_id: string;
  p_extracted: Record<string, unknown>;
  p_confidence: Record<string, number>;
  p_engine: EngineId;
  p_engine_version: string;
  p_ocr_text: string;
  p_ocr_ms: number;
  p_raw: Record<string, unknown>;
}

export function buildExtractionPayload(
  tagId: string,
  ocr: OcrResult
): ExtractionPayload {
  const out = parseScaleTicket(ocr);

  return {
    p_tag_id: tagId,
    p_extracted: out.parsed as unknown as Record<string, unknown>,
    p_confidence: out.confidence,
    p_engine: ocr.engine,
    p_engine_version: ocr.engineVersion,
    p_ocr_text: out.text,
    p_ocr_ms: Math.round(ocr.ms),
    // The trace is what makes a wrong field debuggable six weeks later: it
    // records which line on the ticket each value came from and why it scored
    // what it scored. Small, and it rides in a jsonb column nothing indexes.
    p_raw: {
      trace: out.trace,
      weight_unit: out.weightUnit,
      line_count: ocr.lines.length,
    },
  };
}

/**
 * Is there enough here to be worth submitting at all?
 *
 * A blank wall, a thumb over the lens, or a photo taken in the dark produces
 * two or three garbage lines. Sending that through `apply_extraction` would
 * file a reading of nothing; `extraction_failed()` is the right call instead,
 * and it puts the photo in front of a person with an honest explanation.
 */
export function isWorthSubmitting(ocr: OcrResult): boolean {
  const text = ocr.lines.map((l) => l.text).join(' ');
  return ocr.lines.length >= 4 && text.replace(/\s/g, '').length >= 30;
}
