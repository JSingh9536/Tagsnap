import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchQueue,
  type PayeeFilter,
  type QueueFilter,
} from '../lib/api';
import { supabase } from '../lib/supabase';
import {
  OFFICE_STATUS_LABEL,
  PAYEE_LABEL,
  STATUS_TONE,
  formatDate,
  formatTons,
  type TagWithRelations,
} from '@tagsnap/shared';

/**
 * The review queue.
 *
 * Ordered by what is blocking, oldest first — a tag that needs a person sits
 * above one that is merely waiting for an approval click, and both sit above
 * anything already sent back to the field.
 *
 * The payee filter is the useful one in practice. Employee settlements and
 * subhauler payables go out on different days to different systems, so being
 * able to work one book at a time is what makes a close manageable.
 */
export function Queue() {
  const [tags, setTags] = useState<TagWithRelations[]>([]);
  const [status, setStatus] = useState<QueueFilter>('all');
  const [payee, setPayee] = useState<PayeeFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTags(await fetchQueue(status, payee));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the queue.');
    } finally {
      setLoading(false);
    }
  }, [status, payee]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live, because two people working the same queue must not both open the
  // same tag and race each other to approve it.
  useEffect(() => {
    const channel = supabase
      .channel('queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tags' }, () =>
        void load()
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const counts = {
    needs_review: tags.filter((t) => t.status === 'needs_review').length,
    ready: tags.filter((t) => t.status === 'ready').length,
    rescan: tags.filter((t) => t.status === 'rescan_requested').length,
  };

  return (
    <main className="queue">
      <header className="queue__head">
        <div>
          <h1>Review queue</h1>
          <p className="muted">
            {counts.needs_review} need a person · {counts.ready} ready to approve
            · {counts.rescan} out for a rescan
          </p>
        </div>
      </header>

      <div className="filters">
        <Filters
          value={status}
          onChange={setStatus}
          options={[
            ['all', 'Everything'],
            ['needs_review', 'Needs review'],
            ['ready', 'Ready to approve'],
            ['rescan_requested', 'Out for rescan'],
          ]}
        />
        <Filters
          value={payee}
          onChange={setPayee}
          options={[
            ['all', 'Both books'],
            ['employee_driver', 'Company drivers'],
            ['subhauler', 'Subhaulers'],
          ]}
        />
      </div>

      {error ? <p className="alert alert--bad">{error}</p> : null}

      {loading && tags.length === 0 ? (
        <p className="muted">Loading…</p>
      ) : tags.length === 0 ? (
        <p className="empty">
          Nothing waiting. Every tag that has come in is either approved or out
          for a rescan.
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Ticket</th>
              <th>Date</th>
              <th>Quarry</th>
              <th>Material</th>
              <th className="num">Net</th>
              <th>Submitted by</th>
              <th>Book</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((tag) => (
              <tr key={tag.id} className={`row row--${STATUS_TONE[tag.status]}`}>
                <td>
                  <span className={`pill pill--${STATUS_TONE[tag.status]}`}>
                    {OFFICE_STATUS_LABEL[tag.status]}
                  </span>
                </td>
                <td>
                  <Link to={`/review/${tag.id}`} className="ticketlink">
                    {tag.ticket_number ? `#${tag.ticket_number}` : 'unread'}
                  </Link>
                </td>
                <td>{formatDate(tag.tag_date ?? tag.created_at)}</td>
                <td>{tag.quarries?.name ?? <em className="unmatched">unmatched</em>}</td>
                <td>{tag.materials?.name ?? <em className="unmatched">unmatched</em>}</td>
                <td className="num">{formatTons(tag.net_tons)}</td>
                <td>{tag.submitter?.full_name ?? '—'}</td>
                <td>
                  <span className={`book book--${tag.payee_type}`}>
                    {PAYEE_LABEL[tag.payee_type]}
                    {tag.subhaulers ? `: ${tag.subhaulers.name}` : ''}
                  </span>
                </td>
                <td className="why">
                  {tag.review_reasons.length > 0
                    ? `${tag.review_reasons.length} flag${tag.review_reasons.length === 1 ? '' : 's'}`
                    : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function Filters<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: [T, string][];
}) {
  return (
    <div className="segmented" role="group">
      {options.map(([v, label]) => (
        <button
          key={v}
          className={value === v ? 'on' : ''}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
