-- TagSnap — 012 the rate book
--
-- Backing for the rate management screen. `docs/BUILD-LOG.md` listed this as
-- "most likely first thing to want", and it was.
--
-- Three things the screen needs that did not exist:
--
--   rate_book       one query with the names joined and, crucially, how many
--                   loads each rate has already priced
--   preview_rate()  "what would this load pay?" — the resolution rules are
--                   subtle enough that guessing is not reasonable
--   supersede_rate() end the old row and start a new one, atomically
--
-- The idea running through all three: **a rate row is a historical record, not
-- a setting.** Editing one in place rewrites what past loads would have paid.
-- It does not rewrite what they *did* pay — approve_tag() freezes
-- computed_pay_cents and period close copies that frozen figure rather than
-- recomputing — but a rate table that disagrees with the settlements printed
-- off it is a table nobody can reconcile against six months later.
--
-- So the screen's primary verb is supersede, not edit.

-- ------------------------------------------------------------- the book
-- One row per rate, with everything the screen displays.
--
-- security_invoker so that the policies in 002 still apply: office and admin
-- see the whole book, a subhauler sees only rates naming their own outfit, and
-- a driver sees nothing at all. A view that bypassed that would hand every
-- driver the entire pricing table.

create or replace view rate_book
with (security_invoker = true) as
select
  r.id,
  r.company_id,
  r.payee_type,
  r.driver_id,
  r.subhauler_id,
  r.quarry_id,
  r.material_id,
  r.job_id,
  r.unit,
  r.rate_cents,
  r.effective_from,
  r.effective_to,
  r.source_row,

  p.full_name  as driver_name,
  s.name       as subhauler_name,
  q.name       as quarry_name,
  m.name       as material_name,
  j.name       as job_name,

  -- How many approved loads this rate has already priced.
  --
  -- The screen uses this to decide whether editing in place is honest. Zero
  -- means the row has never touched money and can be corrected freely; any
  -- other number means a settlement somewhere was calculated from it, and the
  -- right operation is to supersede rather than rewrite.
  (select count(*) from tags t where t.matched_rate_id = r.id) as loads_priced,

  -- Is this the row a load hauled today would match?
  (r.effective_from <= current_date
   and (r.effective_to is null or r.effective_to >= current_date)) as in_force,

  -- How specific this rate is, on the same count app.match_rate() orders by.
  -- Shown because "why did it pick that one?" is the question this screen
  -- exists to answer, and the answer is always "it was the most specific".
  ( (r.driver_id    is not null)::int
  + (r.subhauler_id is not null)::int
  + (r.quarry_id    is not null)::int
  + (r.material_id  is not null)::int
  + (r.job_id       is not null)::int ) as specificity

from rates r
left join profiles   p on p.id = r.driver_id
left join subhaulers s on s.id = r.subhauler_id
left join quarries   q on q.id = r.quarry_id
left join materials  m on m.id = r.material_id
left join jobs       j on j.id = r.job_id;

comment on view rate_book is
  'The rate table with names joined and usage counted. loads_priced = 0 means '
  'the row has never priced a settlement and can be corrected in place.';

-- --------------------------------------------------------------- preview
-- Which rate would win, and what would it pay?
--
-- app.match_rate() is deliberately not callable by a client — see 011, where
-- it stays revoked because it would otherwise hand any signed-in user every
-- company's pricing. This is the supervised way in: same resolution, but it
-- answers only for the caller's own company and only for office and admin.
--
-- Worth having rather than reimplementing the rules in TypeScript. Two
-- implementations of "most specific match wins" will disagree eventually, and
-- the one on the screen disagreeing with the one that computes pay is the
-- worst possible place for that to happen.

create or replace function preview_rate(
  p_payee_type payee_type,
  p_driver     uuid default null,
  p_subhauler  uuid default null,
  p_quarry     uuid default null,
  p_material   uuid default null,
  p_job        uuid default null,
  p_date       date default null,
  p_net_tons   numeric default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  co   uuid := app.current_company();
  on_d date := coalesce(p_date, current_date);
  r    rates;
begin
  if not app.is_office() then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  r := app.match_rate(co, p_payee_type, p_driver, p_subhauler,
                      p_quarry, p_material, p_job, on_d);

  if r.id is null then
    return jsonb_build_object(
      'rate_id', null,
      'matched', false,
      -- Said in the words the reviewer will see when this bites them for real:
      -- validate_tag() flags `no_rate_on_file`, and approving anyway would
      -- freeze a payment of zero.
      'why', 'No rate covers that combination on that date. A load like this '
             || 'would be held at no_rate_on_file rather than approved.'
    );
  end if;

  return jsonb_build_object(
    'rate_id', r.id,
    'matched', true,
    'unit', r.unit,
    'rate_cents', r.rate_cents,
    'effective_from', r.effective_from,
    'effective_to', r.effective_to,
    'specificity',
      (r.driver_id is not null)::int + (r.subhauler_id is not null)::int
    + (r.quarry_id is not null)::int + (r.material_id is not null)::int
    + (r.job_id is not null)::int,
    'pay_cents', case
      when p_net_tons is null then null
      else app.compute_pay_cents(r.unit, r.rate_cents, p_net_tons)
    end,
    'why', case r.unit
      when 'hour' then 'This rate is hourly. A scale ticket carries no hours, '
                       || 'so a load matching it cannot be priced automatically.'
      else null
    end
  );
end
$fn$;

grant execute on function preview_rate(
  payee_type, uuid, uuid, uuid, uuid, uuid, date, numeric
) to authenticated;

-- ------------------------------------------------------------- supersede
-- Raise a rate from a date. Two writes, one transaction.
--
-- Doing this from the client would be an update and an insert with a window
-- between them. Half-failing leaves either a gap where no rate applies — every
-- load in it held at no_rate_on_file — or an overlap where two rows of equal
-- specificity both match and the winner is decided by effective_from ordering
-- nobody intended. Neither is discoverable until somebody is paid wrongly.

create or replace function supersede_rate(
  p_rate_id    uuid,
  p_rate_cents integer,
  p_from       date
) returns rates
language plpgsql security definer set search_path = public as $fn$
declare
  old_rate rates;
  new_rate rates;
begin
  if not app.is_admin() then
    raise exception 'only an admin can change rates' using errcode = '42501';
  end if;

  select * into old_rate from rates
   where id = p_rate_id and company_id = app.current_company();

  if not found then
    raise exception 'rate not found' using errcode = 'P0002';
  end if;

  if p_rate_cents < 0 then
    raise exception 'a rate cannot be negative' using errcode = '22023';
  end if;

  -- The new rate has to start after the old one did, or the old row would end
  -- before it began and the check constraint on rates would reject it anyway —
  -- just with a less helpful message.
  if p_from <= old_rate.effective_from then
    raise exception
      'the new rate starts on % but the old one began on %; pick a later date',
      p_from, old_rate.effective_from
      using errcode = '22023';
  end if;

  if old_rate.effective_to is not null and old_rate.effective_to < p_from then
    raise exception 'that rate already ended on %', old_rate.effective_to
      using errcode = '22023';
  end if;

  -- Close the old row the day before the new one opens. No gap, no overlap.
  update rates
     set effective_to = p_from - 1
   where id = p_rate_id
   returning * into old_rate;

  insert into rates (
    company_id, payee_type, driver_id, subhauler_id, quarry_id, material_id,
    job_id, unit, rate_cents, effective_from, effective_to, source_row
  ) values (
    old_rate.company_id, old_rate.payee_type, old_rate.driver_id,
    old_rate.subhauler_id, old_rate.quarry_id, old_rate.material_id,
    old_rate.job_id, old_rate.unit, p_rate_cents, p_from, null,
    format('superseded %s (was %s cents)', p_rate_id, old_rate.rate_cents)
  )
  returning * into new_rate;

  return new_rate;
end
$fn$;

grant execute on function supersede_rate(uuid, integer, date) to authenticated;

-- ------------------------------------------------------------------ end
-- Stop a rate applying, without replacing it.
--
-- For a quarry you no longer haul from or an agreement that lapsed. Separate
-- from supersede because the consequences differ: after this, a load matching
-- only this rate is held rather than priced, and that should be a deliberate
-- choice rather than something that happens because a form was left blank.

create or replace function end_rate(p_rate_id uuid, p_on date default null)
returns rates
language plpgsql security definer set search_path = public as $fn$
declare
  r  rates;
  on_d date := coalesce(p_on, current_date);
begin
  if not app.is_admin() then
    raise exception 'only an admin can change rates' using errcode = '42501';
  end if;

  select * into r from rates
   where id = p_rate_id and company_id = app.current_company();

  if not found then
    raise exception 'rate not found' using errcode = 'P0002';
  end if;

  if on_d < r.effective_from then
    raise exception 'that rate began on %; it cannot end before it started',
      r.effective_from using errcode = '22023';
  end if;

  update rates set effective_to = on_d where id = p_rate_id returning * into r;
  return r;
end
$fn$;

grant execute on function end_rate(uuid, date) to authenticated;
