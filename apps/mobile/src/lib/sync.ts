import * as FileSystem from 'expo-file-system';
import { supabase, accessToken } from './supabase';
import {
  markFailed,
  markSent,
  markUploading,
  outboxCount,
  pending,
  pruneSent,
  type OutboxRow,
} from './db';

/**
 * The upload worker.
 *
 * Runs whenever the app has connectivity and something is waiting. Three steps
 * per tag, in this order and for a reason:
 *
 *   1. create the `tags` row      — the storage policy in 004 checks that the
 *                                   tag exists and is not frozen, so the row
 *                                   has to land first
 *   2. upload the image           — straight to the private bucket
 *   3. create the `tag_images` row — this is what flips the tag into the
 *                                   extraction pipeline
 *
 * Every step is idempotent. Step 1 upserts on a client-generated primary key;
 * step 2 overwrites the same object path; step 3 is skipped if a row for that
 * path already exists. A worker killed mid-flight and restarted lands in the
 * same place.
 */

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const BUCKET = 'tag-images';

/** Give up on a row after this many tries and let the driver see it stuck. */
const MAX_ATTEMPTS = 8;

/** Exponential, capped. A dead zone lasts as long as it lasts. */
function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 5 * 60 * 1000);
}

let running = false;

export interface SyncResult {
  sent: number;
  failed: number;
  remaining: number;
}

export async function syncNow(companyId: string): Promise<SyncResult> {
  if (running) return { sent: 0, failed: 0, remaining: await outboxCount() };
  running = true;

  let sent = 0;
  let failed = 0;

  try {
    const rows = await pending();

    for (const row of rows) {
      if (row.attempts >= MAX_ATTEMPTS) continue;

      // Respect backoff without holding the worker open.
      const age = Date.now() - new Date(row.created_at).getTime();
      if (row.attempts > 0 && age < backoffMs(row.attempts)) continue;

      try {
        await markUploading(row.id);
        const tagId = await uploadOne(row, companyId);
        await markSent(row.id, tagId);
        sent++;
      } catch (err) {
        await markFailed(row.id, describe(err));
        failed++;
      }
    }

    for (const uri of await pruneSent()) {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {
        // The file is already gone, which is the outcome we wanted anyway.
      });
    }
  } finally {
    running = false;
  }

  return { sent, failed, remaining: await outboxCount() };
}

async function uploadOne(row: OutboxRow, companyId: string): Promise<string> {
  const isRescan = row.rescan_for_tag_id !== null;
  const tagId = row.rescan_for_tag_id ?? row.id;

  // --- 1. the tag row ----------------------------------------------------
  if (!isRescan) {
    const { error } = await supabase.from('tags').upsert(
      {
        id: tagId,
        company_id: companyId,
        payee_type: row.payee_type,
        driver_id: row.driver_id,
        subhauler_id: row.subhauler_id,
        source: 'driver_photo',
        status: 'uploaded',
        review_notes: row.note,
      },
      { onConflict: 'id', ignoreDuplicates: false }
    );

    // A duplicate primary key means a previous attempt already got this far.
    // That is success, not failure.
    if (error && !isDuplicate(error)) {
      throw new Error(`could not file the tag: ${error.message}`);
    }
  }

  // --- 2. the image ------------------------------------------------------
  const version = await nextVersion(tagId);
  const path = `${companyId}/${tagId}/v${version}.jpg`;

  const token = await accessToken();
  if (!token) throw new Error('signed out');

  const info = await FileSystem.getInfoAsync(row.local_uri, { size: true });
  if (!info.exists) {
    // The photo is gone from disk. Nothing to retry forever over.
    throw new Error('the photo is no longer on this device');
  }

  const res = await FileSystem.uploadAsync(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,
    row.local_uri,
    {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'image/jpeg',
        'x-upsert': 'true',
      },
    }
  );

  if (res.status >= 300) {
    throw new Error(`upload rejected (${res.status}): ${res.body?.slice(0, 200)}`);
  }

  // --- 3. the image row --------------------------------------------------
  // This is the step that makes the tag visible to the extractor, so it goes
  // last. If the process dies before it, step 2 just re-runs harmlessly.
  const { error: imgError } = await supabase.from('tag_images').insert({
    tag_id: tagId,
    version,
    image_path: path,
    bytes: 'size' in info ? info.size : null,
    captured_at: row.captured_at,
    captured_lat: row.captured_lat,
    captured_lng: row.captured_lng,
    uploaded_by: row.driver_id ?? (await currentUserId()),
    is_current: true,
  });

  if (imgError && !isDuplicate(imgError)) {
    throw new Error(`could not attach the photo: ${imgError.message}`);
  }

  return tagId;
}

/**
 * The next image version for a tag.
 *
 * The database assigns this too, in a trigger — this is only so the storage
 * path is predictable before the row exists. A collision is harmless because
 * the trigger has the final say on the version column.
 */
async function nextVersion(tagId: string): Promise<number> {
  const { data } = await supabase
    .from('tag_images')
    .select('version')
    .eq('tag_id', tagId)
    .order('version', { ascending: false })
    .limit(1);

  return (data?.[0]?.version ?? 0) + 1;
}

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('signed out');
  return data.user.id;
}

function isDuplicate(error: { code?: string; message?: string }): boolean {
  return (
    error.code === '23505' ||
    (error.message?.includes('duplicate key') ?? false)
  );
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
