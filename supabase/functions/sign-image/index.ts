import {
  authenticate,
  handleError,
  HttpError,
  json,
  preflight,
  serviceClient,
} from '../_shared/http.ts';

/**
 * Mint a short-lived URL for one tag image.
 *
 * The bucket is private and stays private. This is the only way anyone reads a
 * tag photo, which puts the permission check and the TTL in one place that a
 * client cannot lengthen.
 *
 * The check is not "is this person signed in" — it is "would RLS have let this
 * person select this tag". That question is answered by asking as them, with
 * their own token, rather than by re-implementing the policy here. A policy
 * copied into application code is a policy that drifts.
 */

const TTL_SECONDS = 60;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const origin = req.headers.get('Origin');

  try {
    const caller = await authenticate(req);

    const body = (await req.json().catch(() => ({}))) as { path?: string };
    const path = body.path;

    if (typeof path !== 'string' || path.length === 0) {
      throw new HttpError(400, 'No image path given.');
    }

    // company_id/tag_id/v{n}.jpg — anything else is not ours to sign.
    const parts = path.split('/');
    if (parts.length !== 3) {
      throw new HttpError(400, 'That is not a tag image path.');
    }
    const [companyId, tagId] = parts;

    if (companyId !== caller.companyId) {
      throw new HttpError(403, 'Not your company.');
    }

    // Ask as the caller. If RLS hides the tag from them, this returns nothing
    // and they get a 403 — the same answer they would get from the table.
    const { data: visible } = await caller.asUser
      .from('tags')
      .select('id')
      .eq('id', tagId)
      .maybeSingle();

    if (!visible) {
      throw new HttpError(403, 'You cannot see that ticket.');
    }

    // Confirm the path actually belongs to that tag, so a valid tag id cannot
    // be used to sign an arbitrary object under the same folder.
    const { data: image } = await serviceClient()
      .from('tag_images')
      .select('id')
      .eq('tag_id', tagId)
      .eq('image_path', path)
      .maybeSingle();

    if (!image) {
      throw new HttpError(404, 'No such image.');
    }

    const { data, error } = await serviceClient()
      .storage.from('tag-images')
      .createSignedUrl(path, TTL_SECONDS);

    if (error || !data) {
      throw new HttpError(500, 'Could not sign the image.');
    }

    return json({ url: data.signedUrl, expires_in: TTL_SECONDS }, 200, origin);
  } catch (err) {
    return handleError(err, origin);
  }
});
