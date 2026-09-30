-- TagSnap — first run against a real project.
--
-- Paste this into the Supabase dashboard's SQL Editor, edit the six values in
-- the block below, and run it once.
--
-- This is NOT seed.sql. That file exists for the local Docker stack and
-- creates four accounts with a password printed in its own header; running it
-- against a project anyone can reach would be handing out logins. This one
-- creates no accounts at all. It attaches a profile to a user **you** already
-- made in Authentication → Users, which is the only way to get an account
-- whose password you chose and nobody else knows.
--
-- Safe to re-run: it will refuse rather than create a second company.

do $bootstrap$
declare
  -- ------------------------------------------------------------ EDIT THESE
  -- The email of the user you created in Authentication → Users. That step
  -- comes first; this script looks the account up rather than making one.
  v_email    text := 'you@example.com';

  -- How your name should appear on the review screen next to an approval.
  v_name     text := 'Your Name';

  -- Your company. This is the tenant every row in the system hangs off.
  v_company  text := 'Your Hauling Company';

  -- One quarry and one material to start with. Both are only a starting
  -- point — the office console can add more, and every correction a reviewer
  -- makes teaches the resolver another spelling your vendors actually print.
  v_quarry   text := 'Vulcan Materials #123';
  v_material text := '#57 Stone';

  -- What you pay a company driver, per ton, in cents. 875 = $8.75/ton.
  --
  -- This has to exist before anything can be approved: validate_tag() flags
  -- `no_rate_on_file` otherwise, because approving with no rate would freeze a
  -- payment of zero. Put in something roughly right now and correct it later;
  -- a rate change never alters an approval already made.
  v_rate_cents integer := 875;
  -- --------------------------------------------------------- END EDIT THESE

  v_user_id  uuid;
  v_company_id uuid;
  v_quarry_id  uuid;
  v_material_id uuid;
begin
  -- --- find the account you made ------------------------------------------
  select id into v_user_id from auth.users where lower(email) = lower(v_email);

  if v_user_id is null then
    raise exception
      'No account for %. Create it first: Authentication -> Users -> Add user, then run this again.',
      v_email;
  end if;

  if exists (select 1 from profiles where id = v_user_id) then
    raise exception
      '% already has a profile. This script is for the first run only.',
      v_email;
  end if;

  -- --- the company ---------------------------------------------------------
  select id into v_company_id from companies where name = v_company;

  if v_company_id is null then
    insert into companies (name) values (v_company) returning id into v_company_id;
  end if;

  -- --- you ------------------------------------------------------------------
  -- `admin` rather than `office`: admin is office plus the ability to manage
  -- users and rates, and on the first run there is nobody else to do that.
  --
  -- Worth knowing before you test the whole loop: `approver_is_not_submitter`
  -- means this account cannot approve a ticket it filed itself. That is
  -- separation of duties and it is a table constraint, not a setting. To run
  -- the full round trip you need a second account with the `driver` role —
  -- make it the same way and add a profile row for it.
  insert into profiles (id, company_id, role, full_name, email)
  values (v_user_id, v_company_id, 'admin', v_name, v_email);

  -- --- enough reference data to approve one load ---------------------------
  insert into quarries (company_id, name, aliases)
  values (v_company_id, v_quarry, array[upper(v_quarry)])
  returning id into v_quarry_id;

  insert into materials (company_id, code, name, aliases)
  values (v_company_id, null, v_material, array[upper(v_material)])
  returning id into v_material_id;

  -- A rate with nulls in every matching column is a wildcard: it prices any
  -- load for a company driver that no more specific rate covers. Deliberately
  -- the least specific row possible, so nothing fails to price while you are
  -- still finding out what the real rates are.
  --
  -- `payee_type` is never a wildcard, here or anywhere. An employee rate must
  -- not price a subhauler load — see docs/ROLES.md.
  insert into rates (company_id, payee_type, unit, rate_cents, effective_from,
                     source_row)
  values (v_company_id, 'employee_driver', 'ton', v_rate_cents,
          current_date - 1, 'bootstrap: company driver, default');

  raise notice 'Company % ready. % is an admin. Rate: % cents/ton.',
    v_company, v_email, v_rate_cents;
  raise notice 'Next: make a second account with role ''driver'' so you have somebody to approve.';
end
$bootstrap$;
