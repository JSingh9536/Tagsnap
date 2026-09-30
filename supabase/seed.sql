-- TagSnap — local development seed.
--
-- Applied by `supabase db reset` against the LOCAL stack only. Never run this
-- against a real project: it creates accounts with known passwords.
--
-- Gives you one of each role so the driver/subhauler split and the
-- separation-of-duties rule can both be exercised without inventing data:
--
--   dispatch@example.com  / tagsnap-dev-1  office  (approves)
--   admin@example.com     / tagsnap-dev-1  admin
--   driver@example.com    / tagsnap-dev-1  driver      — employee ledger
--   sub@example.com       / tagsnap-dev-1  subhauler   — AP ledger, Ridgeline

do $$
declare
  co        uuid := gen_random_uuid();
  sub_co    uuid := gen_random_uuid();
  u_office  uuid := gen_random_uuid();
  u_admin   uuid := gen_random_uuid();
  u_driver  uuid := gen_random_uuid();
  u_sub     uuid := gen_random_uuid();
  q_vulcan  uuid := gen_random_uuid();
  q_martin  uuid := gen_random_uuid();
  m_57      uuid := gen_random_uuid();
  m_abc     uuid := gen_random_uuid();
  j_rt42    uuid := gen_random_uuid();
begin
  insert into companies (id, name) values (co, 'Example Hauling');

  insert into subhaulers (id, company_id, name, contact_name, contact_phone)
  values (sub_co, co, 'Ridgeline Trucking', 'Sam Ortiz', '+15555550142');

  -- auth.users rows, written directly because there is no signup flow here.
  -- The crypt() call is why pgcrypto is in 001.
  insert into auth.users
    (id, instance_id, aud, role, email, encrypted_password,
     email_confirmed_at, created_at, updated_at,
     raw_app_meta_data, raw_user_meta_data)
  values
    (u_office, '00000000-0000-0000-0000-000000000000', 'authenticated',
     'authenticated', 'dispatch@example.com',
     crypt('tagsnap-dev-1', gen_salt('bf')), now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{}'),
    (u_admin, '00000000-0000-0000-0000-000000000000', 'authenticated',
     'authenticated', 'admin@example.com',
     crypt('tagsnap-dev-1', gen_salt('bf')), now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{}'),
    (u_driver, '00000000-0000-0000-0000-000000000000', 'authenticated',
     'authenticated', 'driver@example.com',
     crypt('tagsnap-dev-1', gen_salt('bf')), now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{}'),
    (u_sub, '00000000-0000-0000-0000-000000000000', 'authenticated',
     'authenticated', 'sub@example.com',
     crypt('tagsnap-dev-1', gen_salt('bf')), now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{}');

  insert into profiles (id, company_id, role, full_name, email, phone, subhauler_id)
  values
    (u_office, co, 'office',    'Dana Reyes',  'dispatch@example.com', null, null),
    (u_admin,  co, 'admin',     'Pat Nowak',   'admin@example.com',    null, null),
    (u_driver, co, 'driver',    'Marcus Hale', 'driver@example.com',   '+15555550118', null),
    (u_sub,    co, 'subhauler', 'Sam Ortiz',   'sub@example.com',      '+15555550142', sub_co);

  -- Aliases seeded with the kind of text a scale ticket actually prints, so
  -- resolution has something to match on before anyone corrects anything.
  insert into quarries (id, company_id, name, aliases) values
    (q_vulcan, co, 'Vulcan Materials #123',
      array['VULCAN MATLS #0123', 'VULCAN #123', 'VULCAN MATERIALS 123']),
    (q_martin, co, 'Martin Marietta — Eastside',
      array['MARTIN MARIETTA EASTSIDE', 'MM EASTSIDE', 'MARTIN E-SIDE']);

  insert into materials (id, company_id, code, name, aliases) values
    (m_57,  co, '57',  '#57 Stone', array['#57 STONE', '57 STONE', 'NO 57 STONE']),
    (m_abc, co, 'ABC', 'Crusher Run ABC', array['ABC', 'CRUSHER RUN', 'CR ABC']);

  insert into jobs (id, company_id, number, name, customer, aliases) values
    (j_rt42, co, '2601', 'RT 42 Widening', 'State DOT',
      array['RT 42 WIDENING', 'RT42', 'ROUTE 42 WIDENING']);

  insert into trucks (company_id, number, default_driver_id, legal_capacity_tons,
                      avg_tare_tons)
  values
    (co, '218', u_driver, 25.00, 16.10),
    (co, '404', null,     25.00, 15.80);

  -- Subhauler trucks belong to the subhauler, not to us.
  insert into trucks (company_id, number, subhauler_id, legal_capacity_tons,
                      avg_tare_tons)
  values (co, 'R-11', sub_co, 24.00, 17.20);

  -- Two rate books that never touch each other. The employee rate is per ton
  -- of material moved; the subhauler rate is what their outfit invoices us.
  insert into rates (company_id, payee_type, driver_id, subhauler_id, quarry_id,
                     material_id, job_id, unit, rate_cents, effective_from,
                     source_row)
  values
    (co, 'employee_driver', null, null, q_vulcan, m_57, null,
     'ton', 875, current_date - 180, 'seed: company driver, Vulcan #57'),
    (co, 'employee_driver', null, null, null, null, null,
     'ton', 800, current_date - 180, 'seed: company driver, default'),
    (co, 'subhauler', null, sub_co, q_vulcan, m_57, null,
     'ton', 1125, current_date - 180, 'seed: Ridgeline, Vulcan #57'),
    (co, 'subhauler', null, sub_co, null, null, null,
     'ton', 1050, current_date - 180, 'seed: Ridgeline, default');

  raise notice 'Seeded company % with 4 accounts (password: tagsnap-dev-1)', co;
end
$$;
