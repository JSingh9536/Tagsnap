import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createRate,
  endRate,
  fetchRateBook,
  fetchRateTargets,
  fetchReferenceData,
  previewRate,
  supersedeRate,
  updateRate,
  type RateDraft,
  type RateTargets,
  type ReferenceData,
} from '../lib/api';
import {
  PAYEE_LEDGER_LABEL,
  formatCents,
  formatDate,
  type PayeeType,
  type RateBookRow,
  type RatePreview,
  type RateUnit,
} from '@tagsnap/shared';
import { useAuth } from '../state/auth';

/**
 * The rate book.
 *
 * This is the only screen in the console that changes what people will be paid
 * rather than recording what they were. Three things about the schema have to
 * come through in the layout, because getting any of them wrong costs money
 * quietly:
 *
 * **The two books never mix.** `payee_type` is the one matching column that is
 * never a wildcard. An employee rate must not price a subhauler load or the
 * reverse, so this screen shows one book at a time rather than a single list
 * with a column you could misread. See docs/ROLES.md.
 *
 * **Blank means "any".** A rate with no quarry applies at every quarry. That is
 * the single most misunderstood thing about this table, so blank scopes are
 * rendered as the word "Any" in muted type rather than as an empty cell.
 *
 * **Most specific wins.** Rows are ordered by specificity, not alphabetically,
 * because reading down the list should be reading the same decision
 * `app.match_rate` makes. The tester at the bottom runs that actual function
 * rather than a reimplementation.
 *
 * The primary verb here is **supersede**, not edit. A rate row is a historical
 * record: editing one in place rewrites what past loads would have paid.
 */
export function Rates() {
  const { profile } = useAuth();
  const canEdit = profile?.role === 'admin';

  const [book, setBook] = useState<RateBookRow[]>([]);
  const [ref, setRef] = useState<ReferenceData | null>(null);
  const [targets, setTargets] = useState<RateTargets | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [book_, setBookTab] = useState<PayeeType>('employee_driver');
  const [editing, setEditing] = useState<RateBookRow | 'new' | null>(null);
  const [superseding, setSuperseding] = useState<RateBookRow | null>(null);

  const load = useCallback(async () => {
    try {
      const [rows, reference, who] = await Promise.all([
        fetchRateBook(),
        fetchReferenceData(),
        fetchRateTargets(),
      ]);
      setBook(rows);
      setRef(reference);
      setTargets(who);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the rates.');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(
    () => book.filter((r) => r.payee_type === book_),
    [book, book_]
  );

  const live = rows.filter((r) => r.in_force);
  const past = rows.filter((r) => !r.in_force);

  async function run(what: () => Promise<void>, said: string) {
    setError(null);
    setNotice(null);
    try {
      await what();
      setNotice(said);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    }
  }

  if (loading) {
    return (
      <main className="rates">
        <p className="muted">Loading the rate book…</p>
      </main>
    );
  }

  return (
    <main className="rates">
      <header className="queue__head">
        <div>
          <h1>Rates</h1>
          <p className="muted">
            What we pay per ton. Nothing here is read off a ticket — the dollar
            figure printed on a scale ticket is the quarry billing their
            customer.
          </p>
        </div>
        {canEdit ? (
          <button className="btn btn--primary" onClick={() => setEditing('new')}>
            Add a rate
          </button>
        ) : null}
      </header>

      {/*
        The reassurance that lets an owner change a rate without hesitating,
        and the one people ask about first. approve_tag() freezes
        computed_pay_cents, and period close copies that frozen figure rather
        than recalculating.
      */}
      <p className="alert alert--good">
        <strong>Changing a rate never changes a settlement already approved.</strong>{' '}
        Pay is worked out once, at approval, and frozen on the ticket. Edits
        here affect loads approved from now on.
      </p>

      {canEdit ? null : (
        <p className="alert alert--attention">
          You can read the rate book but not change it. Rates are limited to
          admin accounts, because a rate change is the one edit in this console
          that alters what someone is paid without any ticket being reviewed.
        </p>
      )}

      {error ? <p className="alert alert--bad">{error}</p> : null}
      {notice ? <p className="alert alert--good">{notice}</p> : null}

      {/* One book at a time. Never a single list with a payee column. */}
      <div className="segmented">
        {(['employee_driver', 'subhauler'] as PayeeType[]).map((b) => (
          <button
            key={b}
            className={book_ === b ? 'on' : ''}
            onClick={() => setBookTab(b)}
          >
            {PAYEE_LEDGER_LABEL[b]}s
            <em>{book.filter((r) => r.payee_type === b && r.in_force).length}</em>
          </button>
        ))}
      </div>

      <RateTable
        title="In force"
        rows={live}
        empty={
          book_ === 'employee_driver'
            ? 'No rates for company drivers. Until one exists, every approval is held at "no rate on file".'
            : 'No rates for subhaulers. Their loads cannot be approved until one exists.'
        }
        canEdit={canEdit}
        onEdit={setEditing}
        onSupersede={setSuperseding}
        onEnd={(r) =>
          run(
            () => endRate(r.id, today()),
            `Ended. Loads after today matching only that rate will be held rather than priced.`
          )
        }
      />

      {past.length > 0 ? (
        <RateTable
          title="Superseded and expired"
          rows={past}
          empty=""
          canEdit={false}
          historical
          onEdit={setEditing}
          onSupersede={setSuperseding}
          onEnd={() => undefined}
        />
      ) : null}

      {ref && targets ? (
        <Tester book={book_} ref={ref} targets={targets} />
      ) : null}

      {editing && ref && targets ? (
        <RateEditor
          rate={editing === 'new' ? null : editing}
          book={book_}
          ref={ref}
          targets={targets}
          onCancel={() => setEditing(null)}
          onSave={async (draft) => {
            const isNew = editing === 'new';
            await run(
              () =>
                isNew
                  ? createRate(profile!.company_id, draft)
                  : updateRate((editing as RateBookRow).id, draft),
              isNew ? 'Rate added.' : 'Rate corrected.'
            );
            setEditing(null);
          }}
        />
      ) : null}

      {superseding ? (
        <Superseder
          rate={superseding}
          onCancel={() => setSuperseding(null)}
          onSave={async (cents, from) => {
            await run(
              () => supersedeRate(superseding.id, cents, from),
              `New rate starts ${formatDate(from)}. The old one ends the day before.`
            );
            setSuperseding(null);
          }}
        />
      ) : null}
    </main>
  );
}

// ------------------------------------------------------------------- table

function RateTable({
  title,
  rows,
  empty,
  canEdit,
  historical,
  onEdit,
  onSupersede,
  onEnd,
}: {
  title: string;
  rows: RateBookRow[];
  empty: string;
  canEdit: boolean;
  historical?: boolean;
  onEdit: (r: RateBookRow) => void;
  onSupersede: (r: RateBookRow) => void;
  onEnd: (r: RateBookRow) => void;
}) {
  if (rows.length === 0) {
    return empty ? (
      <>
        <h2 className="sectionhead">{title}</h2>
        <p className="empty">{empty}</p>
      </>
    ) : null;
  }

  return (
    <>
      <h2 className="sectionhead">{title}</h2>
      {!historical ? (
        <p className="footnote">
          Ordered the way pricing resolves: most specific first. A load takes
          the first row here that it matches.
        </p>
      ) : null}

      <table className="table">
        <thead>
          <tr>
            <th>Applies to</th>
            <th className="num">Rate</th>
            <th>From</th>
            <th>Until</th>
            <th className="num">Loads priced</th>
            {canEdit ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={historical ? 'muted' : undefined}>
              <td>
                <Scope rate={r} />
              </td>
              <td className="num">
                <strong>{formatCents(r.rate_cents)}</strong>
                <span className="muted"> / {r.unit}</span>
                {r.unit === 'hour' ? (
                  // compute_pay_cents returns null for hourly: a scale ticket
                  // carries no hours. Worth saying on the row rather than
                  // letting someone discover it at approval time.
                  <em className="unmatched"> cannot price a ticket</em>
                ) : null}
              </td>
              <td>{formatDate(r.effective_from)}</td>
              <td>{r.effective_to ? formatDate(r.effective_to) : <span className="muted">open</span>}</td>
              <td className="num">{r.loads_priced}</td>
              {canEdit ? (
                <td className="rowactions">
                  <button className="btn btn--primary" onClick={() => onSupersede(r)}>
                    Change price
                  </button>
                  {/*
                    Editing in place is offered only for a row that has never
                    priced anything. Once a settlement has been calculated from
                    a rate, rewriting it makes the table disagree with the
                    payments printed off it.
                  */}
                  {r.loads_priced === 0 ? (
                    <button className="btn btn--ghost" onClick={() => onEdit(r)}>
                      Edit
                    </button>
                  ) : null}
                  <button
                    className="btn btn--warn"
                    onClick={() => {
                      if (
                        window.confirm(
                          'End this rate today? Loads that match only this rate will be held at "no rate on file" instead of being priced.'
                        )
                      ) {
                        onEnd(r);
                      }
                    }}
                  >
                    End
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * What a rate applies to, in words.
 *
 * "Any" rather than a blank cell, everywhere. A wildcard that looks like
 * missing data is how somebody deletes a rate thinking it is incomplete.
 */
function Scope({ rate }: { rate: RateBookRow }) {
  const parts: { label: string; value: string | null }[] = [
    {
      label: rate.payee_type === 'subhauler' ? 'Outfit' : 'Driver',
      value: rate.payee_type === 'subhauler' ? rate.subhauler_name : rate.driver_name,
    },
    { label: 'Quarry', value: rate.quarry_name },
    { label: 'Material', value: rate.material_name },
    { label: 'Job', value: rate.job_name },
  ];

  const set = parts.filter((p) => p.value);

  if (set.length === 0) {
    return (
      <span>
        <strong>Any load</strong>
        <em className="muted"> — the fallback when nothing more specific matches</em>
      </span>
    );
  }

  return (
    <span>
      {set.map((p, i) => (
        <React.Fragment key={p.label}>
          {i > 0 ? <span className="muted"> · </span> : null}
          <strong>{p.value}</strong>
        </React.Fragment>
      ))}
      <em className="muted">
        {' '}
        — any {parts.filter((p) => !p.value).map((p) => p.label.toLowerCase()).join(', ') || 'load'}
      </em>
    </span>
  );
}

// ------------------------------------------------------------------ editor

function RateEditor({
  rate,
  book,
  ref: reference,
  targets,
  onCancel,
  onSave,
}: {
  rate: RateBookRow | null;
  book: PayeeType;
  ref: ReferenceData;
  targets: RateTargets;
  onCancel: () => void;
  onSave: (draft: RateDraft) => Promise<void>;
}) {
  const [dollars, setDollars] = useState(
    rate ? (rate.rate_cents / 100).toFixed(2) : ''
  );
  const [unit, setUnit] = useState<RateUnit>(rate?.unit ?? 'ton');
  const [from, setFrom] = useState(rate?.effective_from ?? today());
  const [driver, setDriver] = useState(rate?.driver_id ?? '');
  const [subhauler, setSubhauler] = useState(rate?.subhauler_id ?? '');
  const [quarry, setQuarry] = useState(rate?.quarry_id ?? '');
  const [material, setMaterial] = useState(rate?.material_id ?? '');
  const [job, setJob] = useState(rate?.job_id ?? '');
  const [busy, setBusy] = useState(false);

  const cents = Math.round(Number(dollars) * 100);
  const valid = Number.isFinite(cents) && cents >= 0 && dollars.trim() !== '';

  return (
    <div className="modal">
      <div className="modal__body">
        <h2>{rate ? 'Correct this rate' : `New ${PAYEE_LEDGER_LABEL[book].toLowerCase()} rate`}</h2>

        {rate ? (
          <p className="footnote">
            This row has priced nothing yet, so correcting it changes no history.
          </p>
        ) : (
          <p className="footnote">
            Leave a box on <strong>Any</strong> to make the rate apply broadly.
            A more specific rate always wins over a broader one.
          </p>
        )}

        <div className="fields">
          <label className="field">
            <span className="fieldlabel">Rate</span>
            <input
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={dollars}
              onChange={(e) => setDollars(e.target.value)}
              placeholder="8.75"
              autoFocus
            />
          </label>

          <label className="field">
            <span className="fieldlabel">Per</span>
            <select value={unit} onChange={(e) => setUnit(e.target.value as RateUnit)}>
              <option value="ton">ton</option>
              <option value="load">load</option>
              <option value="hour">hour</option>
            </select>
          </label>

          <label className="field">
            <span className="fieldlabel">Effective from</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
        </div>

        {unit === 'hour' ? (
          <p className="alert alert--attention">
            A scale ticket records tons, not hours, so an hourly rate cannot
            price one automatically. Loads matching it will be held for someone
            to enter the pay by hand.
          </p>
        ) : null}

        <h3 className="sectionhead">Applies to</h3>

        <div className="fields">
          {book === 'subhauler' ? (
            <Picker
              label="Outfit"
              value={subhauler}
              onChange={setSubhauler}
              options={targets.subhaulers.map((s) => ({ id: s.id, name: s.name }))}
            />
          ) : (
            <Picker
              label="Driver"
              value={driver}
              onChange={setDriver}
              options={targets.drivers.map((d) => ({ id: d.id, name: d.full_name }))}
            />
          )}
          <Picker
            label="Quarry"
            value={quarry}
            onChange={setQuarry}
            options={reference.quarries.map((q) => ({ id: q.id, name: q.name }))}
          />
          <Picker
            label="Material"
            value={material}
            onChange={setMaterial}
            options={reference.materials.map((m) => ({ id: m.id, name: m.name }))}
          />
          <Picker
            label="Job"
            value={job}
            onChange={setJob}
            options={reference.jobs.map((j) => ({ id: j.id, name: j.name }))}
          />
        </div>

        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              await onSave({
                payee_type: book,
                // The database refuses a driver on a subhauler rate and the
                // reverse — rate_target_matches_payee_type in 001. Sending
                // null for the wrong one keeps the form from ever building a
                // row the constraint would bounce.
                driver_id: book === 'employee_driver' ? driver || null : null,
                subhauler_id: book === 'subhauler' ? subhauler || null : null,
                quarry_id: quarry || null,
                material_id: material || null,
                job_id: job || null,
                unit,
                rate_cents: cents,
                effective_from: from,
                effective_to: null,
              });
              setBusy(false);
            }}
          >
            {busy ? 'Saving…' : rate ? 'Save correction' : 'Add rate'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Picker({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { id: string; name: string }[];
}) {
  return (
    <label className="field">
      <span className="fieldlabel">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// -------------------------------------------------------------- supersede

/**
 * The operation people actually want: "put this up to $9.25 from Monday."
 *
 * Defaults to tomorrow rather than today, because a rate starting today would
 * reprice loads hauled this morning that nobody has approved yet — and the
 * hauler agreed a price before they drove.
 */
function Superseder({
  rate,
  onCancel,
  onSave,
}: {
  rate: RateBookRow;
  onCancel: () => void;
  onSave: (cents: number, from: string) => Promise<void>;
}) {
  const [dollars, setDollars] = useState((rate.rate_cents / 100).toFixed(2));
  const [from, setFrom] = useState(tomorrow());
  const [busy, setBusy] = useState(false);

  const cents = Math.round(Number(dollars) * 100);
  const valid = Number.isFinite(cents) && cents >= 0 && from > rate.effective_from;
  const change = cents - rate.rate_cents;

  return (
    <div className="modal">
      <div className="modal__body">
        <h2>Change the price</h2>
        <p className="footnote">
          <Scope rate={rate} />
        </p>

        <div className="fields">
          <label className="field">
            <span className="fieldlabel">New rate per {rate.unit}</span>
            <input
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={dollars}
              onChange={(e) => setDollars(e.target.value)}
              autoFocus
            />
          </label>
          <label className="field">
            <span className="fieldlabel">Starting</span>
            <input
              type="date"
              value={from}
              min={addDays(rate.effective_from, 1)}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
        </div>

        <p className={change === 0 ? 'muted' : change > 0 ? 'price price--ok' : 'price'}>
          {formatCents(rate.rate_cents)} → <strong>{formatCents(cents)}</strong>
          {change !== 0 ? (
            <span className="muted">
              {' '}
              ({change > 0 ? '+' : ''}
              {formatCents(change)} per {rate.unit})
            </span>
          ) : null}
        </p>

        <p className="footnote">
          The current rate ends {formatDate(addDays(from, -1))} and the new one
          begins {formatDate(from)}. No gap, no overlap — both happen in one
          transaction.
          {rate.loads_priced > 0 ? (
            <>
              {' '}
              The {rate.loads_priced} load
              {rate.loads_priced === 1 ? '' : 's'} already priced at{' '}
              {formatCents(rate.rate_cents)} are untouched.
            </>
          ) : null}
        </p>

        {!valid && from <= rate.effective_from ? (
          <p className="alert alert--bad">
            The new rate has to start after {formatDate(rate.effective_from)},
            when this one began.
          </p>
        ) : null}

        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              await onSave(cents, from);
              setBusy(false);
            }}
          >
            {busy ? 'Saving…' : 'Change it'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- tester

/**
 * "What would this load pay?"
 *
 * Runs `preview_rate`, which calls the same `app.match_rate` the pricer uses.
 * The alternative — working out the winning row in TypeScript — would be a
 * second implementation of "most specific wins", and the two would eventually
 * disagree. The screen contradicting the settlement is the worst place for
 * that.
 */
function Tester({
  book,
  ref: reference,
  targets,
}: {
  book: PayeeType;
  ref: ReferenceData;
  targets: RateTargets;
}) {
  const [driver, setDriver] = useState('');
  const [subhauler, setSubhauler] = useState('');
  const [quarry, setQuarry] = useState('');
  const [material, setMaterial] = useState('');
  const [job, setJob] = useState('');
  const [on, setOn] = useState(today());
  const [tons, setTons] = useState('22.50');
  const [result, setResult] = useState<RatePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setError(null);
    try {
      setResult(
        await previewRate({
          payee_type: book,
          driver_id: book === 'employee_driver' ? driver || null : null,
          subhauler_id: book === 'subhauler' ? subhauler || null : null,
          quarry_id: quarry || null,
          material_id: material || null,
          job_id: job || null,
          on,
          net_tons: Number(tons) || null,
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not work that out.');
    }
  }

  return (
    <section className="tester">
      <h2 className="sectionhead">What would a load pay?</h2>
      <p className="footnote">
        Runs the same matching the pricer does. Nothing is saved.
      </p>

      <div className="fields">
        {book === 'subhauler' ? (
          <Picker
            label="Outfit"
            value={subhauler}
            onChange={setSubhauler}
            options={targets.subhaulers.map((s) => ({ id: s.id, name: s.name }))}
          />
        ) : (
          <Picker
            label="Driver"
            value={driver}
            onChange={setDriver}
            options={targets.drivers.map((d) => ({ id: d.id, name: d.full_name }))}
          />
        )}
        <Picker
          label="Quarry"
          value={quarry}
          onChange={setQuarry}
          options={reference.quarries.map((q) => ({ id: q.id, name: q.name }))}
        />
        <Picker
          label="Material"
          value={material}
          onChange={setMaterial}
          options={reference.materials.map((m) => ({ id: m.id, name: m.name }))}
        />
        <Picker
          label="Job"
          value={job}
          onChange={setJob}
          options={reference.jobs.map((j) => ({ id: j.id, name: j.name }))}
        />
        <label className="field">
          <span className="fieldlabel">Hauled on</span>
          <input type="date" value={on} onChange={(e) => setOn(e.target.value)} />
        </label>
        <label className="field">
          <span className="fieldlabel">Net tons</span>
          <input
            type="number"
            step="0.01"
            value={tons}
            onChange={(e) => setTons(e.target.value)}
          />
        </label>
      </div>

      <button className="btn btn--ghost" onClick={() => void check()}>
        Work it out
      </button>

      {error ? <p className="alert alert--bad">{error}</p> : null}

      {result ? (
        result.matched ? (
          <div className="alert alert--good">
            <strong>
              {formatCents(result.rate_cents ?? 0)} per {result.unit}
            </strong>
            {result.pay_cents != null ? (
              <>
                {' '}
                — this load pays <strong>{formatCents(result.pay_cents)}</strong>
              </>
            ) : null}
            <br />
            <span className="muted">
              Matched a rate scoped on {result.specificity} field
              {result.specificity === 1 ? '' : 's'}, effective from{' '}
              {formatDate(result.effective_from ?? null)}.
            </span>
            {result.why ? <p className="unmatched">{result.why}</p> : null}
          </div>
        ) : (
          <p className="alert alert--attention">{result.why}</p>
        )
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- helpers

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function tomorrow(): string {
  return addDays(today(), 1);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
