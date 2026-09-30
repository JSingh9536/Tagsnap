-- TagSnap — 003 audit triggers, rescan workflow, rate matching, approval
--
-- Everything in this file exists because it must not be possible to skip it.
-- Application code that "remembers" to write an audit row or "remembers" to
-- check separation of duties is application code that will one day forget.

-- ---------------------------------------------------------------- audit log

create or replace function app.audit()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  arole user_role;
begin
  select role into arole from profiles where id = actor;

  insert into audit_log (actor_id, actor_role, table_name, row_id, action,
                         before, after, source)
  values (
    actor,
    arole,
    tg_table_name,
    coalesce((to_jsonb(new) ->> 'id'), (to_jsonb(old) ->> 'id')),
    lower(tg_op),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end,
    case when actor is null then 'system' else 'app' end
  );

  return coalesce(new, old);
end
$$;

create trigger audit_tags
  after insert or update or delete on tags
  for each row execute function app.audit();

create trigger audit_rates
  after insert or update or delete on rates
  for each row execute function app.audit();

create trigger audit_invoices
  after insert or update or delete on invoices
  for each row execute function app.audit();

create trigger audit_rescans
  after insert or update on rescan_requests
  for each row execute function app.audit();

create trigger audit_profiles
  after insert or update on profiles
  for each row execute function app.audit();

-- ---------------------------------------------------------- image versioning
-- A new image supersedes the previous one automatically, and assigns its own
-- version number. The client never picks a version, so two devices uploading
-- at once cannot collide on one.

create or replace function app.supersede_prior_image()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.version is null or new.version = 0 then
    select coalesce(max(version), 0) + 1 into new.version
    from tag_images where tag_id = new.tag_id;
  end if;

  if new.is_current then
    update tag_images
       set is_current = false
     where tag_id = new.tag_id and is_current and id <> new.id;
  end if;

  return new;
end
$$;

create trigger tag_images_versioning
  before insert on tag_images
  for each row execute function app.supersede_prior_image();

-- ------------------------------------------------------- rescan round trip
-- Raising a request pushes the tag back to the field. Uploading a fresh image
-- against a tag with an open request closes it and re-enters the pipeline.

create or replace function app.open_rescan()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update tags
     set status = 'rescan_requested',
         review_notes = coalesce(new.note, review_notes)
   where id = new.tag_id;
  return new;
end
$$;

create trigger rescan_pushes_tag_back
  after insert on rescan_requests
  for each row execute function app.open_rescan();

create or replace function app.close_rescan_on_new_image()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  open_req uuid;
begin
  select id into open_req
    from rescan_requests
   where tag_id = new.tag_id
     and resolved_at is null
     and cancelled_at is null
   limit 1;

  if open_req is not null then
    update rescan_requests
       set resolved_at = now(),
           resolved_by = new.uploaded_by,
           new_image_id = new.id
     where id = open_req;

    -- Back to the start of the pipeline. The extractor picks it up from
    -- 'uploaded'; the prior extraction is left in place until it is replaced,
    -- so nothing is lost if the second read fails.
    update tags
       set status = 'uploaded',
           rescan_count = rescan_count + 1,
           review_reasons = '{}'
     where id = new.tag_id;
  end if;

  return new;
end
$$;

create trigger new_image_closes_rescan
  after insert on tag_images
  for each row execute function app.close_rescan_on_new_image();

-- ------------------------------------------------------------ rate matching
-- Most specific match wins. NULL in a matching column is a wildcard, so a row
-- scoped to (quarry, material) beats a row scoped to (quarry) alone.
-- payee_type is never a wildcard.

create or replace function app.match_rate(
  p_company    uuid,
  p_payee_type payee_type,
  p_driver     uuid,
  p_subhauler  uuid,
  p_quarry     uuid,
  p_material   uuid,
  p_job        uuid,
  p_date       date
) returns rates
language sql stable security definer set search_path = public as $$
  select r.*
    from rates r
   where r.company_id = p_company
     and r.payee_type = p_payee_type
     and r.effective_from <= p_date
     and (r.effective_to is null or r.effective_to >= p_date)
     and (r.driver_id    is null or r.driver_id    = p_driver)
     and (r.subhauler_id is null or r.subhauler_id = p_subhauler)
     and (r.quarry_id    is null or r.quarry_id    = p_quarry)
     and (r.material_id  is null or r.material_id  = p_material)
     and (r.job_id       is null or r.job_id       = p_job)
   order by
     (r.driver_id    is not null)::int
   + (r.subhauler_id is not null)::int
   + (r.quarry_id    is not null)::int
   + (r.material_id  is not null)::int
   + (r.job_id       is not null)::int desc,
     r.effective_from desc
   limit 1
$$;

-- What we owe for one load. Deliberately recomputed from net tons and our own
-- rate table — never read off the ticket, because the dollar figure printed on
-- a scale ticket is the quarry billing the customer, not us paying the hauler.
create or replace function app.compute_pay_cents(
  p_unit rate_unit, p_rate_cents integer, p_net_tons numeric
) returns integer
language sql immutable as $$
  select case p_unit
    when 'ton'  then round(p_rate_cents * coalesce(p_net_tons, 0))::int
    when 'load' then p_rate_cents
    else null      -- hourly needs hours, which a scale ticket does not carry
  end
$$;

-- ---------------------------------------------------------------- approval
-- The one action that turns a suggestion into a financial record. Runs as a
-- single transaction so a tag can never be half-approved.
--
-- Separation of duties is checked here AND enforced by the table constraint
-- `approver_is_not_submitter`. Two layers, because this one moves money.

create or replace function approve_tag(p_tag_id uuid)
returns tags
language plpgsql security definer set search_path = public as $$
declare
  t        tags;
  r        rates;
  pay      integer;
  actor    uuid := auth.uid();
  arole    user_role;
begin
  select role into arole from profiles where id = actor and active;
  if arole not in ('office', 'admin') then
    raise exception 'only office or admin may approve tags'
      using errcode = '42501';
  end if;

  select * into t from tags where id = p_tag_id for update;
  if not found then
    raise exception 'tag not found' using errcode = 'P0002';
  end if;

  if t.status in ('approved', 'invoiced') then
    raise exception 'tag is already approved and is now immutable'
      using errcode = '55006';
  end if;

  if t.created_by = actor then
    raise exception 'separation of duties: you cannot approve a tag you submitted'
      using errcode = '42501';
  end if;

  if exists (
    select 1 from rescan_requests
     where tag_id = p_tag_id and resolved_at is null and cancelled_at is null
  ) then
    raise exception 'a rescan is still outstanding on this tag'
      using errcode = '55006';
  end if;

  if t.net_tons is null or t.quarry_id is null or t.tag_date is null then
    raise exception 'tag is missing fields required to price it'
      using errcode = '23502';
  end if;

  r := app.match_rate(t.company_id, t.payee_type, t.driver_id, t.subhauler_id,
                      t.quarry_id, t.material_id, t.job_id, t.tag_date);
  if r.id is null then
    raise exception 'no rate on file for this load on %', t.tag_date
      using errcode = 'P0002';
  end if;

  pay := app.compute_pay_cents(r.unit, r.rate_cents, t.net_tons);
  if pay is null then
    raise exception 'rate unit % cannot be priced from a scale ticket alone',
      r.unit using errcode = '22023';
  end if;

  update tags
     set status = 'approved',
         matched_rate_id = r.id,
         computed_pay_cents = pay,
         approved_by = actor,
         approved_at = now()
   where id = p_tag_id
   returning * into t;

  insert into field_verifications (tag_id, field, source, agrees, detail)
  values (p_tag_id, '*', 'human', true,
          jsonb_build_object('approved_by', actor, 'rate_id', r.id))
  on conflict (tag_id, field, source) do update
     set agrees = excluded.agrees, detail = excluded.detail, at = now();

  return t;
end
$$;

revoke execute on function approve_tag(uuid) from anon;
grant execute on function approve_tag(uuid) to authenticated;

-- ------------------------------------------------------- what a tag is worth
-- A preview of the above without committing to it, so the review screen can
-- show the reviewer the number before they approve.

create or replace function price_tag(p_tag_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  t tags; r rates; pay integer;
begin
  select * into t from tags where id = p_tag_id;
  if not found or not app.can_see_tag(t) then
    raise exception 'tag not found' using errcode = 'P0002';
  end if;
  if not app.is_office() then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  r := app.match_rate(t.company_id, t.payee_type, t.driver_id, t.subhauler_id,
                      t.quarry_id, t.material_id, t.job_id, t.tag_date);
  pay := app.compute_pay_cents(r.unit, r.rate_cents, t.net_tons);

  return jsonb_build_object(
    'rate_id',    r.id,
    'unit',       r.unit,
    'rate_cents', r.rate_cents,
    'net_tons',   t.net_tons,
    'pay_cents',  pay,
    'payee_type', t.payee_type
  );
end
$$;

grant execute on function price_tag(uuid) to authenticated;

-- ------------------------------------------------------- tare self-learning
-- A truck's tare barely changes, so its running average becomes a free
-- verification signal for the next load. (Trucktags/docs/INGESTION.md tier 3)

create or replace function app.update_truck_tare()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'approved' and new.truck_id is not null
     and new.tare_tons is not null then
    update trucks
       set avg_tare_tons = round(
             (coalesce(avg_tare_tons, new.tare_tons) * 0.8
              + new.tare_tons * 0.2)::numeric, 2)
     where id = new.truck_id;
  end if;
  return new;
end
$$;

create trigger tare_history_learns
  after update of status on tags
  for each row when (new.status = 'approved')
  execute function app.update_truck_tare();

-- --------------------------------------------------------- alias learning
-- Every time the office corrects a resolution, the raw OCR text is appended to
-- that entity's alias list. The system gets measurably better at your specific
-- vendors over the first few hundred tags with nobody training anything.

create or replace function learn_alias(
  p_kind text, p_entity_id uuid, p_raw_text text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not app.is_office() then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_raw_text is null or length(trim(p_raw_text)) < 2 then
    return;
  end if;

  case p_kind
    when 'quarry' then
      update quarries set aliases = array(select distinct unnest(aliases || p_raw_text))
       where id = p_entity_id and company_id = app.current_company();
    when 'material' then
      update materials set aliases = array(select distinct unnest(aliases || p_raw_text))
       where id = p_entity_id and company_id = app.current_company();
    when 'job' then
      update jobs set aliases = array(select distinct unnest(aliases || p_raw_text))
       where id = p_entity_id and company_id = app.current_company();
    else
      raise exception 'unknown entity kind %', p_kind;
  end case;
end
$$;

grant execute on function learn_alias(text, uuid, text) to authenticated;
