-- TagSnap — 002 row level security
--
-- Deny by default on every table. These rules hold even when someone bypasses
-- the mobile client and calls PostgREST directly with a valid token — which
-- should be assumed, since the anon key ships inside the app bundle.
--
-- The separation that matters most here: a subhauler may see the loads their
-- own outfit hauled and nothing else. Two subhaulers must never see each
-- other's tonnage or pay, because that is competitive information.

-- ------------------------------------------------------------- helpers
-- Defined security definer so a caller cannot see the profiles rows these read.
-- Marked stable so Postgres caches them per statement instead of per row.

create schema if not exists app;

create or replace function app.current_role()
returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active
$$;

create or replace function app.current_company()
returns uuid
language sql stable security definer set search_path = public as $$
  select company_id from profiles where id = auth.uid() and active
$$;

create or replace function app.current_subhauler()
returns uuid
language sql stable security definer set search_path = public as $$
  select subhauler_id from profiles where id = auth.uid() and active
$$;

create or replace function app.is_office()
returns boolean
language sql stable as $$
  select app.current_role() in ('office', 'admin')
$$;

create or replace function app.is_admin()
returns boolean
language sql stable as $$
  select app.current_role() = 'admin'
$$;

-- Can the current user see this tag at all?
--   office/admin : anything in their company
--   subhauler    : anything hauled by their outfit
--   driver       : only what they submitted
create or replace function app.can_see_tag(t tags)
returns boolean
language sql stable as $$
  select case
    when app.is_office() then t.company_id = app.current_company()
    when app.current_role() = 'subhauler'
      then t.subhauler_id is not null
       and t.subhauler_id = app.current_subhauler()
    else t.created_by = auth.uid()
  end
$$;

grant usage on schema app to authenticated;

-- ------------------------------------------------------------ enable RLS

alter table companies          enable row level security;
alter table subhaulers         enable row level security;
alter table profiles           enable row level security;
alter table quarries           enable row level security;
alter table materials          enable row level security;
alter table jobs               enable row level security;
alter table trucks             enable row level security;
alter table rates              enable row level security;
alter table tags               enable row level security;
alter table tag_images         enable row level security;
alter table rescan_requests    enable row level security;
alter table field_verifications enable row level security;
alter table invoices           enable row level security;
alter table invoice_lines      enable row level security;
alter table audit_log          enable row level security;

-- --------------------------------------------------------------- identity

create policy own_company_readable on companies
  for select using (id = app.current_company());

-- A subhauler sees their own outfit's record; the office sees all of them.
create policy subhaulers_visible on subhaulers
  for select using (
    company_id = app.current_company()
    and (app.is_office() or id = app.current_subhauler())
  );

create policy subhaulers_admin_writes on subhaulers
  for all using (app.is_admin() and company_id = app.current_company())
  with check (app.is_admin() and company_id = app.current_company());

-- Everyone reads their own profile. The office reads the whole roster.
-- A driver may NOT enumerate other drivers.
create policy profiles_readable on profiles
  for select using (
    id = auth.uid()
    or (app.is_office() and company_id = app.current_company())
    or (app.current_role() = 'subhauler'
        and subhauler_id is not null
        and subhauler_id = app.current_subhauler())
  );

-- Self-service edits are limited to contact details. Role and company are
-- deliberately not settable from the client — a driver promoting themselves to
-- office is exactly the escalation this blocks.
create policy profiles_update_own_contact on profiles
  for update using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = (select role from profiles p where p.id = auth.uid())
    and company_id = (select company_id from profiles p where p.id = auth.uid())
    and subhauler_id is not distinct from
        (select subhauler_id from profiles p where p.id = auth.uid())
    and active
  );

create policy profiles_admin_writes on profiles
  for all using (app.is_admin() and company_id = app.current_company())
  with check (app.is_admin() and company_id = app.current_company());

-- --------------------------------------------------------- reference data
-- Field users need to read these to label a tag; only admin may change them.

create policy quarries_read on quarries
  for select using (company_id = app.current_company());
create policy quarries_admin_write on quarries
  for all using (app.is_admin() and company_id = app.current_company())
  with check (app.is_admin() and company_id = app.current_company());

create policy materials_read on materials
  for select using (company_id = app.current_company());
create policy materials_admin_write on materials
  for all using (app.is_admin() and company_id = app.current_company())
  with check (app.is_admin() and company_id = app.current_company());

create policy jobs_read on jobs
  for select using (company_id = app.current_company());
create policy jobs_admin_write on jobs
  for all using (app.is_admin() and company_id = app.current_company())
  with check (app.is_admin() and company_id = app.current_company());

create policy trucks_read on trucks
  for select using (
    company_id = app.current_company()
    and (app.is_office()
         or subhauler_id is null
         or subhauler_id = app.current_subhauler())
  );
create policy trucks_admin_write on trucks
  for all using (app.is_admin() and company_id = app.current_company())
  with check (app.is_admin() and company_id = app.current_company());

-- ------------------------------------------------------------------ rates
-- Drivers cannot read the rate table at all. A subhauler may read only the
-- rates that apply to their own outfit — they are a party to that agreement,
-- but not to anyone else's.

create policy rates_visible on rates
  for select using (
    company_id = app.current_company()
    and (
      app.is_office()
      or (app.current_role() = 'subhauler'
          and payee_type = 'subhauler'
          and subhauler_id = app.current_subhauler())
    )
  );

create policy rates_admin_write on rates
  for all using (app.is_admin() and company_id = app.current_company())
  with check (app.is_admin() and company_id = app.current_company());

-- ------------------------------------------------------------------- tags

create policy tags_select on tags
  for select using (app.can_see_tag(tags));

-- A field user may only file a tag attributed to themselves, and the payee
-- must match who they actually are. A driver cannot bill a load to a
-- subhauler, and a subhauler cannot file one against the employee ledger.
create policy tags_insert_own on tags
  for insert with check (
    company_id = app.current_company()
    and created_by = auth.uid()
    and status in ('uploaded', 'queued')
    and approved_by is null
    and approved_at is null
    and invoice_id is null
    and computed_pay_cents is null
    and matched_rate_id is null
    and case app.current_role()
          when 'subhauler' then
            payee_type = 'subhauler'
            and subhauler_id = app.current_subhauler()
          when 'driver' then
            payee_type = 'employee_driver'
            and driver_id = auth.uid()
          else app.is_office()
        end
  );

-- Two distinct update paths.
--
-- 1. The field user, on a tag sent back to them for a rescan. They may move it
--    out of 'rescan_requested' and nothing else — the correction of field
--    values stays with the office.
create policy tags_update_own_rescan on tags
  for update using (
    created_by = auth.uid()
    and status = 'rescan_requested'
  )
  with check (
    created_by = auth.uid()
    and status = 'uploaded'
    and approved_by is null
    and approved_at is null
    and invoice_id is null
  );

-- 2. The office, on anything not yet frozen. Approved and invoiced tags are
--    immutable for everyone, admin included: a correction after approval is a
--    reversing entry on the next period, not a rewrite of history.
create policy tags_update_office on tags
  for update using (
    app.is_office()
    and company_id = app.current_company()
    and status not in ('approved', 'invoiced')
  )
  with check (
    app.is_office()
    and company_id = app.current_company()
  );

-- Nothing is ever deleted. Rejection is a status, not a disappearance.

-- ------------------------------------------------------------- tag images

create policy tag_images_select on tag_images
  for select using (
    exists (select 1 from tags t where t.id = tag_id and app.can_see_tag(t))
  );

create policy tag_images_insert on tag_images
  for insert with check (
    uploaded_by = auth.uid()
    and exists (
      select 1 from tags t
      where t.id = tag_id
        and app.can_see_tag(t)
        and t.status not in ('approved', 'invoiced')
    )
  );

-- Superseding an image (flipping is_current) is an office action, or the
-- automatic consequence of a rescan upload handled by trigger in 003.
create policy tag_images_update_office on tag_images
  for update using (app.is_office())
  with check (app.is_office());

-- ---------------------------------------------------------- rescan requests
-- The field user must be able to READ the request — the reason is the whole
-- point of sending it back — but only the office may raise one.

create policy rescan_select on rescan_requests
  for select using (
    exists (select 1 from tags t where t.id = tag_id and app.can_see_tag(t))
  );

create policy rescan_insert_office on rescan_requests
  for insert with check (
    app.is_office()
    and requested_by = auth.uid()
    and exists (
      select 1 from tags t
      where t.id = tag_id
        and t.company_id = app.current_company()
        and t.status not in ('approved', 'invoiced')
    )
  );

create policy rescan_update_office on rescan_requests
  for update using (app.is_office()) with check (app.is_office());

-- --------------------------------------------------- verification ledger

create policy verifications_select on field_verifications
  for select using (
    app.is_office()
    and exists (select 1 from tags t where t.id = tag_id and app.can_see_tag(t))
  );

-- Written server-side only. No client-side insert policy exists, so the
-- service role is the only writer.

-- -------------------------------------------------------------- invoicing
-- Each payee sees their own money and no one else's.

create policy invoices_select on invoices
  for select using (
    company_id = app.current_company()
    and (
      app.is_office()
      or (payee_type = 'employee_driver' and driver_id = auth.uid())
      or (payee_type = 'subhauler' and subhauler_id = app.current_subhauler())
    )
  );

create policy invoices_office_write on invoices
  for all using (app.is_office() and company_id = app.current_company())
  with check (app.is_office() and company_id = app.current_company());

create policy invoice_lines_select on invoice_lines
  for select using (
    exists (select 1 from invoices i where i.id = invoice_id)
  );

create policy invoice_lines_office_write on invoice_lines
  for all using (app.is_office()) with check (app.is_office());

-- -------------------------------------------------------------- audit log
-- Readable by admin only, and writable by nobody through the API. The trigger
-- in 003 runs security definer, which is how rows get in.

create policy audit_readable_by_admin on audit_log
  for select using (app.is_admin());

revoke insert, update, delete on audit_log from authenticated, anon;
