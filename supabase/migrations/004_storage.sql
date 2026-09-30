-- TagSnap — 004 private image bucket
--
-- Tag photos are financial evidence and carry customer names, job sites and
-- pricing. The bucket is private, forever. Reads happen through short-lived
-- signed URLs minted by the sign-image function after a permission check.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tag-images',
  'tag-images',
  false,
  15 * 1024 * 1024,                    -- 15 MB; a phone JPEG is ~2-5 MB
  array['image/jpeg', 'image/png', 'image/heic', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Path convention: company_id/tag_id/v{n}.jpg
-- Keying storage policies on the same identifiers as the table policies is
-- what keeps the two from drifting apart.

create or replace function app.storage_company_matches(name text)
returns boolean
language sql stable as $$
  select (string_to_array(name, '/'))[1] = app.current_company()::text
$$;

create or replace function app.storage_tag_id(name text)
returns uuid
language sql stable as $$
  select nullif((string_to_array(name, '/'))[2], '')::uuid
$$;

-- Upload: the caller must be able to see the tag the image belongs to, and the
-- tag must not be frozen. A driver therefore cannot write into another
-- driver's folder even with a valid token.
create policy tag_images_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'tag-images'
    and app.storage_company_matches(name)
    and exists (
      select 1 from tags t
      where t.id = app.storage_tag_id(name)
        and app.can_see_tag(t)
        and t.status not in ('approved', 'invoiced')
    )
  );

-- Direct reads are allowed only for office staff. Everyone else goes through
-- the signed-URL function, which is where the TTL is enforced.
create policy tag_images_office_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tag-images'
    and app.is_office()
    and app.storage_company_matches(name)
  );

-- No update or delete policy exists for any role. Destroying the image behind
-- a paid invoice destroys the evidence for it; superseding is done by adding a
-- version, not by overwriting one.
