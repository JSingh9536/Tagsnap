import React, { useCallback, useEffect, useState } from 'react';
import {
  closePeriod,
  fetchInvoices,
  issueInvoice,
  previewClose,
  voidInvoice,
  type ClosePreviewRow,
  type CloseResultRow,
  type InvoiceSummary,
} from '../lib/api';
import { useAuth } from '../state/auth';
import {
  PAYEE_LEDGER_LABEL,
  formatCents,
  formatDate,
  formatTons,
  type PayeeType,
} from '@tagsnap/shared';

/**
 * Period close.
 *
 * Groups approved tags into invoices — one per payee, per period. Company
 * drivers and subhaulers are shown side by side but never merged: an employee
 * settlement and a vendor payable are different documents going to different
 * systems, and the whole point of the payee split is that this screen cannot
 * accidentally combine them.
 *
 * The preview is not decoration. A close that surprises somebody is a close
 * that gets reversed, and reversing one costs far more than reading a table
 * first did.
 */
export function Periods() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';

  const [start, setStart] = useState(() => defaultStart());
  const [end, setEnd] = useState(() => defaultEnd());
  const [book, setBook] = useState<PayeeType | 'all'>('all');

  const [preview, setPreview] = useState<ClosePreviewRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [result, setResult] = useState<CloseResultRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadInvoices = useCallback(async () => {
    try {
      setInvoices(await fetchInvoices());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load invoices.');
    }
  }, []);

  const loadPreview = useCallback(async () => {
    setBusy('preview');
    setError(null);
    setResult(null);
    try {
      setPreview(await previewClose(start, end, book === 'all' ? null : book));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build a preview.');
    } finally {
      setBusy(null);
    }
  }, [start, end, book]);

  useEffect(() => {
    void loadInvoices();
  }, [loadInvoices]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const totals = preview.reduce(
    (acc, r) => {
      const key = r.payee_type;
      acc[key] = (acc[key] ?? 0) + Number(r.total_cents ?? 0);
      acc.loads += Number(r.loads ?? 0);
      return acc;
    },
    { employee_driver: 0, subhauler: 0, loads: 0 } as Record<string, number>
  );

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

  return (
    <main className="periods">
      <header className="queue__head">
        <div>
          <h1>Close a period</h1>
          <p className="muted">
            Approved tickets become invoice lines. Nothing here recalculates
            pay — each ticket was priced once, when it was approved.
          </p>
        </div>
      </header>

      {error ? <p className="alert alert--bad">{error}</p> : null}

      <div className="closebar">
        <label className="field">
          <span className="fieldlabel">From</span>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="field">
          <span className="fieldlabel">To</span>
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <label className="field">
          <span className="fieldlabel">Book</span>
          <select
            value={book}
            onChange={(e) => setBook(e.target.value as PayeeType | 'all')}
          >
            <option value="all">Both books</option>
            <option value="employee_driver">Company drivers only</option>
            <option value="subhauler">Subhaulers only</option>
          </select>
        </label>
        <button className="btn btn--ghost" onClick={loadPreview} disabled={busy !== null}>
          {busy === 'preview' ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {/* ------------------------------------------------ the two books */}
      <div className="books">
        <div className="bookcard bookcard--employee_driver">
          <span className="fieldlabel">{PAYEE_LEDGER_LABEL.employee_driver}s</span>
          <strong>{formatCents(totals.employee_driver ?? 0)}</strong>
          <span className="muted">Goes to payroll</span>
        </div>
        <div className="bookcard bookcard--subhauler">
          <span className="fieldlabel">{PAYEE_LEDGER_LABEL.subhauler}s</span>
          <strong>{formatCents(totals.subhauler ?? 0)}</strong>
          <span className="muted">Goes to accounts payable</span>
        </div>
      </div>

      {preview.length === 0 ? (
        <p className="empty">
          No approved tickets dated in this window. Either the period is not
          worked yet, or the tickets are still waiting in the review queue.
        </p>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Payee</th>
                <th>Book</th>
                <th className="num">Loads</th>
                <th className="num">Tons</th>
                <th className="num">Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {preview.map((r) => (
                <tr key={`${r.payee_type}:${r.payee_id}`}>
                  <td>{r.payee_name}</td>
                  <td>
                    <span className={`book book--${r.payee_type}`}>
                      {PAYEE_LEDGER_LABEL[r.payee_type]}
                    </span>
                  </td>
                  <td className="num">{r.loads}</td>
                  <td className="num">{formatTons(r.total_tons)}</td>
                  <td className="num">{formatCents(r.total_cents)}</td>
                  <td>
                    {r.already_invoiced ? (
                      <span className="muted">already has an invoice</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="review__actions">
            <button
              className="btn btn--approve"
              disabled={busy !== null}
              onClick={() =>
                run('close', async () => {
                  const confirmed = window.confirm(
                    `Close ${formatDate(start)} – ${formatDate(end)}?\n\n` +
                      `${totals.loads} tickets across ${preview.length} payees ` +
                      `become invoice lines. Each ticket is locked to its invoice.`
                  );
                  if (!confirmed) return;

                  setResult(
                    await closePeriod(start, end, book === 'all' ? null : book)
                  );
                  await loadPreview();
                  await loadInvoices();
                })
              }
            >
              {busy === 'close' ? 'Closing…' : 'Close the period'}
            </button>
          </div>
        </>
      )}

      {result ? (
        <div className="alert alert--good">
          <strong>Closed</strong>
          <ul>
            {result.map((r) => (
              <li key={r.invoice_id}>
                {r.payee_name}: {r.loads} loads, {formatCents(r.total_cents)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* --------------------------------------------------- the invoices */}
      <h2 className="sectionhead">Invoices</h2>

      {invoices.length === 0 ? (
        <p className="empty">Nothing closed yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Payee</th>
              <th>Book</th>
              <th>Period</th>
              <th className="num">Loads</th>
              <th className="num">Total</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id}>
                <td>{i.payee_name}</td>
                <td>
                  <span className={`book book--${i.payee_type}`}>
                    {PAYEE_LEDGER_LABEL[i.payee_type]}
                  </span>
                </td>
                <td>
                  {formatDate(i.period_start)} – {formatDate(i.period_end)}
                </td>
                <td className="num">{i.line_count}</td>
                <td className="num">{formatCents(i.total_cents)}</td>
                <td>
                  <span
                    className={`pill pill--${
                      i.status === 'paid'
                        ? 'good'
                        : i.status === 'void'
                          ? 'bad'
                          : 'pending'
                    }`}
                  >
                    {i.status}
                  </span>
                </td>
                <td className="rowactions">
                  {i.status === 'draft' ? (
                    <button
                      className="btn btn--ghost"
                      disabled={busy !== null}
                      onClick={() =>
                        run('issue', async () => {
                          await issueInvoice(i.id);
                          await loadInvoices();
                        })
                      }
                    >
                      Issue
                    </button>
                  ) : null}

                  {/* Voiding releases the tickets back to approved and is
                      logged loudly. Admin only — see void_invoice() in 009. */}
                  {isAdmin && (i.status === 'draft' || i.status === 'issued') ? (
                    <button
                      className="btn btn--danger"
                      disabled={busy !== null}
                      onClick={() =>
                        run('void', async () => {
                          const reason = window.prompt(
                            'Why is this invoice being voided? This is recorded permanently.'
                          );
                          if (!reason) return;
                          await voidInvoice(i.id, reason);
                          await loadInvoices();
                          await loadPreview();
                        })
                      }
                    >
                      Void
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

/** Defaults to last week — the period most likely to be the one being closed. */
function defaultStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() - 7);
  return d.toISOString().slice(0, 10);
}

function defaultEnd(): string {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() - 1);
  return d.toISOString().slice(0, 10);
}
