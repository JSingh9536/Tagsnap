-- TagSnap — 013 make the role guards fail closed
--
-- Found by calling `preview_rate` from 012 with nothing but the publishable
-- key. It answered. So did `supersede_rate`, which skipped its admin check and
-- fell through to a lookup.
--
-- The cause is three-valued logic, and it is worth writing down properly
-- because the code reads as though it is obviously correct.
--
--   app.current_role()  select role from profiles where id = auth.uid()
--                       -> NULL when there is no matching row
--   app.is_office()     select NULL in ('office','admin')
--                       -> NULL, not false
--   the guard           if not app.is_office() then raise ...
--                       -> `not NULL` is NULL
--                       -> the IF branch is not taken
--                       -> execution continues past the guard
--
-- A caller with no profile row — anonymous, or a signed-in user whose profile
-- was deleted or deactivated — walked straight through every one of these:
--
--   003  price_tag            (also past `not app.can_see_tag`)
--   003  learn_alias
--   009  preview_close, close_period, void_invoice
--   012  preview_rate, supersede_rate, end_rate
--
-- The RLS policies in 002 were never affected. A policy treats NULL as "no",
-- so `using (app.is_office() and ...)` filtered every row out exactly as
-- intended. This is specifically a hazard of the `if not <boolean> then raise`
-- pattern in plpgsql, which is why it looked fine in review: the same
-- expression is safe in one context and fails open in the other.
--
-- The fix is in the three helpers rather than in the nine call sites. Nine
-- edits is nine chances to miss one, and the next function somebody writes
-- would inherit the bug again.

-- --------------------------------------------------------------- the fix
-- `coalesce(..., false)`. Nothing else about these changes: they answer the
-- same question, they just answer "no" instead of "don't know" for a caller
-- the system has never heard of. For a policy that is the same answer it was
-- already giving; for a guard it is the difference between refusing and
-- allowing.

create or replace function app.is_office()
returns boolean
language sql stable as $fn$
  select coalesce(app.current_role() in ('office', 'admin'), false)
$fn$;

create or replace function app.is_admin()
returns boolean
language sql stable as $fn$
  select coalesce(app.current_role() = 'admin', false)
$fn$;

-- can_see_tag ends in `t.created_by = auth.uid()`, which is NULL rather than
-- false when there is no session at all — so an unauthenticated caller reached
-- `not NULL` and continued. Same treatment.
create or replace function app.can_see_tag(t tags)
returns boolean
language sql stable as $fn$
  select coalesce(
    case
      when app.is_office() then t.company_id = app.current_company()
      when app.current_role() = 'subhauler'
        then t.subhauler_id is not null
         and t.subhauler_id = app.current_subhauler()
      else t.created_by = auth.uid()
    end,
    false
  )
$fn$;

-- ------------------------------------------------------- belt and braces
-- The helpers above are the real fix. This is the second layer: a function
-- that moves money or reads pricing should refuse a caller with no session
-- before it evaluates anything else, so that a future change to the helpers
-- cannot quietly reopen the same door.
--
-- Deliberately a separate function rather than an inline `auth.uid() is null`
-- check, so that "who is allowed to call a privileged function at all" has one
-- definition and one place to change it.

create or replace function app.require_session()
returns void
language plpgsql stable as $fn$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
end
$fn$;

-- Callable by anyone who could already call the functions that use it; it
-- reveals nothing beyond whether the caller has a session, which they know.
grant execute on function app.require_session() to authenticated;

-- Re-issue the three functions from 012 with the session check in front. The
-- bodies are otherwise unchanged from that migration.

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
  perform app.require_session();

  if not app.is_office() then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  r := app.match_rate(co, p_payee_type, p_driver, p_subhauler,
                      p_quarry, p_material, p_job, on_d);

  if r.id is null then
    return jsonb_build_object(
      'rate_id', null,
      'matched', false,
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
  perform app.require_session();

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

create or replace function end_rate(p_rate_id uuid, p_on date default null)
returns rates
language plpgsql security definer set search_path = public as $fn$
declare
  r    rates;
  on_d date := coalesce(p_on, current_date);
begin
  perform app.require_session();

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

-- price_tag and learn_alias in 003, and the three period functions in 009, are
-- fixed by the coalesce above and are deliberately not re-issued here. Their
-- guards were correct code against a helper that lied; changing the helper is
-- the whole fix, and rewriting five function bodies to prove it would be five
-- more chances to introduce something new.
