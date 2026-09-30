import * as SQLite from 'expo-sqlite';

/**
 * The on-device queue.
 *
 * Quarries are frequently in dead zones and a driver cannot be blocked from
 * working, so capture writes here first and the network is somebody else's
 * problem. This table is the reason the app never shows a spinner over a photo
 * the driver has already taken.
 *
 * The row id is a client-generated UUID and it becomes the server-side tag id
 * verbatim. That makes it an idempotency key: a retry storm on a flaky tower
 * cannot create two rows for one ticket.
 */

export type OutboxState =
  | 'queued'      // on the device only
  | 'uploading'   // a worker has it
  | 'sent'        // server acknowledged; safe to prune the local copy
  | 'failed';     // gave up for now, will retry

export interface OutboxRow {
  id: string;
  /** file:// path to the JPEG in the app's own storage. */
  local_uri: string;
  state: OutboxState;
  /** null for a new tag; set when this photo answers a rescan request. */
  rescan_for_tag_id: string | null;
  payee_type: 'employee_driver' | 'subhauler';
  driver_id: string | null;
  subhauler_id: string | null;
  captured_at: string;
  captured_lat: number | null;
  captured_lng: number | null;
  note: string | null;
  attempts: number;
  last_error: string | null;
  /** Server tag id once created. Equal to `id` for new tags. */
  server_tag_id: string | null;
  created_at: string;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function db(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = open();
  return dbPromise;
}

async function open(): Promise<SQLite.SQLiteDatabase> {
  const handle = await SQLite.openDatabaseAsync('tagsnap.db');

  // WAL so a background upload writing progress cannot block the camera
  // screen writing a new capture.
  await handle.execAsync(`
    pragma journal_mode = WAL;
    pragma foreign_keys = on;

    create table if not exists outbox (
      id                text primary key not null,
      local_uri         text not null,
      state             text not null default 'queued',
      rescan_for_tag_id text,
      payee_type        text not null,
      driver_id         text,
      subhauler_id      text,
      captured_at       text not null,
      captured_lat      real,
      captured_lng      real,
      note              text,
      attempts          integer not null default 0,
      last_error        text,
      server_tag_id     text,
      created_at        text not null
    );

    create index if not exists outbox_pending
      on outbox (state, created_at);

    -- A read-through cache of what the server said about my tags, so the list
    -- screen has something to show before the first request comes back — and
    -- keeps showing it in a dead zone.
    create table if not exists tag_cache (
      id          text primary key not null,
      payload     text not null,
      cached_at   text not null
    );
  `);

  return handle;
}

export async function enqueue(
  row: Omit<OutboxRow, 'state' | 'attempts' | 'last_error' | 'server_tag_id' | 'created_at'>
): Promise<void> {
  const handle = await db();
  await handle.runAsync(
    `insert or replace into outbox
       (id, local_uri, state, rescan_for_tag_id, payee_type, driver_id,
        subhauler_id, captured_at, captured_lat, captured_lng, note,
        attempts, last_error, server_tag_id, created_at)
     values (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 0, null, null, ?)`,
    [
      row.id,
      row.local_uri,
      row.rescan_for_tag_id,
      row.payee_type,
      row.driver_id,
      row.subhauler_id,
      row.captured_at,
      row.captured_lat,
      row.captured_lng,
      row.note,
      new Date().toISOString(),
    ]
  );
}

/**
 * Rows worth trying now.
 *
 * `failed` rows come back too — a failure here almost always means "no signal",
 * which fixes itself. Backoff is applied by the worker, not by this query.
 */
export async function pending(limit = 20): Promise<OutboxRow[]> {
  const handle = await db();
  return handle.getAllAsync<OutboxRow>(
    `select * from outbox
      where state in ('queued', 'failed')
      order by created_at asc
      limit ?`,
    [limit]
  );
}

export async function allOutbox(): Promise<OutboxRow[]> {
  const handle = await db();
  return handle.getAllAsync<OutboxRow>(
    `select * from outbox where state <> 'sent' order by created_at desc`
  );
}

export async function outboxCount(): Promise<number> {
  const handle = await db();
  const row = await handle.getFirstAsync<{ n: number }>(
    `select count(*) as n from outbox where state <> 'sent'`
  );
  return row?.n ?? 0;
}

export async function markUploading(id: string): Promise<void> {
  const handle = await db();
  await handle.runAsync(
    `update outbox set state = 'uploading', attempts = attempts + 1 where id = ?`,
    [id]
  );
}

export async function markSent(id: string, serverTagId: string): Promise<void> {
  const handle = await db();
  await handle.runAsync(
    `update outbox set state = 'sent', server_tag_id = ?, last_error = null
      where id = ?`,
    [serverTagId, id]
  );
}

export async function markFailed(id: string, error: string): Promise<void> {
  const handle = await db();
  await handle.runAsync(
    `update outbox set state = 'failed', last_error = ? where id = ?`,
    [error.slice(0, 500), id]
  );
}

/**
 * Drop local copies of tags the server has confirmed.
 *
 * Deliberately lags by a day: if the office asks about a tag the morning
 * after, the original file is still on the phone.
 */
export async function pruneSent(): Promise<string[]> {
  const handle = await db();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const doomed = await handle.getAllAsync<{ id: string; local_uri: string }>(
    `select id, local_uri from outbox where state = 'sent' and created_at < ?`,
    [cutoff]
  );
  if (doomed.length > 0) {
    await handle.runAsync(
      `delete from outbox where state = 'sent' and created_at < ?`,
      [cutoff]
    );
  }
  return doomed.map((d) => d.local_uri);
}

export async function cacheTags(tags: { id: string }[]): Promise<void> {
  const handle = await db();
  const now = new Date().toISOString();
  await handle.withTransactionAsync(async () => {
    for (const tag of tags) {
      await handle.runAsync(
        `insert or replace into tag_cache (id, payload, cached_at) values (?, ?, ?)`,
        [tag.id, JSON.stringify(tag), now]
      );
    }
  });
}

export async function cachedTags<T>(): Promise<T[]> {
  const handle = await db();
  const rows = await handle.getAllAsync<{ payload: string }>(
    `select payload from tag_cache order by cached_at desc limit 200`
  );
  const out: T[] = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.payload) as T);
    } catch {
      // A corrupt cache row is not worth crashing the list screen over.
    }
  }
  return out;
}

/** Called on sign-out. The outbox survives — it is unsent work, not session state. */
export async function clearCache(): Promise<void> {
  const handle = await db();
  await handle.runAsync(`delete from tag_cache`);
}
