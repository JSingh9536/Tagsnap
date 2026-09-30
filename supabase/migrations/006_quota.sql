-- TagSnap — 006 API usage metering
--
-- The extraction endpoint calls a paid API, so it needs a limit that holds
-- independently of whether the request is correct. Two things this protects:
-- a runaway retry loop producing a surprise invoice, and a compromised driver
-- token being used to burn credit.
--
-- Kept in its own table rather than counted off `audit_log`. The audit log
-- records mutations to money — inserts, updates, approvals — and an extraction
-- attempt that failed before writing anything is exactly the case a quota has
-- to count and an audit log has no reason to.

create table api_usage (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  actor_id   uuid not null,
  company_id uuid,
  action     text not null,        -- 'extract', 'sign_image', ...
  -- what it cost us, when we know. null while a call is in flight.
  cost_units integer,
  ok         boolean,
  detail     jsonb
);

create index api_usage_rate on api_usage (actor_id, action, at desc);
create index api_usage_spend on api_usage (company_id, at desc)
  where cost_units is not null;

alter table api_usage enable row level security;

-- Nobody reads or writes this through the API. The service role does both,
-- and admins get a read for the spend dashboard.
create policy api_usage_admin_read on api_usage
  for select using (app.is_admin() and company_id = app.current_company());

revoke insert, update, delete on api_usage from authenticated, anon;

/**
 * Record an attempt and return how many the actor has made in the window.
 *
 * Recording and counting in one statement matters: doing them as two calls
 * leaves a gap where two concurrent requests both read a count under the
 * limit and both proceed.
 */
create or replace function record_usage(
  p_actor uuid, p_company uuid, p_action text, p_window_minutes integer
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  used integer;
begin
  insert into api_usage (actor_id, company_id, action)
  values (p_actor, p_company, p_action);

  select count(*) into used
    from api_usage
   where actor_id = p_actor
     and action = p_action
     and at > now() - make_interval(mins => p_window_minutes);

  return used;
end
$$;

create or replace function finish_usage(
  p_actor uuid, p_action text, p_ok boolean, p_detail jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update api_usage
     set ok = p_ok, detail = p_detail
   where id = (
     select id from api_usage
      where actor_id = p_actor and action = p_action and ok is null
      order by at desc limit 1
   );
end
$$;

-- Callable by the service role only. There is deliberately no grant to
-- `authenticated` — a client that could call record_usage could also not call
-- it, which would make the limit optional.
revoke execute on function record_usage(uuid, uuid, text, integer) from public, anon, authenticated;
revoke execute on function finish_usage(uuid, text, boolean, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------- spend view
-- What extraction is costing, by day. The number to put an alert on.

create or replace view daily_extraction_spend
with (security_invoker = true) as
select
  company_id,
  date_trunc('day', at)::date as day,
  count(*)                     as calls,
  count(*) filter (where ok)   as succeeded,
  count(*) filter (where not ok) as failed
from api_usage
where action = 'extract'
group by company_id, date_trunc('day', at)::date;
