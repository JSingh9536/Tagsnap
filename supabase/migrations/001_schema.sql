-- TagSnap — 001 core schema
-- Postgres / Supabase. Money in integer cents; weights in numeric tons.
--
-- Derived from Trucktags/db/schema.sql with three additions this app requires:
--   1. a `subhauler` role and a payee model, so employee-driver settlements and
--      subhauler accounts payable never mix on one invoice (see docs/ROLES.md)
--   2. `tag_images` — a tag can carry several images, because the office can
--      send a tag back for a rescan and the original must survive
--   3. `rescan_requests` — the office -> field round trip, with a reason

create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

-- ------------------------------------------------------------ alias search
-- The alias lists on quarries, materials and jobs are what make entity
-- resolution get better at your specific vendors over the first few hundred
-- tickets (see learn_alias in 003). Searching them needs a trigram index over
-- the whole list as one string.
--
-- `array_to_string()` cannot be used in an index expression directly: Postgres
-- marks it STABLE rather than IMMUTABLE, because an element type's output
-- function is permitted to be stable, and an index cannot depend on anything
-- that might change. For `text[]` that caveat does not apply — text output is
-- the identity — so wrapping it and asserting immutability is sound.
--
-- Getting this wrong fails loudly at `create index`, which is the good case.
-- The bad case is defining it here and then writing the query in 005 with a
-- differently-shaped expression: the index would build, and simply never be
-- used. Hence `upper()` living inside the function rather than around the call
-- site — one expression, used identically in both places.
create schema if not exists app;

create or replace function app.alias_text(text[])
returns text
language sql
immutable
parallel safe
as $fn$ select upper(array_to_string($1, ' ')) $fn$;

-- ---------------------------------------------------------------- identity

-- driver    : employee, company truck, paid on a settlement
-- subhauler : outside outfit hauling for us, paid as a vendor (AP)
-- office    : reviews, corrects, approves, closes periods
-- admin     : office + user/rate management
create type user_role as enum ('driver', 'subhauler', 'office', 'admin');

-- who the money is owed to. this is the axis the whole split turns on.
create type payee_type as enum ('employee_driver', 'subhauler');

create table companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- An outside hauling outfit. May have many drivers under it; we owe the
-- outfit, not the individual behind the wheel.
create table subhaulers (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id),
  name           text not null,
  contact_name   text,
  contact_email  text,
  contact_phone  text,
  -- vendor identifier only. no tax identity data lives here; see
  -- Trucktags/docs/SECURITY.md section 8.
  vendor_ref     text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (company_id, name)
);

create table profiles (
  id            uuid primary key references auth.users(id) on delete restrict,
  company_id    uuid not null references companies(id),
  role          user_role not null default 'driver',
  full_name     text not null,
  phone         text,
  email         text,
  -- set if and only if role = 'subhauler'
  subhauler_id  uuid references subhaulers(id),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),

  constraint subhauler_has_an_outfit check (
    (role = 'subhauler' and subhauler_id is not null)
    or (role <> 'subhauler' and subhauler_id is null)
  )
);
create index profiles_company_role on profiles (company_id, role) where active;

-- ------------------------------------------------------------- reference data

create table quarries (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id),
  name        text not null,
  aliases     text[] not null default '{}',
  address     text,
  latitude    numeric(9,6),
  longitude   numeric(9,6),
  active      boolean not null default true
);
create index quarries_alias_trgm on quarries
  using gin (app.alias_text(aliases) gin_trgm_ops);

create table materials (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id),
  code        text,
  name        text not null,
  aliases     text[] not null default '{}',
  active      boolean not null default true
);
create index materials_alias_trgm on materials
  using gin (app.alias_text(aliases) gin_trgm_ops);

create table jobs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id),
  number      text,
  name        text not null,
  customer    text,
  aliases     text[] not null default '{}',
  active      boolean not null default true
);
create index jobs_alias_trgm on jobs
  using gin (app.alias_text(aliases) gin_trgm_ops);

create table trucks (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id),
  number              text not null,
  default_driver_id   uuid references profiles(id),
  -- a subhauler's truck belongs to the subhauler, not to us
  subhauler_id        uuid references subhaulers(id),
  legal_capacity_tons numeric(6,2),
  -- running average of observed tare, used as a self-verification signal
  -- (Trucktags/docs/INGESTION.md tier 3)
  avg_tare_tons       numeric(6,2),
  active              boolean not null default true,
  unique (company_id, number)
);

-- ------------------------------------------------------------------- rates
-- NULL in a matching column means "wildcard"; resolution prefers the most
-- specific row that matches. payee_type is never a wildcard — an employee rate
-- must never price a subhauler load, or the reverse.

create type rate_unit as enum ('ton', 'load', 'hour');

create table rates (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id),
  payee_type     payee_type not null,
  driver_id      uuid references profiles(id),
  subhauler_id   uuid references subhaulers(id),
  quarry_id      uuid references quarries(id),
  material_id    uuid references materials(id),
  job_id         uuid references jobs(id),
  unit           rate_unit not null default 'ton',
  rate_cents     integer not null check (rate_cents >= 0),
  effective_from date not null,
  effective_to   date,
  source_row     text,
  imported_at    timestamptz not null default now(),

  check (effective_to is null or effective_to >= effective_from),
  constraint rate_target_matches_payee_type check (
    (payee_type = 'subhauler' and driver_id is null)
    or (payee_type = 'employee_driver' and subhauler_id is null)
  )
);
create index rates_lookup on rates
  (company_id, payee_type, quarry_id, material_id, job_id, effective_from desc);

-- -------------------------------------------------------------------- tags

create type tag_status as enum (
  'queued',            -- exists only on the device
  'uploaded',          -- image received, not yet read
  'extracted',         -- model has read it
  'needs_review',      -- a confidence floor or a validation control tripped
  'rescan_requested',  -- office sent it back to the field for a new photo
  'ready',             -- clean, awaiting approval
  'approved',          -- FROZEN. financial record from here on.
  'invoiced',
  'rejected'
);

-- where the record came from. a photo is one source among several.
create type tag_source as enum
  ('driver_photo', 'office_scan', 'email_batch', 'quarry_feed', 'manual');

create table tags (
  id                 uuid primary key,      -- client-generated; idempotency key
  company_id         uuid not null references companies(id),
  created_by         uuid not null references profiles(id),
  created_at         timestamptz not null default now(),
  source             tag_source not null default 'driver_photo',

  status             tag_status not null default 'uploaded',

  -- who gets paid for this load, and under which ledger
  payee_type         payee_type not null,
  driver_id          uuid references profiles(id),
  subhauler_id       uuid references subhaulers(id),

  -- what the model said, untouched, plus its raw response for forensics
  extracted          jsonb,
  confidence         jsonb,
  model_raw          jsonb,
  model_version      text,
  extracted_at       timestamptz,

  -- resolved + human-corrected values. pay is computed from these.
  ticket_number      text,
  tag_date           date,
  quarry_id          uuid references quarries(id),
  material_id        uuid references materials(id),
  job_id             uuid references jobs(id),
  truck_id           uuid references trucks(id),
  gross_tons         numeric(8,2),
  tare_tons          numeric(8,2),
  net_tons           numeric(8,2),

  matched_rate_id    uuid references rates(id),
  computed_pay_cents integer,

  review_reasons     text[] not null default '{}',
  review_notes       text,
  rescan_count       smallint not null default 0,
  approved_by        uuid references profiles(id),
  approved_at        timestamptz,
  rejected_reason    text,
  invoice_id         uuid,

  -- controls, enforced where they cannot be bypassed
  constraint no_duplicate_ticket unique (quarry_id, ticket_number),
  constraint approver_is_not_submitter
    check (approved_by is null or approved_by <> created_by),
  constraint weights_are_consistent check (
    gross_tons is null or tare_tons is null or net_tons is null
    or abs((gross_tons - tare_tons) - net_tons) <= 0.05
  ),
  -- the payee split, enforced in the database rather than in app code
  constraint payee_target_is_consistent check (
    (payee_type = 'employee_driver' and subhauler_id is null)
    or (payee_type = 'subhauler' and subhauler_id is not null)
  ),
  constraint approved_tags_are_complete check (
    status not in ('approved','invoiced')
    or (net_tons is not null and matched_rate_id is not null
        and computed_pay_cents is not null
        and approved_by is not null and approved_at is not null
        and (
          (payee_type = 'employee_driver' and driver_id is not null)
          or (payee_type = 'subhauler' and subhauler_id is not null)
        ))
  )
);

create index tags_review_queue on tags (company_id, status, created_at desc);
create index tags_by_driver_period on tags (driver_id, tag_date)
  where status in ('approved','invoiced');
create index tags_by_subhauler_period on tags (subhauler_id, tag_date)
  where status in ('approved','invoiced');
create index tags_mine on tags (created_by, created_at desc);

-- ------------------------------------------------------------- tag images
-- A tag has one current image and any number of superseded ones. A rescan adds
-- a version; it never overwrites, because the original is the evidence for
-- whatever was already extracted from it.

create table tag_images (
  id           uuid primary key default gen_random_uuid(),
  tag_id       uuid not null references tags(id) on delete restrict,
  version      smallint not null,
  image_path   text not null,             -- private bucket key
  image_phash  bigint,                    -- re-photograph detection
  bytes        integer,
  width        integer,
  height       integer,
  captured_at  timestamptz,
  captured_lat numeric(9,6),
  captured_lng numeric(9,6),
  uploaded_by  uuid not null references profiles(id),
  uploaded_at  timestamptz not null default now(),
  is_current   boolean not null default true,
  unique (tag_id, version)
);
create unique index tag_images_one_current on tag_images (tag_id) where is_current;
create index tag_images_phash on tag_images (image_phash)
  where image_phash is not null;

-- ---------------------------------------------------------- rescan requests
-- The office -> field round trip. An open request blocks approval; closing it
-- is what moves the tag back into the extraction pipeline.

create type rescan_reason as enum (
  'unreadable',       -- blur, glare, dark
  'cropped',          -- part of the ticket is out of frame
  'wrong_document',   -- not a scale ticket
  'missing_fields',   -- a field the reviewer needs is not visible
  'duplicate_check',  -- looks like a re-photograph of another tag
  'other'
);

create table rescan_requests (
  id             uuid primary key default gen_random_uuid(),
  tag_id         uuid not null references tags(id) on delete restrict,
  requested_by   uuid not null references profiles(id),
  requested_at   timestamptz not null default now(),
  reason         rescan_reason not null,
  note           text,
  -- the image that was found wanting, so the field crew sees what we saw
  prior_image_id uuid references tag_images(id),
  resolved_at    timestamptz,
  resolved_by    uuid references profiles(id),
  new_image_id   uuid references tag_images(id),
  cancelled_at   timestamptz
);
create index rescan_open on rescan_requests (tag_id)
  where resolved_at is null and cancelled_at is null;
create unique index rescan_one_open_per_tag on rescan_requests (tag_id)
  where resolved_at is null and cancelled_at is null;

-- ---------------------------------------------------- verification ledger
-- Which independent source confirmed which field. Auto-approval is a policy
-- over this table rather than a hardcoded confidence threshold, and it stays
-- explainable. (Trucktags/docs/INGESTION.md section 3)

create type verification_source as enum
  ('extraction', 'second_pass', 'dispatch', 'gps', 'truck_tare_history',
   'quarry_invoice', 'arithmetic', 'human');

create table field_verifications (
  id         uuid primary key default gen_random_uuid(),
  tag_id     uuid not null references tags(id) on delete cascade,
  field      text not null,
  source     verification_source not null,
  agrees     boolean not null,
  detail     jsonb,
  at         timestamptz not null default now(),
  unique (tag_id, field, source)
);

-- ---------------------------------------------------------------- invoicing
-- One invoice belongs to exactly one payee. An employee settlement and a
-- subhauler payable can never share a document.

create type invoice_status as enum ('draft', 'issued', 'paid', 'void');

create table invoices (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id),
  payee_type    payee_type not null,
  driver_id     uuid references profiles(id),
  subhauler_id  uuid references subhaulers(id),
  period_start  date not null,
  period_end    date not null,
  status        invoice_status not null default 'draft',
  total_cents   integer not null default 0,
  sheet_url     text,
  sheet_tab     text,
  generated_by  uuid references profiles(id),
  generated_at  timestamptz,

  constraint invoice_payee_is_consistent check (
    (payee_type = 'employee_driver'
      and driver_id is not null and subhauler_id is null)
    or (payee_type = 'subhauler'
      and subhauler_id is not null and driver_id is null)
  ),
  check (period_end >= period_start)
);
create unique index invoice_one_per_driver_period on invoices
  (driver_id, period_start, period_end) where driver_id is not null;
create unique index invoice_one_per_subhauler_period on invoices
  (subhauler_id, period_start, period_end) where subhauler_id is not null;

create table invoice_lines (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references invoices(id) on delete restrict,
  tag_id       uuid not null references tags(id) on delete restrict,
  snapshot     jsonb not null,   -- frozen copy of the tag at approval time
  amount_cents integer not null,
  unique (invoice_id, tag_id)
);

alter table tags add constraint tags_invoice_fk
  foreign key (invoice_id) references invoices(id);

-- ---------------------------------------------------------------- audit log
-- Append-only. Written by triggers in 003, never by application code.

create table audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  actor_id   uuid,
  actor_role user_role,
  table_name text not null,
  row_id     text not null,
  action     text not null,
  before     jsonb,
  after      jsonb,
  source     text
);
create index audit_log_row on audit_log (table_name, row_id, at desc);
