-- TagSnap — 010 on-device extraction
--
-- Replaces the paid vision call with OCR that runs on the phone: Apple Vision
-- on iOS, ML Kit on Android. Both are first-party, on-device, offline, and
-- free at any volume. Imaging cost for this system is now zero; the only money
-- left in the pipeline is object storage for the photos themselves.
--
-- What changes structurally: the server no longer *pulls* an image and reads
-- it. The device *pushes* a finished reading. That inverts one thing worth
-- being explicit about — the extraction now arrives from an untrusted client.
--
-- That is safe here, and it is worth saying exactly why, because "the client
-- does the OCR" sounds like a security regression:
--
--   * A driver could already type any number they liked. The old pipeline read
--     a photo the driver chose, of a ticket the driver selected, framed how the
--     driver framed it. The photo was never the trusted part.
--   * Nothing on this path can approve anything. apply_extraction() can only
--     move a tag to 'extracted', and the trigger in 005 immediately re-runs
--     every control server-side. The duplicate constraint, the arithmetic
--     check, the capacity check, the rate lookup and separation of duties are
--     all still enforced where a client cannot reach them.
--   * The photo is still uploaded, still retained, and still the evidence. A
--     submitted reading that disagrees with the photo is a reviewable lie with
--     the proof attached, which is a better position than before.
--
-- The one control that genuinely moved is confidence. A client could claim
-- 1.0 on everything and sail past the floors in validate_tag(). So the floors
-- are no longer the only gate: this migration adds a server-side agreement
-- check that does not consult the client's numbers at all.

-- ------------------------------------------------------------- teardown
-- The pull-based extractor and its backstop. Dropped rather than left inert,
-- because a trigger that fires at a function nobody deployed is a five-minute
-- cron job writing warnings into the log forever.

drop trigger if exists z_new_image_starts_extraction on tag_images;
drop function if exists app.extract_on_new_image();
drop function if exists app.request_extraction(uuid);

do $teardown$
begin
  perform cron.unschedule('tagsnap-retry-extractions');
exception when others then
  -- Never scheduled on this database. Nothing to undo.
  null;
end
$teardown$;

drop function if exists app.retry_stuck_extractions();

-- ---------------------------------------------------------- what read it
-- `model_version` used to hold a Claude model id. It now holds an OCR engine
-- id, which is a different kind of thing and deserves its own column rather
-- than a quietly repurposed one.

create type extraction_engine as enum (
  'apple_vision',   -- iOS / iPadOS, VNRecognizeTextRequest accurate mode
  'mlkit',          -- Android, ML Kit Text Recognition v2, bundled model
  'tesseract',      -- the office console, reading a scan in the browser
  'office_manual',  -- somebody in the office typed it in
  'quarry_feed'     -- arrived as data; never read from a picture at all
);

alter table tags
  add column engine          extraction_engine,
  add column engine_version  text,
  -- The full recognised text, exactly as the OCR returned it. Cheap to store,
  -- and it is what lets a reviewer search for a ticket by any word printed on
  -- it — including the ones this parser does not have a field for.
  add column ocr_text        text,
  -- How long the phone took. Watched because a regression here is felt by the
  -- driver standing at the scale house, not by a server.
  add column ocr_ms          integer;

create index tags_ocr_text_trgm on tags
  using gin (ocr_text gin_trgm_ops);

-- ------------------------------------------------------ agreement control
-- The floors in validate_tag() trust a number the client supplied. This does
-- not: it re-derives what it can from values alone and flags disagreement.
--
-- Deliberately narrow. It is not trying to re-do the OCR — it is checking that
-- a submitted reading is internally coherent and that the claimed confidence
-- is consistent with the evidence in the same payload.

create or replace function app.confidence_is_defensible(p_tag_id uuid)
returns text[]
language plpgsql stable security definer set search_path = public as $fn$
declare
  t        tags;
  reasons  text[] := '{}';
  conf     jsonb;
  txt      text;
  claimed  numeric;
begin
  select * into t from tags where id = p_tag_id;
  if not found then return reasons; end if;

  conf := coalesce(t.confidence, '{}'::jsonb);
  txt  := upper(coalesce(t.ocr_text, ''));

  -- A high-confidence value that does not appear anywhere in the recognised
  -- text was not read off this photo. Either the parser invented it or the
  -- payload was hand-made. Both need a person.
  if t.ticket_number is not null
     and coalesce((conf ->> 'ticket_number')::numeric, 0) >= 0.9
     and txt <> '' and position(upper(t.ticket_number) in txt) = 0 then
    reasons := reasons || 'value_not_in_ocr_text:ticket_number';
  end if;

  -- Claiming certainty on a weight while the three weights contradict each
  -- other is not a confident reading, whatever the number attached to it says.
  if t.gross_tons is not null and t.tare_tons is not null
     and t.net_tons is not null
     and abs((t.gross_tons - t.tare_tons) - t.net_tons) > 0.05 then
    claimed := greatest(
      coalesce((conf ->> 'gross_tons')::numeric, 0),
      coalesce((conf ->> 'tare_tons')::numeric, 0),
      coalesce((conf ->> 'net_tons')::numeric, 0)
    );
    if claimed >= 0.95 then
      reasons := reasons || 'confidence_contradicts_arithmetic';
    end if;
  end if;

  -- No recognised text at all, but fields came back full. That is a typed-in
  -- payload wearing an OCR costume.
  if t.engine in ('apple_vision', 'mlkit', 'tesseract')
     and coalesce(length(trim(coalesce(t.ocr_text, ''))), 0) < 10
     and t.net_tons is not null then
    reasons := reasons || 'no_ocr_text';
  end if;

  return reasons;
end
$fn$;

-- ------------------------------------------------------ location resolution
-- A quarry has a lat/lng in the schema and every capture records where it was
-- taken. Comparing the two costs nothing and resolves a vendor whose printed
-- name the parser could not match.
--
-- Equirectangular approximation, which is accurate to well under a metre at
-- the distances involved and needs no PostGIS. Defined before apply_extraction
-- because that function calls it.

create or replace function app.quarry_near_capture(
  p_tag_id uuid, p_max_metres integer default 750
) returns uuid
language sql stable security definer set search_path = public as $fn$
  with capture as (
    select ti.captured_lat as lat, ti.captured_lng as lng, t.company_id
      from tag_images ti
      join tags t on t.id = ti.tag_id
     where ti.tag_id = p_tag_id and ti.is_current
       and ti.captured_lat is not null and ti.captured_lng is not null
     limit 1
  )
  select q.id
    from quarries q, capture c
   where q.company_id = c.company_id and q.active
     and q.latitude is not null and q.longitude is not null
     and 6371000 * sqrt(
           power(radians(q.latitude - c.lat), 2)
         + power(radians(q.longitude - c.lng) * cos(radians(c.lat)), 2)
         ) <= p_max_metres
   order by
     6371000 * sqrt(
       power(radians(q.latitude - c.lat), 2)
     + power(radians(q.longitude - c.lng) * cos(radians(c.lat)), 2)
     ) asc
   limit 1
$fn$;

-- The same thing as a lookup a client can call while the camera is still open,
-- so the capture screen can say which quarry it thinks you are standing in.
create or replace function quarry_at(
  p_lat numeric, p_lng numeric, p_max_metres integer default 750
) returns table (id uuid, name text, metres integer)
language sql stable security definer set search_path = public as $fn$
  select q.id, q.name,
         (6371000 * sqrt(
            power(radians(q.latitude - p_lat), 2)
          + power(radians(q.longitude - p_lng) * cos(radians(p_lat)), 2)
          ))::integer
    from quarries q
   where q.company_id = app.current_company() and q.active
     and q.latitude is not null and q.longitude is not null
     and 6371000 * sqrt(
           power(radians(q.latitude - p_lat), 2)
         + power(radians(q.longitude - p_lng) * cos(radians(p_lat)), 2)
         ) <= p_max_metres
   order by 3 asc
   limit 3
$fn$;

grant execute on function quarry_at(numeric, numeric, integer) to authenticated;

-- ------------------------------------------------------------ the ingress
-- One call, from the device that took the photo, carrying what it read.
--
-- Everything this function is allowed to do is bounded: it writes reading
-- fields onto a tag the caller may already write to, and it lands the tag at
-- 'extracted'. It cannot approve, cannot price, cannot touch a frozen tag, and
-- cannot reach another company's rows.

create or replace function apply_extraction(
  p_tag_id     uuid,
  p_extracted  jsonb,
  p_confidence jsonb,
  p_engine     extraction_engine,
  p_engine_version text default null,
  p_ocr_text   text default null,
  p_ocr_ms     integer default null,
  p_raw        jsonb default null
) returns tags
language plpgsql security definer set search_path = public as $fn$
declare
  t          tags;
  me         uuid := auth.uid();
  my_company uuid := app.current_company();
  used       integer;
  q_id       uuid;
  m_id       uuid;
  j_id       uuid;
  tr_id      uuid;
  g          numeric;
  ta         numeric;
  n          numeric;
  extra      text[];
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select * into t from tags where id = p_tag_id;
  if not found then
    raise exception 'tag not found' using errcode = 'P0002';
  end if;
  if t.company_id is distinct from my_company then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if t.status in ('approved', 'invoiced') then
    raise exception 'that tag is approved and cannot be re-read'
      using errcode = '55006';
  end if;
  -- The submitter or the office. A driver reading someone else's tag would be
  -- reading a photo they are not allowed to see anyway.
  if t.created_by is distinct from me and not app.is_office() then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  -- Still metered. Nothing here costs money any more, but a phone in a retry
  -- loop can still write a great many rows.
  used := record_usage(me, my_company, 'extract', 60);
  if used > 120 then
    raise exception 'too many readings submitted; try again shortly'
      using errcode = '53400';
  end if;

  -- --- resolve free text to real records --------------------------------
  -- Unchanged from the old pipeline. This was never the model's job.
  q_id := resolve_entity('quarry',   my_company, p_extracted #>> '{quarry_text,value}');
  m_id := resolve_entity('material', my_company, p_extracted #>> '{material_text,value}');
  j_id := resolve_entity('job',      my_company, p_extracted #>> '{job_text,value}');

  select id into tr_id from trucks
   where company_id = my_company and active
     and number = trim(coalesce(p_extracted #>> '{truck_number,value}', ''))
   limit 1;

  -- A quarry the text could not resolve, but the photo was taken standing in
  -- one. Free signal the old pipeline never used, and it is recorded as a
  -- verification rather than silently applied, so a reviewer can see why.
  if q_id is null then
    q_id := app.quarry_near_capture(p_tag_id);
    if q_id is not null then
      insert into field_verifications (tag_id, field, source, agrees, detail)
      values (p_tag_id, 'quarry_id', 'gps', true,
              jsonb_build_object('resolved_by', 'capture_location',
                                 'quarry_id', q_id))
      on conflict (tag_id, field, source) do update
        set agrees = excluded.agrees, detail = excluded.detail, at = now();
    end if;
  end if;

  g  := nullif(p_extracted #>> '{gross_tons,value}', '')::numeric;
  ta := nullif(p_extracted #>> '{tare_tons,value}',  '')::numeric;
  n  := nullif(p_extracted #>> '{net_tons,value}',   '')::numeric;

  -- --- write the reading -------------------------------------------------
  -- status is set last, and to 'extracted' only. The trigger from 005 runs
  -- every control from there. There is no path out of this function to
  -- 'ready' or 'approved'.
  begin
    update tags
       set extracted      = p_extracted,
           confidence     = p_confidence,
           model_raw      = p_raw,
           engine         = p_engine,
           engine_version = p_engine_version,
           model_version  = p_engine::text || coalesce(' ' || p_engine_version, ''),
           ocr_text       = p_ocr_text,
           ocr_ms         = p_ocr_ms,
           extracted_at   = now(),
           ticket_number  = nullif(p_extracted #>> '{ticket_number,value}', ''),
           tag_date       = nullif(p_extracted #>> '{tag_date,value}', '')::date,
           quarry_id      = q_id,
           material_id    = m_id,
           job_id         = j_id,
           truck_id       = tr_id,
           gross_tons     = g,
           tare_tons      = ta,
           net_tons       = n,
           status         = 'extracted'
     where id = p_tag_id
     returning * into t;
  exception
    -- The duplicate-ticket constraint firing here is the control working: this
    -- ticket number already exists for this quarry. It is the most common way
    -- money leaks out of a haul operation, and it is caught at the storage
    -- layer where no client can bypass it.
    when unique_violation then
      update tags
         set extracted      = p_extracted,
             confidence     = p_confidence,
             engine         = p_engine,
             engine_version = p_engine_version,
             ocr_text       = p_ocr_text,
             extracted_at   = now(),
             status         = 'needs_review',
             review_reasons = array(select distinct unnest(
               review_reasons || 'duplicate_ticket')),
             review_notes   = format(
               'Ticket %s already exists for this quarry.',
               coalesce(p_extracted #>> '{ticket_number,value}', 'unknown'))
       where id = p_tag_id
       returning * into t;

      perform finish_usage(me, 'extract', true,
        jsonb_build_object('tag_id', p_tag_id, 'duplicate', true));
      return t;

    when check_violation then
      -- weights_are_consistent. Keep the reading, put the numbers that broke
      -- it on the review screen rather than losing the whole submission.
      update tags
         set extracted      = p_extracted,
             confidence     = p_confidence,
             engine         = p_engine,
             engine_version = p_engine_version,
             ocr_text       = p_ocr_text,
             extracted_at   = now(),
             status         = 'needs_review',
             review_reasons = array(select distinct unnest(
               review_reasons || 'weights_disagree'))
       where id = p_tag_id
       returning * into t;

      perform finish_usage(me, 'extract', true,
        jsonb_build_object('tag_id', p_tag_id, 'weights_disagree', true));
      return t;
  end;

  -- --- controls the client does not get a say in --------------------------
  extra := app.confidence_is_defensible(p_tag_id);
  if array_length(extra, 1) is not null then
    update tags
       set status = 'needs_review',
           review_reasons = array(select distinct unnest(review_reasons || extra))
     where id = p_tag_id;
  end if;

  -- The arithmetic check as a verification, same as before. Three fields
  -- checking each other with no external data — free, and it catches most
  -- digit errors on its own.
  if g is not null and ta is not null and n is not null then
    insert into field_verifications (tag_id, field, source, agrees, detail)
    values (p_tag_id, 'net_tons', 'arithmetic', abs(g - ta - n) <= 0.05,
            jsonb_build_object('gross', g, 'tare', ta, 'net', n))
    on conflict (tag_id, field, source) do update
      set agrees = excluded.agrees, detail = excluded.detail, at = now();
  end if;

  insert into field_verifications (tag_id, field, source, agrees, detail)
  values (p_tag_id, 'all', 'extraction', true,
          jsonb_build_object('engine', p_engine, 'version', p_engine_version,
                             'ms', p_ocr_ms))
  on conflict (tag_id, field, source) do update
    set detail = excluded.detail, at = now();

  perform finish_usage(me, 'extract', true,
    jsonb_build_object('tag_id', p_tag_id, 'engine', p_engine, 'ms', p_ocr_ms));

  select * into t from tags where id = p_tag_id;
  return t;
end
$fn$;

grant execute on function apply_extraction(
  uuid, jsonb, jsonb, extraction_engine, text, text, integer, jsonb
) to authenticated;

-- ------------------------------------------------ the phone could not read it
-- Called instead of apply_extraction when OCR came back with nothing usable.
-- The tag goes to a person with the photo attached, which is the same place a
-- refusal used to land it. Typing one ticket in by hand is a known cost; a
-- ticket sitting at 'uploaded' forever is not.

create or replace function extraction_failed(
  p_tag_id   uuid,
  p_engine   extraction_engine,
  p_reason   text,
  p_ocr_text text default null
) returns tags
language plpgsql security definer set search_path = public as $fn$
declare
  t  tags;
  me uuid := auth.uid();
begin
  select * into t from tags where id = p_tag_id;
  if not found then
    raise exception 'tag not found' using errcode = 'P0002';
  end if;
  if t.company_id is distinct from app.current_company()
     or (t.created_by is distinct from me and not app.is_office()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if t.status in ('approved', 'invoiced') then
    return t;
  end if;

  update tags
     set status         = 'needs_review',
         engine         = p_engine,
         ocr_text       = p_ocr_text,
         extracted_at   = now(),
         review_reasons = array(select distinct unnest(
           review_reasons || coalesce(nullif(p_reason, ''), 'ocr_unreadable'))),
         review_notes   = coalesce(review_notes || E'\n', '')
           || 'The phone could not read this photo. Type the fields in from the image.'
   where id = p_tag_id
   returning * into t;

  return t;
end
$fn$;

grant execute on function extraction_failed(uuid, extraction_engine, text, text)
  to authenticated;

-- --------------------------------------------------------------- the sweep
-- The old backstop retried a server call. There is no server call to retry
-- now, so this does the other useful thing: it stops a tag from being lost.
--
-- A tag that has had a photo for half an hour and still has no reading means
-- the phone died, was uninstalled, or hit a bug. Either way the photo is
-- already safe in the bucket and a person can read it in ten seconds.

create or replace function app.sweep_unread_tags()
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  n integer;
begin
  with stuck as (
    update tags t
       set status = 'needs_review',
           review_reasons = array(select distinct unnest(
             t.review_reasons || 'never_read')),
           review_notes = coalesce(t.review_notes || E'\n', '')
             || 'No reading arrived from the device. Type the fields in from the photo.'
     where t.status = 'uploaded'
       and t.created_at < now() - interval '30 minutes'
       and exists (select 1 from tag_images ti
                    where ti.tag_id = t.id and ti.is_current)
    returning 1
  )
  select count(*) into n from stuck;
  return n;
end
$fn$;

select cron.schedule(
  'tagsnap-sweep-unread',
  '*/10 * * * *',
  $cron$select app.sweep_unread_tags()$cron$
);

-- ------------------------------------------------------------- spend view
-- Kept, and now it measures something different: not dollars, but how much
-- reading the fleet is doing and how often it works. Extraction is free; the
-- number that matters became throughput and failure rate.

drop view if exists daily_extraction_spend;

create or replace view daily_extraction_health
with (security_invoker = true) as
select
  t.company_id,
  t.extracted_at::date                              as day,
  t.engine,
  count(*)                                          as readings,
  count(*) filter (where t.status = 'ready')        as clean,
  count(*) filter (where t.status = 'needs_review') as flagged,
  round(avg(t.ocr_ms))                              as avg_ms,
  round(avg((t.confidence ->> 'net_tons')::numeric), 3) as avg_net_confidence
from tags t
where t.extracted_at is not null
group by 1, 2, 3;

comment on view daily_extraction_health is
  'Reading throughput and how often it lands clean. The number to watch is '
  'clean / readings — the fraction of tickets nobody had to retype.';
