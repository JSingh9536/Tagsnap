-- TagSnap — 009 period close and invoicing
--
-- Turns approved tags into invoices. One invoice per payee per period, and an
-- employee settlement can never share a document with a subhauler payable —
-- that separation is enforced by the constraints in 001 and respected here by
-- grouping on payee before anything else.
--
-- The close takes explicit start and end dates rather than assuming a cadence.
-- Weekly, biweekly, and semi-monthly are all still open questions
-- (Trucktags/docs/ARCHITECTURE.md section 11) and this works for all three
-- without a migration when the answer arrives.

/**
 * What a close would produce, without producing it.
 *
 * The office looks at this before committing. A close that surprises someone
 * is a close that gets reversed, and reversals are expensive.
 */
create or replace function preview_close(
  p_start date, p_end date, p_payee_type payee_type default null
)
returns table (
  payee_type    payee_type,
  payee_id      uuid,
  payee_name    text,
  loads         bigint,
  total_tons    numeric,
  total_cents   bigint,
  already_invoiced boolean
)
language sql stable security definer set search_path = public as $$
  select
    t.payee_type,
    coalesce(t.driver_id, t.subhauler_id) as payee_id,
    coalesce(p.full_name, s.name)         as payee_name,
    count(*)                              as loads,
    sum(t.net_tons)                       as total_tons,
    sum(t.computed_pay_cents)::bigint     as total_cents,
    exists (
      select 1 from invoices i
       where i.period_start = p_start and i.period_end = p_end
         and (i.driver_id = t.driver_id or i.subhauler_id = t.subhauler_id)
    ) as already_invoiced
  from tags t
  left join profiles   p on p.id = t.driver_id
  left join subhaulers s on s.id = t.subhauler_id
  where t.company_id = app.current_company()
    and t.status = 'approved'
    and t.tag_date between p_start and p_end
    and (p_payee_type is null or t.payee_type = p_payee_type)
    and app.is_office()
  group by t.payee_type, t.driver_id, t.subhauler_id, p.full_name, s.name
  order by t.payee_type, payee_name
$$;

grant execute on function preview_close(date, date, payee_type) to authenticated;

/**
 * Close a period.
 *
 * Every approved tag dated in the window is grouped by payee, priced from the
 * figure already frozen on it at approval, and written onto an invoice. The
 * tag moves to 'invoiced' and is now referenced by a financial document.
 *
 * Three properties worth stating, because each one is a decision:
 *
 *   - `snapshot` freezes a copy of the tag onto the line. If a quarry gets
 *     renamed or a rate is corrected next month, the invoice still shows what
 *     was actually paid and why. Reference data moves; paid history does not.
 *   - Re-running a close for the same window is safe. It tops up draft
 *     invoices with tags approved since the last run and refuses to touch
 *     anything already issued or paid.
 *   - Pay is never recomputed here. It was computed once, at approval, by
 *     approve_tag() reading the rate table. Recomputing at close would let a
 *     rate change after approval silently alter what someone is paid.
 */
create or replace function close_period(
  p_start date, p_end date, p_payee_type payee_type default null
)
returns table (invoice_id uuid, payee_name text, loads integer, total_cents integer)
language plpgsql security definer set search_path = public as $$
declare
  actor   uuid := auth.uid();
  co      uuid;
  grp     record;
  inv     invoices;
  added   integer;
  summed  integer;
begin
  if not app.is_office() then
    raise exception 'only office or admin may close a period' using errcode = '42501';
  end if;
  if p_end < p_start then
    raise exception 'the period ends before it starts' using errcode = '22007';
  end if;
  if p_end > current_date then
    raise exception 'that period has not finished yet' using errcode = '22007';
  end if;

  co := app.current_company();

  for grp in
    select t.payee_type as pt, t.driver_id as did, t.subhauler_id as sid,
           coalesce(p.full_name, s.name) as nm
      from tags t
      left join profiles   p on p.id = t.driver_id
      left join subhaulers s on s.id = t.subhauler_id
     where t.company_id = co
       and t.status = 'approved'
       and t.tag_date between p_start and p_end
       and (p_payee_type is null or t.payee_type = p_payee_type)
     group by t.payee_type, t.driver_id, t.subhauler_id, p.full_name, s.name
  loop
    -- Find or open this payee's invoice for the window.
    select * into inv
      from invoices i
     where i.company_id = co
       and i.period_start = p_start and i.period_end = p_end
       and (i.driver_id is not distinct from grp.did)
       and (i.subhauler_id is not distinct from grp.sid);

    if found and inv.status <> 'draft' then
      -- Already issued or paid. Adding lines to it would change a document
      -- someone has already been sent.
      raise notice 'skipping % — invoice % is already %', grp.nm, inv.id, inv.status;
      continue;
    end if;

    if not found then
      insert into invoices (company_id, payee_type, driver_id, subhauler_id,
                            period_start, period_end, status, generated_by,
                            generated_at)
      values (co, grp.pt, grp.did, grp.sid, p_start, p_end, 'draft', actor, now())
      returning * into inv;
    end if;

    -- Write a line per tag, with a frozen copy of the tag on it.
    with moved as (
      update tags t
         set status = 'invoiced', invoice_id = inv.id
       where t.company_id = co
         and t.status = 'approved'
         and t.tag_date between p_start and p_end
         and t.payee_type = grp.pt
         and t.driver_id is not distinct from grp.did
         and t.subhauler_id is not distinct from grp.sid
      returning t.*
    )
    insert into invoice_lines (invoice_id, tag_id, snapshot, amount_cents)
    select
      inv.id,
      m.id,
      jsonb_build_object(
        'ticket_number', m.ticket_number,
        'tag_date',      m.tag_date,
        'quarry',        (select name from quarries  where id = m.quarry_id),
        'material',      (select name from materials where id = m.material_id),
        'job',           (select name from jobs      where id = m.job_id),
        'truck',         (select number from trucks  where id = m.truck_id),
        'net_tons',      m.net_tons,
        'rate_cents',    (select rate_cents from rates where id = m.matched_rate_id),
        'rate_unit',     (select unit from rates where id = m.matched_rate_id),
        'approved_by',   m.approved_by,
        'approved_at',   m.approved_at
      ),
      m.computed_pay_cents
    from moved m
    on conflict (invoice_id, tag_id) do nothing;

    get diagnostics added = row_count;

    select coalesce(sum(l.amount_cents), 0) into summed
      from invoice_lines l where l.invoice_id = inv.id;

    update invoices set total_cents = summed where id = inv.id;

    invoice_id  := inv.id;
    payee_name  := grp.nm;
    loads       := added;
    total_cents := summed;
    return next;
  end loop;
end
$$;

grant execute on function close_period(date, date, payee_type) to authenticated;

/**
 * Mark a draft invoice as issued.
 *
 * The point of no return for a document. After this the close will not touch
 * it, and correcting it means a reversing entry on the next period rather than
 * an edit — the same way accounting handles it everywhere else.
 */
create or replace function issue_invoice(p_invoice_id uuid)
returns invoices
language plpgsql security definer set search_path = public as $$
declare inv invoices;
begin
  if not app.is_office() then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select * into inv from invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if inv.status <> 'draft' then
    raise exception 'that invoice is already %', inv.status using errcode = '55006';
  end if;
  if inv.total_cents <= 0 then
    raise exception 'refusing to issue an invoice for zero' using errcode = '22023';
  end if;

  update invoices set status = 'issued' where id = p_invoice_id returning * into inv;
  return inv;
end
$$;

grant execute on function issue_invoice(uuid) to authenticated;

/**
 * Void an invoice and release its tags.
 *
 * Admin only, and loud — the audit trigger on `invoices` records who did it
 * and what the document looked like beforehand. Tags go back to 'approved',
 * which means they are eligible for the next close: their approval is not
 * undone, only the document that grouped them.
 *
 * A paid invoice cannot be voided. Money that has left is not a bookkeeping
 * problem this system gets to solve.
 */
create or replace function void_invoice(p_invoice_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare inv invoices;
begin
  if not app.is_admin() then
    raise exception 'only an admin may void an invoice' using errcode = '42501';
  end if;
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'voiding an invoice needs a reason' using errcode = '22023';
  end if;

  select * into inv from invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if inv.status = 'paid' then
    raise exception 'that invoice is paid; use a reversing entry on the next period'
      using errcode = '55006';
  end if;

  update tags set status = 'approved', invoice_id = null
   where invoice_id = p_invoice_id;

  delete from invoice_lines where invoice_id = p_invoice_id;

  update invoices
     set status = 'void', total_cents = 0
   where id = p_invoice_id;

  insert into audit_log (actor_id, actor_role, table_name, row_id, action,
                         before, after, source)
  values (auth.uid(), app.current_role(), 'invoices', p_invoice_id::text, 'void',
          to_jsonb(inv), jsonb_build_object('reason', p_reason), 'app');
end
$$;

grant execute on function void_invoice(uuid, text) to authenticated;

-- ------------------------------------------------------------ invoice view
-- One row per invoice with the payee resolved, so the console does not have
-- to branch on payee_type to find out whose name goes on the document.

create or replace view invoice_summary
with (security_invoker = true) as
select
  i.*,
  coalesce(p.full_name, s.name) as payee_name,
  (select count(*) from invoice_lines l where l.invoice_id = i.id) as line_count,
  (select coalesce(sum((l.snapshot ->> 'net_tons')::numeric), 0)
     from invoice_lines l where l.invoice_id = i.id) as total_tons
from invoices i
left join profiles   p on p.id = i.driver_id
left join subhaulers s on s.id = i.subhauler_id;
