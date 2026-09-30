import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  approveTag,
  cancelRescan,
  currentImage,
  fetchReferenceData,
  fetchTag,
  learnAlias,
  openRescan,
  priceTag,
  rejectTag,
  requestRescan,
  saveCorrection,
  signedImageUrl,
  type Correction,
  type ReferenceData,
} from '../lib/api';
import {
  OFFICE_STATUS_LABEL,
  PAYEE_LABEL,
  PAYEE_LEDGER_LABEL,
  RESCAN_REASON_LABEL,
  STATUS_TONE,
  formatCents,
  formatTons,
  label as fieldLabel,
  validateTag,
  type PricePreview,
  type RescanReason,
  type TagWithRelations,
} from '@tagsnap/shared';

/**
 * The review screen. This is the control point of the entire system.
 *
 * Everything upstream of it is a suggestion; everything downstream is a
 * financial record. The layout follows from that: the photograph is always
 * on screen next to the fields, at a size you can actually read a faded
 * carbon copy at, because the reviewer's job is to compare the two — not to
 * trust a form.
 *
 * Three ways out:
 *   approve  — freezes it and prices it from the rate table
 *   rescan   — sends it back to the field with a reason the driver will read
 *   reject   — it is not a payable load at all
 *
 * There is no fourth option where a tag quietly disappears.
 */
export function Review() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [tag, setTag] = useState<TagWithRelations | null>(null);
  const [ref, setRef] = useState<ReferenceData | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [price, setPrice] = useState<PricePreview | null>(null);

  const [draft, setDraft] = useState<Correction>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [showRescan, setShowRescan] = useState(false);
  const [showOcr, setShowOcr] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const fresh = await fetchTag(id);
      setTag(fresh);
      setDraft({});
      const img = currentImage(fresh);
      if (img) setImageUrl(await signedImageUrl(img.image_path));
      setPrice(await priceTag(id).catch(() => null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the tag.');
    }
  }, [id]);

  useEffect(() => {
    void load();
    void fetchReferenceData().then(setRef);
  }, [load]);

  // The signed URL lasts 60 seconds. A reviewer studying a bad carbon copy for
  // two minutes should not watch the image vanish mid-comparison.
  useEffect(() => {
    if (!tag) return;
    const img = currentImage(tag);
    if (!img) return;
    const t = setInterval(() => {
      void signedImageUrl(img.image_path).then(setImageUrl).catch(() => {
        // Keep the current URL rather than blanking the panel.
      });
    }, 45_000);
    return () => clearInterval(t);
  }, [tag]);

  /**
   * The value to show for a field: the reviewer's unsaved edit if there is
   * one, otherwise what is on the tag. Keeping the draft separate from the
   * tag is what makes "Save corrections" a deliberate act rather than a
   * stream of writes as someone tabs through the form.
   */
  function value<K extends keyof Correction>(key: K): Correction[K] {
    if (key in draft) return draft[key];
    return tag ? (tag[key] as Correction[K]) : undefined;
  }

  function set<K extends keyof Correction>(key: K, v: Correction[K]) {
    setDraft((d) => ({ ...d, [key]: v }));
  }

  const dirty = Object.keys(draft).length > 0;

  const extracted = tag?.extracted ?? null;
  const rescan = tag ? openRescan(tag) : null;

  /**
   * The same controls the server runs, run again here against the reviewer's
   * unsaved edits.
   *
   * Not a substitute for the server's verdict — `validate_tag()` in the
   * database is authoritative and runs on save. This exists so a reviewer
   * correcting a date sees the "stale ticket" flag clear as they type, rather
   * than after a round trip. Shared code, so the two can never disagree about
   * what the rules are.
   *
   * The weight checks are filtered out because the Weights component shows
   * them inline, right under the numbers they concern.
   */
  const liveFlags = useMemo(() => {
    if (!tag) return [];
    return validateTag({
      extracted,
      tag: { ...tag, ...draft },
      truck: tag.trucks,
    }).filter(
      (r) =>
        !['weights_disagree', 'over_capacity', 'tare_unusual', 'non_positive_net']
          .includes(r.code)
    );
  }, [tag, draft, extracted]);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run('save', async () => {
      if (!id) return;

      // When a reviewer picks the right quarry for text that did not match,
      // teach the system that spelling. The next ticket from that vendor
      // resolves on its own — this is the whole alias-learning loop, and it
      // costs one extra call at exactly the moment the answer is known.
      if (draft.quarry_id && extracted?.quarry_text.value) {
        await learnAlias('quarry', draft.quarry_id, extracted.quarry_text.value)
          .catch(() => undefined);
      }
      if (draft.material_id && extracted?.material_text.value) {
        await learnAlias('material', draft.material_id, extracted.material_text.value)
          .catch(() => undefined);
      }
      if (draft.job_id && extracted?.job_text.value) {
        await learnAlias('job', draft.job_id, extracted.job_text.value)
          .catch(() => undefined);
      }

      const fresh = await saveCorrection(id, draft);
      setTag(fresh);
      setDraft({});
      setPrice(await priceTag(id).catch(() => null));
    });

  const approve = () =>
    run('approve', async () => {
      if (!id) return;
      if (dirty) {
        setError('Save your corrections first, then approve.');
        return;
      }
      await approveTag(id);
      navigate('/queue');
    });

  if (!tag) {
    return (
      <main className="review review--loading">
        {error ? <p className="alert alert--bad">{error}</p> : <p>Loading…</p>}
      </main>
    );
  }

  const frozen = tag.status === 'approved' || tag.status === 'invoiced';

  return (
    <main className="review">
      {/* ---------------------------------------------------- the evidence */}
      <section className="review__image">
        <div className="review__imagebar">
          <span className="muted">
            {tag.rescan_count > 0
              ? `Photo v${currentImage(tag)?.version ?? 1} · retaken ${tag.rescan_count}×`
              : 'Original photo'}
          </span>
          <div className="zoom">
            <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>−</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>+</button>
            <button onClick={() => setZoom(1)}>Fit</button>
          </div>
        </div>

        <div className="review__canvas">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt="The scale ticket as photographed"
              style={{ transform: `scale(${zoom})` }}
            />
          ) : (
            <p className="muted">Loading the photo…</p>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------- the fields */}
      <section className="review__panel">
        <header className="review__header">
          <div>
            <h1>{tag.ticket_number ? `Ticket #${tag.ticket_number}` : 'Unread ticket'}</h1>
            <p className="muted">
              {tag.submitter?.full_name ?? 'Unknown'} ·{' '}
              {PAYEE_LABEL[tag.payee_type]}
              {tag.subhaulers ? ` (${tag.subhaulers.name})` : ''}
            </p>
          </div>
          <span className={`pill pill--${STATUS_TONE[tag.status]}`}>
            {OFFICE_STATUS_LABEL[tag.status]}
          </span>
        </header>

        {error ? <p className="alert alert--bad">{error}</p> : null}

        {rescan ? (
          <div className="alert alert--attention">
            <strong>Waiting on a new photo</strong>
            <p>
              {RESCAN_REASON_LABEL[rescan.reason]}
              {rescan.note ? ` — “${rescan.note}”` : ''}
            </p>
            <button
              className="btn btn--ghost"
              disabled={busy !== null}
              onClick={() =>
                run('cancel', async () => {
                  await cancelRescan(rescan.id);
                  await load();
                })
              }
            >
              Cancel the request
            </button>
          </div>
        ) : null}

        {tag.review_reasons.length > 0 && !dirty ? (
          <div className="alert alert--attention">
            <strong>Why this stopped here</strong>
            <ul>
              {tag.review_reasons.map((r) => (
                <li key={r}>{explainReason(r)}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {showOcr && tag.ocr_text ? (
          <div className="ocr-dump">
            <strong>
              What the phone read
              {tag.engine ? ` — ${ENGINE_LABEL[tag.engine]}` : ''}
              {tag.ocr_ms ? `, ${tag.ocr_ms} ms` : ''}
            </strong>
            {/*
              The recognised text, unedited. Two jobs: it is faster to copy a
              ticket number out of here than to retype it from the photo, and
              when a field is wrong it shows whether the reader misread the
              ticket or the parser picked the wrong line — which are different
              problems with different fixes.
            */}
            <pre>{tag.ocr_text}</pre>
          </div>
        ) : null}

        {dirty ? (
          liveFlags.length > 0 ? (
            <div className="alert alert--attention">
              <strong>Still outstanding with your changes</strong>
              <ul>
                {liveFlags.map((f) => (
                  <li key={`${f.code}:${f.field ?? ''}`}>{f.message}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="alert alert--good">
              Your changes clear every flag. Save, then approve.
            </p>
          )
        ) : null}

        <div className="fields">
          <TextField
            label="Ticket number"
            value={String(value('ticket_number') ?? '')}
            confidence={tag.confidence?.ticket_number}
            raw={extracted?.ticket_number.value}
            disabled={frozen}
            onChange={(v) => set('ticket_number', v || null)}
          />
          <TextField
            label="Date"
            type="date"
            value={String(value('tag_date') ?? '')}
            confidence={tag.confidence?.tag_date}
            raw={extracted?.tag_date.value}
            disabled={frozen}
            onChange={(v) => set('tag_date', v || null)}
          />

          <SelectField
            label="Quarry"
            value={String(value('quarry_id') ?? '')}
            options={(ref?.quarries ?? []).map((q) => ({ id: q.id, name: q.name }))}
            confidence={tag.confidence?.quarry_text}
            raw={extracted?.quarry_text.value}
            disabled={frozen}
            onChange={(v) => set('quarry_id', v || null)}
          />
          <SelectField
            label="Material"
            value={String(value('material_id') ?? '')}
            options={(ref?.materials ?? []).map((m) => ({
              id: m.id,
              name: m.code ? `${m.code} — ${m.name}` : m.name,
            }))}
            confidence={tag.confidence?.material_text}
            raw={extracted?.material_text.value}
            disabled={frozen}
            onChange={(v) => set('material_id', v || null)}
          />
          <SelectField
            label="Job"
            value={String(value('job_id') ?? '')}
            options={(ref?.jobs ?? []).map((j) => ({
              id: j.id,
              name: j.number ? `${j.number} — ${j.name}` : j.name,
            }))}
            confidence={tag.confidence?.job_text}
            raw={extracted?.job_text.value}
            disabled={frozen}
            onChange={(v) => set('job_id', v || null)}
          />
          <SelectField
            label="Truck"
            value={String(value('truck_id') ?? '')}
            options={(ref?.trucks ?? []).map((t) => ({ id: t.id, name: t.number }))}
            confidence={tag.confidence?.truck_number}
            raw={extracted?.truck_number.value}
            disabled={frozen}
            onChange={(v) => set('truck_id', v || null)}
          />
        </div>

        <Weights
          gross={value('gross_tons') as number | null}
          tare={value('tare_tons') as number | null}
          net={value('net_tons') as number | null}
          confidence={tag.confidence}
          capacity={tag.trucks?.legal_capacity_tons ?? null}
          avgTare={tag.trucks?.avg_tare_tons ?? null}
          disabled={frozen}
          onChange={(k, v) => set(k, v)}
        />

        {extracted?.notes.value ? (
          <div className="notes">
            <span className="fieldlabel">Read off the ticket</span>
            <p>{extracted.notes.value}</p>
          </div>
        ) : null}

        {/* ------------------------------------------------------ the money */}
        <div className={`price ${price?.pay_cents ? 'price--ok' : 'price--missing'}`}>
          <div>
            <span className="fieldlabel">{PAYEE_LEDGER_LABEL[tag.payee_type]}</span>
            <strong>
              {frozen
                ? formatCents(tag.computed_pay_cents)
                : price?.pay_cents !== null && price?.pay_cents !== undefined
                  ? formatCents(price.pay_cents)
                  : 'No rate on file'}
            </strong>
          </div>
          {price?.rate_cents ? (
            <span className="muted">
              {formatCents(price.rate_cents)} per {price.unit} ×{' '}
              {formatTons(price.net_tons)}
            </span>
          ) : (
            <span className="muted">
              Computed from your rate table — not from the dollar figure on the
              ticket, which is the quarry billing their customer.
            </span>
          )}
        </div>

        {/* ---------------------------------------------------- the actions */}
        {frozen ? (
          <p className="alert alert--good">
            Approved and locked. A correction after this point goes on the next
            period as a reversing entry, not as a rewrite.
          </p>
        ) : (
          <footer className="review__actions">
            <button
              className="btn btn--primary"
              disabled={busy !== null || !dirty}
              onClick={save}
            >
              {busy === 'save' ? 'Saving…' : 'Save corrections'}
            </button>

            <button
              className="btn btn--approve"
              disabled={busy !== null || dirty || rescan !== null}
              onClick={approve}
              title={
                dirty
                  ? 'Save your corrections first'
                  : rescan
                    ? 'A rescan is still outstanding'
                    : undefined
              }
            >
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </button>

            <button
              className="btn btn--warn"
              disabled={busy !== null || rescan !== null}
              onClick={() => setShowRescan(true)}
            >
              Send back for a rescan
            </button>

            <button
              className="btn btn--ghost"
              disabled={!tag.ocr_text}
              onClick={() => setShowOcr((v) => !v)}
              title={
                tag.ocr_text
                  ? 'Everything the phone recognised on this photo'
                  : 'Nothing was recognised on this photo'
              }
            >
              {showOcr ? 'Hide the raw text' : 'Show the raw text'}
            </button>

            <button
              className="btn btn--danger"
              disabled={busy !== null}
              onClick={() =>
                run('reject', async () => {
                  const reason = window.prompt(
                    'Why is this not a payable load? The driver sees this.'
                  );
                  if (!reason) return;
                  await rejectTag(tag.id, reason);
                  navigate('/queue');
                })
              }
            >
              Reject
            </button>
          </footer>
        )}
      </section>

      {showRescan ? (
        <RescanDialog
          onClose={() => setShowRescan(false)}
          onSubmit={(reason, note) =>
            run('rescan', async () => {
              await requestRescan(
                tag.id,
                reason,
                note,
                currentImage(tag)?.id ?? null
              );
              setShowRescan(false);
              navigate('/queue');
            })
          }
        />
      ) : null}
    </main>
  );
}

/* -------------------------------------------------------------- sub-parts */

function Confidence({ value }: { value: number | undefined }) {
  if (value === undefined) return null;
  const tone = value >= 0.95 ? 'good' : value >= 0.9 ? 'attention' : 'bad';
  return (
    <span className={`conf conf--${tone}`} title="How sure the reader was">
      {Math.round(value * 100)}%
    </span>
  );
}

function TextField({
  label,
  value,
  onChange,
  confidence,
  raw,
  type = 'text',
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  confidence?: number;
  raw?: string | null;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span className="fieldlabel">
        {label} <Confidence value={confidence} />
      </span>
      <input
        type={type}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {raw ? <span className="raw">read as “{raw}”</span> : null}
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  confidence,
  raw,
  disabled,
}: {
  label: string;
  value: string;
  options: { id: string; name: string }[];
  onChange: (v: string) => void;
  confidence?: number;
  raw?: string | null;
  disabled?: boolean;
}) {
  const unresolved = !value && raw;

  return (
    <label className={`field ${unresolved ? 'field--unresolved' : ''}`}>
      <span className="fieldlabel">
        {label} <Confidence value={confidence} />
      </span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">— not matched —</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      {raw ? (
        <span className="raw">
          read as “{raw}”
          {unresolved ? ' — pick the right one and it will remember' : ''}
        </span>
      ) : null}
    </label>
  );
}

/**
 * The three weights, together.
 *
 * Shown as a group with the arithmetic live underneath, because gross − tare =
 * net is the single check that verifies three fields against each other with
 * no external data. A reviewer who can see the drift figure catches a
 * transposed digit without doing mental arithmetic.
 */
function Weights({
  gross,
  tare,
  net,
  confidence,
  capacity,
  avgTare,
  disabled,
  onChange,
}: {
  gross: number | null;
  tare: number | null;
  net: number | null;
  confidence: Record<string, number> | null;
  capacity: number | null;
  avgTare: number | null;
  disabled?: boolean;
  onChange: (k: 'gross_tons' | 'tare_tons' | 'net_tons', v: number | null) => void;
}) {
  const drift = useMemo(() => {
    if (gross === null || tare === null || net === null) return null;
    return Number(gross) - Number(tare) - Number(net);
  }, [gross, tare, net]);

  const overCapacity = capacity !== null && net !== null && net > capacity;
  const oddTare = avgTare !== null && tare !== null && Math.abs(tare - avgTare) > 0.5;

  return (
    <div className="weights">
      <div className="weights__row">
        {(['gross_tons', 'tare_tons', 'net_tons'] as const).map((key) => (
          <label key={key} className="field">
            <span className="fieldlabel">
              {key === 'gross_tons' ? 'Gross' : key === 'tare_tons' ? 'Tare' : 'Net'}{' '}
              <Confidence value={confidence?.[key]} />
            </span>
            <input
              type="number"
              step="0.01"
              inputMode="decimal"
              disabled={disabled}
              value={
                (key === 'gross_tons' ? gross : key === 'tare_tons' ? tare : net) ?? ''
              }
              onChange={(e) =>
                onChange(key, e.target.value === '' ? null : Number(e.target.value))
              }
            />
          </label>
        ))}
      </div>

      {drift !== null ? (
        <p className={`arith ${Math.abs(drift) > 0.05 ? 'arith--bad' : 'arith--ok'}`}>
          {Math.abs(drift) > 0.05
            ? `Gross − tare = ${(Number(gross) - Number(tare)).toFixed(2)} t, but net says ${Number(net).toFixed(2)} t — off by ${Math.abs(drift).toFixed(2)} t. At least one number was misread.`
            : 'Gross − tare = net. The three weights agree.'}
        </p>
      ) : null}

      {overCapacity ? (
        <p className="arith arith--bad">
          {formatTons(net)} is over this truck's legal capacity of{' '}
          {formatTons(capacity)}.
        </p>
      ) : null}

      {oddTare ? (
        <p className="arith arith--warn">
          Tare is off this truck's usual {formatTons(avgTare)}.
        </p>
      ) : null}
    </div>
  );
}

/** Who read the ticket. Shown beside the raw text so a bad reading is
 *  attributable to an engine and a version rather than to "the app". */
const ENGINE_LABEL: Record<string, string> = {
  apple_vision: 'iPhone',
  mlkit: 'Android',
  tesseract: 'this browser',
  office_manual: 'typed in by the office',
  quarry_feed: 'sent by the quarry',
};

const RESCAN_REASONS: RescanReason[] = [
  'unreadable',
  'cropped',
  'missing_fields',
  'wrong_document',
  'duplicate_check',
  'other',
];

function RescanDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (reason: RescanReason, note: string | null) => void;
}) {
  const [reason, setReason] = useState<RescanReason>('unreadable');
  const [note, setNote] = useState('');

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Send back for a rescan">
      <div className="modal__body">
        <h2>Send it back for a new photo</h2>
        <p className="muted">
          The driver sees this on their camera screen while they retake it. A
          specific reason gets a usable photo; a vague one gets the same bad
          photo twice.
        </p>

        <div className="reasons">
          {RESCAN_REASONS.map((r) => (
            <label key={r} className={`reason ${reason === r ? 'reason--on' : ''}`}>
              <input
                type="radio"
                name="reason"
                checked={reason === r}
                onChange={() => setReason(r)}
              />
              {RESCAN_REASON_LABEL[r]}
            </label>
          ))}
        </div>

        <label className="field">
          <span className="fieldlabel">Anything to add (optional)</span>
          <textarea
            rows={3}
            value={note}
            placeholder="e.g. The net weight is under your thumb."
            onChange={(e) => setNote(e.target.value)}
          />
        </label>

        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--warn"
            onClick={() => onSubmit(reason, note.trim() || null)}
          >
            Send it back
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Review reasons, in English.
 *
 * The codes are precise and mean nothing to a person. Each of these describes
 * a control that just did its job.
 */
function explainReason(code: string): string {
  if (code.startsWith('low_confidence:')) {
    const f = code.split(':')[1] ?? '';
    return `The reader was not confident about ${fieldLabel(f)}.`;
  }
  if (code.startsWith('value_not_in_ocr_text:')) {
    const f = code.split(':')[1] ?? '';
    return (
      `${fieldLabel(f)} does not appear anywhere in the text the phone ` +
      `recognised, so it was not read off this photo.`
    );
  }
  const map: Record<string, string> = {
    weights_disagree: 'Gross minus tare does not equal net.',
    over_capacity: "Net tonnage is over the truck's legal capacity.",
    tare_unusual: "Tare is well off this truck's running average.",
    net_tons_missing: 'No net tonnage, so this cannot be priced.',
    tag_date_missing: 'No ticket date.',
    future_date: 'The ticket is dated in the future.',
    stale_date: 'The ticket is older than the 45-day window.',
    quarry_unresolved: 'The quarry text does not match any quarry on file.',
    material_unresolved: 'The material does not match anything on file.',
    ticket_number_missing: 'No ticket number, so it cannot be duplicate-checked.',
    no_rate_on_file: 'No rate exists for this load — approving would pay zero.',
    duplicate_ticket: 'That ticket number already exists for this quarry.',
    not_a_scale_ticket: 'The photo does not look like a scale ticket.',
    extraction_refused: 'The reader declined this image.',
    write_failed: 'The extracted values could not be saved.',
    ocr_unreadable:
      'The phone found no readable text on this photo. Type the fields in, or send it back for a rescan.',
    never_read:
      'The photo arrived but no reading ever followed it. Type the fields in from the image.',
    no_ocr_text:
      'Values arrived with no recognised text behind them. Check this one against the photo carefully.',
    confidence_contradicts_arithmetic:
      'The weights were submitted as certain, but they do not add up.',
    possible_rephotograph:
      'This photo looks like one already submitted on another ticket.',
  };
  return map[code] ?? code;
}
