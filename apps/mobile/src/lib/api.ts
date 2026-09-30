import { supabase, FUNCTIONS_URL, accessToken } from './supabase';
import type { Invoice, Profile, TagWithRelations } from '@tagsnap/shared';

/**
 * Reads for the field app.
 *
 * Every one of these is scoped by Row Level Security rather than by a WHERE
 * clause here — a driver gets their own tags and a subhauler gets their
 * outfit's because the database says so, not because this file remembered to
 * filter. That is deliberate: a forgotten filter here would be a data leak,
 * and there is no way to forget a policy.
 */

const TAG_SELECT = `
  *,
  tag_images ( * ),
  rescan_requests ( * ),
  quarries ( id, name ),
  materials ( id, name, code ),
  jobs ( id, name, number ),
  trucks ( id, number, legal_capacity_tons, avg_tare_tons ),
  subhaulers ( id, name )
`;

export async function fetchMyProfile(): Promise<Profile> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('signed out');

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', auth.user.id)
    .single();

  if (error) throw new Error(error.message);
  if (!data.active) throw new Error('This account has been deactivated.');
  return data as Profile;
}

export async function fetchMyTags(limit = 100): Promise<TagWithRelations[]> {
  const { data, error } = await supabase
    .from('tags')
    .select(TAG_SELECT)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as TagWithRelations[];
}

/**
 * Tags the office has sent back.
 *
 * This is the one query the field app polls on a timer, because it is the only
 * state where the crew is blocking someone else.
 */
export async function fetchRescans(): Promise<TagWithRelations[]> {
  const { data, error } = await supabase
    .from('tags')
    .select(TAG_SELECT)
    .eq('status', 'rescan_requested')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as TagWithRelations[];
}

export async function fetchMyInvoices(): Promise<Invoice[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .order('period_start', { ascending: false })
    .limit(24);

  if (error) throw new Error(error.message);
  return (data ?? []) as Invoice[];
}

/**
 * A short-lived URL for one tag image.
 *
 * Goes through an edge function rather than straight to storage so the TTL and
 * the permission check live server-side, where a client cannot lengthen either.
 */
export async function signedImageUrl(imagePath: string): Promise<string> {
  const token = await accessToken();
  if (!token) throw new Error('signed out');

  const res = await fetch(`${FUNCTIONS_URL}/sign-image`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path: imagePath }),
  });

  if (!res.ok) {
    throw new Error(`could not load the photo (${res.status})`);
  }
  const body = (await res.json()) as { url: string };
  return body.url;
}

export function currentImage(tag: TagWithRelations) {
  return (
    tag.tag_images?.find((i) => i.is_current) ??
    tag.tag_images?.[tag.tag_images.length - 1] ??
    null
  );
}

export function openRescan(tag: TagWithRelations) {
  return (
    tag.rescan_requests?.find((r) => !r.resolved_at && !r.cancelled_at) ?? null
  );
}

/**
 * Live updates on my own tags.
 *
 * Without this the crew refreshes the list wondering whether the office has
 * seen it yet, which is the phone call this app exists to stop.
 */
export function subscribeToMyTags(
  userId: string,
  onChange: () => void
): () => void {
  const channel = supabase
    .channel(`tags:${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'tags',
        filter: `created_by=eq.${userId}`,
      },
      onChange
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}
