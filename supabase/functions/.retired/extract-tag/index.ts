import Anthropic from 'npm:@anthropic-ai/sdk@0.68.0';
import {
  authenticate,
  checkQuota,
  finishQuota,
  handleError,
  HttpError,
  json,
  preflight,
  serviceClient,
} from '../_shared/http.ts';
import { dHash } from '../_shared/phash.ts';

/**
 * Read one tag photo and turn it into fields.
 *
 * This is the only place the Claude key exists. The mobile app never calls
 * Anthropic directly — it calls here, and here authenticates the user, checks
 * their quota, and then uses the server-held key. That boundary is what keeps
 * the key off a phone that can be jailbroken and what gives one place to cap
 * spend.
 *
 * Two things this function will not do:
 *
 *   - guess. The model is told to return null for anything it cannot read,
 *     because a null routes to a human and a hallucinated tonnage silently
 *     overpays someone.
 *   - price the load. The dollar figure printed on a scale ticket is the
 *     quarry billing their customer. What we owe a hauler is computed from our
 *     own rate table, in the database, at approval time.
 */

const MODEL = 'claude-opus-5';

/** A normal driver files 10-20 tags a day. Past this is a bug or abuse. */
const EXTRACTIONS_PER_HOUR = 60;

const anthropic = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY')!,
});

/**
 * Every field carries its own confidence, so the validator can hold the ones
 * that affect pay to a higher bar than the ones that do not.
 */
const field = (type: 'string' | 'number') => ({
  type: 'object',
  properties: {
    value: { type: [type, 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['value', 'confidence'],
  additionalProperties: false,
});

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    ticket_number: field('string'),
    tag_date: field('string'),
    tag_time: field('string'),
    quarry_text: field('string'),
    material_text: field('string'),
    job_text: field('string'),
    truck_number: field('string'),
    gross_tons: field('number'),
    tare_tons: field('number'),
    net_tons: field('number'),
    notes: field('string'),
    is_scale_ticket: { type: 'boolean' },
  },
  required: [
    'ticket_number',
    'tag_date',
    'tag_time',
    'quarry_text',
    'material_text',
    'job_text',
    'truck_number',
    'gross_tons',
    'tare_tons',
    'net_tons',
    'notes',
    'is_scale_ticket',
  ],
  additionalProperties: false,
} as const;

const SYSTEM = `You read quarry and asphalt plant scale tickets from photographs.

These are close to a worst case for reading: dot-matrix or thermal print, \
carbon copies, faded ribbon, grease, folds, handwriting in the margin, \
photographed at an angle in a truck cab. Every vendor has its own layout.

Rules, in order of importance:

1. Return null for any field you cannot read with confidence. A null sends the \
ticket to a person, which is cheap. A wrong number becomes a wrong payment, \
which is not. Never infer a value from context, never complete a partially \
visible number, and never carry a value over from a similar ticket.

2. Confidence is your own honest estimate that the value you returned is \
exactly what is printed, character for character. If a digit is ambiguous — \
a 3 that could be an 8, a 6 that could be a 5 — that is low confidence even \
when the rest of the field is clear.

3. Transcribe, do not normalize. Return quarry, material, and job as the text \
that appears on the ticket, including vendor codes and abbreviations. Matching \
that text to our records happens elsewhere.

4. Weights are in tons unless the ticket says otherwise. If it is in pounds, \
convert to tons and say so in notes. Gross is the loaded weight, tare is the \
empty truck, net is the material.

5. Dates as YYYY-MM-DD. If the year is not printed, return null rather than \
assuming the current year.

6. Put anything handwritten, any correction, any stamp, and anything that \
looks altered into notes. Those are exactly what a reviewer needs to see.

7. Set is_scale_ticket false if this is not a scale ticket at all — a photo of \
a thumb, a delivery receipt, a blank page.`;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const origin = req.headers.get('Origin');
  let caller: Awaited<ReturnType<typeof authenticate>> | null = null;

  try {
    caller = await authenticate(req);
    await checkQuota(caller, 'extract', EXTRACTIONS_PER_HOUR);

    const body = (await req.json().catch(() => ({}))) as { tag_id?: string };
    if (!body.tag_id) throw new HttpError(400, 'No tag_id given.');

    const svc = serviceClient();

    const { data: tag } = await svc
      .from('tags')
      .select('*, tag_images(*)')
      .eq('id', body.tag_id)
      .single();

    if (!tag) throw new HttpError(404, 'No such tag.');
    if (tag.company_id !== caller.companyId) {
      throw new HttpError(403, 'Not your company.');
    }
    if (tag.status === 'approved' || tag.status === 'invoiced') {
      throw new HttpError(409, 'That tag is approved and cannot be re-read.');
    }

    const image = (
      tag.tag_images as { id: string; image_path: string; is_current: boolean }[]
    ).find((i) => i.is_current);
    if (!image) throw new HttpError(409, 'That tag has no photo yet.');

    // --- fetch the image ---------------------------------------------------
    const { data: blob, error: dlError } = await svc.storage
      .from('tag-images')
      .download(image.image_path);

    if (dlError || !blob) throw new HttpError(500, 'Could not read the photo.');

    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength > 12 * 1024 * 1024) {
      throw new HttpError(413, 'That photo is too large to read.');
    }

    // --- fingerprint it ----------------------------------------------------
    // Before the paid call, because a re-photograph of an existing ticket is
    // worth knowing about whether or not the read succeeds. Failure to hash is
    // never fatal — it costs one control, not the extraction.
    const media = mediaTypeFor(image.image_path);
    const phash = dHash(bytes, media);

    if (phash !== null) {
      await svc
        .from('tag_images')
        .update({ image_phash: phash.toString() })
        .eq('id', image.id);

      const { data: matches } = await svc.rpc('check_image_duplicate', {
        p_tag_id: tag.id,
        p_phash: phash.toString(),
      });

      if ((matches as number) > 0) {
        console.warn(`tag ${tag.id}: photo matches ${matches} existing tag(s)`);
      }
    }

    // --- read it -----------------------------------------------------------
    const started = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: {
        format: { type: 'json_schema', schema: EXTRACTION_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: media,
                data: base64(bytes),
              },
            },
            {
              type: 'text',
              text: 'Read this scale ticket. Return null for anything you cannot read exactly.',
            },
          ],
        },
      ],
    });

    // A safety refusal is not a bad photo. Say so plainly rather than letting
    // it look like an unreadable ticket, which would send a driver back to
    // retake a photo that was fine.
    if (response.stop_reason === 'refusal') {
      await svc
        .from('tags')
        .update({
          status: 'needs_review',
          review_reasons: ['extraction_refused'],
          review_notes: 'The reader declined this image. A person needs to look at it.',
        })
        .eq('id', tag.id);

      await finishQuota(caller, 'extract', true, { tag_id: tag.id, refused: true });
      return json({ status: 'needs_review', reason: 'refused' }, 200, origin);
    }

    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') {
      throw new HttpError(502, 'The reader returned nothing usable.');
    }

    const extracted = JSON.parse(text.text) as Extraction;

    // --- not a scale ticket at all -----------------------------------------
    if (extracted.is_scale_ticket === false) {
      await svc
        .from('tags')
        .update({
          status: 'needs_review',
          extracted,
          model_version: MODEL,
          extracted_at: new Date().toISOString(),
          review_reasons: ['not_a_scale_ticket'],
        })
        .eq('id', tag.id);

      await finishQuota(caller, 'extract', true, {
        tag_id: tag.id,
        not_a_ticket: true,
      });
      return json({ status: 'needs_review', reason: 'not_a_ticket' }, 200, origin);
    }

    // --- resolve the free text to real records -----------------------------
    const [quarryId, materialId, jobId, truckId] = await Promise.all([
      resolve(svc, 'quarry', caller.companyId, extracted.quarry_text.value),
      resolve(svc, 'material', caller.companyId, extracted.material_text.value),
      resolve(svc, 'job', caller.companyId, extracted.job_text.value),
      resolveTruck(svc, caller.companyId, extracted.truck_number.value),
    ]);

    const confidence: Record<string, number> = {};
    for (const [key, cell] of Object.entries(extracted)) {
      if (cell && typeof cell === 'object' && 'confidence' in cell) {
        confidence[key] = (cell as { confidence: number }).confidence;
      }
    }

    // --- write it back ------------------------------------------------------
    // Note what is deliberately NOT set here: status. The tag goes to
    // 'extracted' and a second step runs the controls, so that the validation
    // rules live in one place shared with both clients rather than being
    // duplicated in this file.
    const { error: updateError } = await svc
      .from('tags')
      .update({
        status: 'extracted',
        extracted,
        confidence,
        model_raw: {
          stop_reason: response.stop_reason,
          usage: response.usage,
          ms: Date.now() - started,
        },
        model_version: MODEL,
        extracted_at: new Date().toISOString(),
        ticket_number: extracted.ticket_number.value,
        tag_date: extracted.tag_date.value,
        quarry_id: quarryId,
        material_id: materialId,
        job_id: jobId,
        truck_id: truckId,
        gross_tons: extracted.gross_tons.value,
        tare_tons: extracted.tare_tons.value,
        net_tons: extracted.net_tons.value,
      })
      .eq('id', tag.id);

    if (updateError) {
      // The duplicate-ticket constraint firing here is the control working:
      // this ticket number already exists for this quarry. It is the most
      // common way money leaks out of a haul operation, and it is caught at
      // the storage layer where it cannot be bypassed.
      const duplicate = updateError.code === '23505';

      await svc
        .from('tags')
        .update({
          status: 'needs_review',
          extracted,
          confidence,
          model_version: MODEL,
          extracted_at: new Date().toISOString(),
          review_reasons: [duplicate ? 'duplicate_ticket' : 'write_failed'],
          review_notes: duplicate
            ? `Ticket ${extracted.ticket_number.value} already exists for this quarry.`
            : updateError.message,
        })
        .eq('id', tag.id);

      await finishQuota(caller, 'extract', true, {
        tag_id: tag.id,
        write_failed: duplicate ? 'duplicate' : updateError.message,
      });
      return json(
        { status: 'needs_review', reason: duplicate ? 'duplicate' : 'error' },
        200,
        origin
      );
    }

    // The arithmetic check, recorded as a verification rather than a pass/fail.
    // Three fields checking each other with no external data — free, and it
    // catches most digit errors on its own.
    const { gross_tons: g, tare_tons: t, net_tons: n } = extracted;
    if (g.value !== null && t.value !== null && n.value !== null) {
      await svc.from('field_verifications').upsert(
        {
          tag_id: tag.id,
          field: 'net_tons',
          source: 'arithmetic',
          agrees: Math.abs(g.value - t.value - n.value) <= 0.05,
          detail: { gross: g.value, tare: t.value, net: n.value },
        },
        { onConflict: 'tag_id,field,source' }
      );
    }

    await finishQuota(caller, 'extract', true, {
      tag_id: tag.id,
      usage: response.usage,
      ms: Date.now() - started,
    });

    return json(
      { status: 'extracted', tag_id: tag.id, confidence },
      200,
      origin
    );
  } catch (err) {
    // A 429 has already been metered by definition — closing it out as failed
    // would understate what the caller actually spent.
    if (caller && !(err instanceof HttpError && err.status === 429)) {
      await finishQuota(caller, 'extract', false, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return handleError(err, origin);
  }
});

interface Cell<T> {
  value: T | null;
  confidence: number;
}

interface Extraction {
  ticket_number: Cell<string>;
  tag_date: Cell<string>;
  tag_time: Cell<string>;
  quarry_text: Cell<string>;
  material_text: Cell<string>;
  job_text: Cell<string>;
  truck_number: Cell<string>;
  gross_tons: Cell<number>;
  tare_tons: Cell<number>;
  net_tons: Cell<number>;
  notes: Cell<string>;
  is_scale_ticket: boolean;
}

/**
 * "VULCAN MATLS #0123" has to become a quarry id.
 *
 * Trigram similarity against the entity's alias list, which grows every time
 * the office corrects a wrong match. That is why this gets better at your
 * specific vendors over the first few hundred tags with nobody training
 * anything — see learn_alias() in 003_logic.sql.
 */
async function resolve(
  svc: ReturnType<typeof serviceClient>,
  kind: 'quarry' | 'material' | 'job',
  companyId: string,
  raw: string | null
): Promise<string | null> {
  if (!raw || raw.trim().length < 2) return null;

  const { data } = await svc.rpc('resolve_entity', {
    p_kind: kind,
    p_company: companyId,
    p_text: raw,
  });

  return (data as string | null) ?? null;
}

/** Truck numbers are short and exact — fuzzy matching them invites mistakes. */
async function resolveTruck(
  svc: ReturnType<typeof serviceClient>,
  companyId: string,
  raw: string | null
): Promise<string | null> {
  if (!raw) return null;
  const { data } = await svc
    .from('trucks')
    .select('id')
    .eq('company_id', companyId)
    .eq('number', raw.trim())
    .eq('active', true)
    .maybeSingle();

  return data?.id ?? null;
}

function mediaTypeFor(path: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

/** Chunked so a multi-megabyte image does not blow the argument limit. */
function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
