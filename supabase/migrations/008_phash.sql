-- TagSnap — 008 re-photograph detection
--
-- The unique constraint on (quarry_id, ticket_number) catches the same ticket
-- submitted twice. It does not catch the same physical ticket photographed
-- from a different angle and filed with a mistyped ticket number, which is the
-- version of that trick someone actually tries.
--
-- A perceptual hash catches it, because the two photos are visually the same
-- document even though the files differ entirely. Computed in the extract
-- function; compared here.

-- Hamming distance between two 64-bit hashes: how many bits differ.
-- Identical images are 0. The same ticket re-shot at an angle lands in the
-- low single digits. Different documents are typically well above 20.
create or replace function app.phash_distance(a bigint, b bigint)
returns integer
language sql immutable as $$
  select bit_count((a # b)::bit(64))::integer
$$;

-- Below this, two photos are the same piece of paper.
-- Deliberately tight: a false positive sends a legitimate load to review,
-- which costs ten seconds. Set it loose and you start blocking real loads
-- from the same quarry that happen to look alike.
create or replace function app.phash_threshold() returns integer
  language sql immutable as $$ select 8 $$;

/**
 * Other tags in this company whose current photo looks like this one.
 *
 * Excludes the tag being checked and anything already rejected — a rejected
 * tag is one somebody already looked at and dismissed, and flagging its
 * replacement as a duplicate of it would be exactly backwards.
 */
create or replace function similar_tag_images(
  p_tag_id uuid, p_phash bigint
) returns table (tag_id uuid, distance integer, ticket_number text, status tag_status)
language sql stable security definer set search_path = public as $$
  select t.id,
         app.phash_distance(ti.image_phash, p_phash),
         t.ticket_number,
         t.status
    from tag_images ti
    join tags t on t.id = ti.tag_id
   where ti.is_current
     and ti.image_phash is not null
     and ti.tag_id <> p_tag_id
     and t.status <> 'rejected'
     and t.company_id = (select company_id from tags where id = p_tag_id)
     and app.phash_distance(ti.image_phash, p_phash) <= app.phash_threshold()
   order by 2 asc
   limit 5
$$;

grant execute on function similar_tag_images(uuid, bigint) to authenticated;

/**
 * Record the finding as a verification and flag the tag if it matched.
 *
 * Called by the extract function once it has a hash. Kept in SQL rather than
 * in the function so the reason lands in `review_reasons` the same way every
 * other control's does — one place decides what a flagged tag looks like.
 */
create or replace function check_image_duplicate(p_tag_id uuid, p_phash bigint)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  hits integer;
  best record;
begin
  select count(*) into hits from similar_tag_images(p_tag_id, p_phash);

  insert into field_verifications (tag_id, field, source, agrees, detail)
  values (p_tag_id, 'image', 'second_pass', hits = 0,
          jsonb_build_object('phash', p_phash, 'matches', hits))
  on conflict (tag_id, field, source) do update
     set agrees = excluded.agrees, detail = excluded.detail, at = now();

  if hits > 0 then
    select * into best from similar_tag_images(p_tag_id, p_phash) limit 1;

    update tags
       set status = case when status in ('approved','invoiced')
                         then status else 'needs_review' end,
           review_reasons = array(
             select distinct unnest(review_reasons || 'possible_rephotograph')
           ),
           review_notes = coalesce(review_notes || E'\n', '')
             || format('This photo looks like the one on ticket %s (%s), %s bits different.',
                       coalesce(best.ticket_number, 'unknown'),
                       best.status, best.distance)
     where id = p_tag_id;
  end if;

  return hits;
end
$$;

grant execute on function check_image_duplicate(uuid, bigint) to authenticated;
