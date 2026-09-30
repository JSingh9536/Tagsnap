-- TagSnap — 005 entity resolution and post-extraction validation
--
-- "VULCAN MATLS #0123" has to become a quarry id. Trigram similarity against
-- an alias list that grows every time the office corrects a wrong match, which
-- is what makes this get better at your specific vendors over the first few
-- hundred tags without anyone training anything.

-- Below this, a match is a coincidence rather than a match. Tuned to be
-- deliberately conservative: an unresolved quarry costs a reviewer ten
-- seconds, and a wrongly resolved one prices the load against the wrong rate.
create or replace function app.match_floor() returns real
  language sql immutable as $$ select 0.42::real $$;

create or replace function resolve_entity(
  p_kind text, p_company uuid, p_text text
) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  needle text := upper(trim(p_text));
  hit    uuid;
begin
  if needle is null or length(needle) < 2 then
    return null;
  end if;

  case p_kind
    when 'quarry' then
      -- An exact alias hit wins outright; no need to score anything.
      select id into hit from quarries
       where company_id = p_company and active
         and (upper(name) = needle or needle = any(select upper(a) from unnest(aliases) a))
       limit 1;
      if hit is not null then return hit; end if;

      select id into hit from quarries
       where company_id = p_company and active
         and greatest(
               similarity(upper(name), needle),
               coalesce(similarity(app.alias_text(aliases), needle), 0)
             ) >= app.match_floor()
       order by greatest(
                  similarity(upper(name), needle),
                  coalesce(similarity(app.alias_text(aliases), needle), 0)
                ) desc
       limit 1;

    when 'material' then
      select id into hit from materials
       where company_id = p_company and active
         and (upper(name) = needle or upper(coalesce(code, '')) = needle
              or needle = any(select upper(a) from unnest(aliases) a))
       limit 1;
      if hit is not null then return hit; end if;

      select id into hit from materials
       where company_id = p_company and active
         and greatest(
               similarity(upper(name), needle),
               coalesce(similarity(app.alias_text(aliases), needle), 0)
             ) >= app.match_floor()
       order by greatest(
                  similarity(upper(name), needle),
                  coalesce(similarity(app.alias_text(aliases), needle), 0)
                ) desc
       limit 1;

    when 'job' then
      select id into hit from jobs
       where company_id = p_company and active
         and (upper(name) = needle or upper(coalesce(number, '')) = needle
              or needle = any(select upper(a) from unnest(aliases) a))
       limit 1;
      if hit is not null then return hit; end if;

      select id into hit from jobs
       where company_id = p_company and active
         and greatest(
               similarity(upper(name), needle),
               coalesce(similarity(app.alias_text(aliases), needle), 0)
             ) >= app.match_floor()
       order by greatest(
                  similarity(upper(name), needle),
                  coalesce(similarity(app.alias_text(aliases), needle), 0)
                ) desc
       limit 1;

    else
      raise exception 'unknown entity kind %', p_kind;
  end case;

  return hit;
end
$$;

grant execute on function resolve_entity(text, uuid, text) to authenticated;

-- --------------------------------------------------- post-extraction controls
-- The controls from Trucktags/docs/ARCHITECTURE.md section 6, run as one step
-- once the model has read the tag. This decides whether a person needs to look
-- — never whether to pay. There is no path from here to 'approved'.

create or replace function validate_tag(p_tag_id uuid)
returns tags
language plpgsql security definer set search_path = public as $$
declare
  t         tags;
  truck     trucks;
  reasons   text[] := '{}';
  conf      jsonb;
  c         numeric;
  fld       text;
  pay_critical constant text[] :=
    array['net_tons', 'material_text', 'quarry_text', 'job_text'];
begin
  select * into t from tags where id = p_tag_id;
  if not found then
    raise exception 'tag not found' using errcode = 'P0002';
  end if;
  if t.status in ('approved', 'invoiced') then
    return t;   -- frozen; nothing to say about it
  end if;

  conf := coalesce(t.confidence, '{}'::jsonb);

  -- confidence floors. fields that feed the pay calculation are held higher:
  -- a misread job name is an annoyance, a misread tonnage is a wrong payment.
  for fld in select jsonb_object_keys(conf) loop
    c := (conf ->> fld)::numeric;
    if fld = any(pay_critical) then
      if c < 0.95 then
        reasons := reasons || format('low_confidence:%s', fld);
      end if;
    elsif c < 0.90 then
      reasons := reasons || format('low_confidence:%s', fld);
    end if;
  end loop;

  -- arithmetic. free, and it catches most digit errors on its own.
  if t.gross_tons is not null and t.tare_tons is not null
     and t.net_tons is not null
     and abs((t.gross_tons - t.tare_tons) - t.net_tons) > 0.05 then
    reasons := reasons || 'weights_disagree';
  end if;

  -- impossible loads, and transcription errors like 223.2 for 22.32
  if t.truck_id is not null then
    select * into truck from trucks where id = t.truck_id;
    if truck.legal_capacity_tons is not null and t.net_tons is not null
       and t.net_tons > truck.legal_capacity_tons then
      reasons := reasons || 'over_capacity';
    end if;
    if truck.avg_tare_tons is not null and t.tare_tons is not null
       and abs(t.tare_tons - truck.avg_tare_tons) > 0.5 then
      reasons := reasons || 'tare_unusual';
    end if;
  end if;

  if t.net_tons is null or t.net_tons <= 0 then
    reasons := reasons || 'net_tons_missing';
  end if;

  -- dates: not in the future, not stale enough to be resurfacing after a
  -- period was closed and paid
  if t.tag_date is null then
    reasons := reasons || 'tag_date_missing';
  elsif t.tag_date > current_date + 1 then
    reasons := reasons || 'future_date';
  elsif t.tag_date < current_date - 45 then
    reasons := reasons || 'stale_date';
  end if;

  if t.quarry_id is null then reasons := reasons || 'quarry_unresolved'; end if;
  if t.material_id is null then reasons := reasons || 'material_unresolved'; end if;
  if t.ticket_number is null then reasons := reasons || 'ticket_number_missing'; end if;

  -- a rate has to exist, or we would silently pay zero.
  -- the parentheses are load-bearing: field access on a function returning a
  -- composite type is a syntax error without them.
  if (app.match_rate(t.company_id, t.payee_type, t.driver_id, t.subhauler_id,
                     t.quarry_id, t.material_id, t.job_id,
                     coalesce(t.tag_date, current_date))).id is null then
    reasons := reasons || 'no_rate_on_file';
  end if;

  update tags
     set review_reasons = reasons,
         status = case
           when array_length(reasons, 1) is null then 'ready'
           else 'needs_review'
         end
   where id = p_tag_id
   returning * into t;

  return t;
end
$$;

grant execute on function validate_tag(uuid) to authenticated;

-- Validation follows extraction automatically. Doing it in a trigger rather
-- than in the edge function means a tag corrected by hand in the console gets
-- re-checked on the same rules, with no second code path to keep in sync.
create or replace function app.validate_after_extract()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'extracted' and old.status is distinct from 'extracted' then
    perform validate_tag(new.id);
  end if;
  return new;
end
$$;

create trigger extraction_runs_controls
  after update of status on tags
  for each row execute function app.validate_after_extract();
