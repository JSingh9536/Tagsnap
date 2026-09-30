-- TagSnap — 007 automation
--
-- Closes the biggest gap in the pipeline: until now a tag sat at 'uploaded'
-- forever because nothing called the extractor. Now an uploaded photo reads
-- itself, and a rescan request reaches the driver's phone.
--
-- Both work the same way — a trigger fires an HTTP call through pg_net. That
-- is deliberately fire-and-forget: an outbound request must never be able to
-- roll back or slow down the transaction that a driver is waiting on.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------- config
-- The function URL and the service key have to live somewhere the trigger can
-- read them. Not in the migration — a key in version control is a leaked key.
-- Populated once at deploy time; see docs/SETUP.md step 6.

create table app_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table app_config enable row level security;
-- No policy at all, for anybody. Only the postgres role and security-definer
-- functions can read this, which is the entire point of the table.
revoke all on app_config from authenticated, anon;

create or replace function app.config(p_key text)
returns text
language sql stable security definer set search_path = public as $$
  select value from app_config where key = p_key
$$;

-- ------------------------------------------------------- extraction kickoff
-- A new image is what makes a tag readable, so that is what starts the read.
-- Covers the rescan path for free: a replacement photo is an insert too.

create or replace function app.request_extraction(p_tag_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  base text := app.config('functions_url');
  key  text := app.config('service_role_key');
begin
  if base is null or key is null then
    -- Not configured yet. Leave the tag at 'uploaded' rather than failing the
    -- driver's upload; the cron backstop below will pick it up once the
    -- config lands.
    raise warning 'app_config missing functions_url/service_role_key; extraction not queued';
    return;
  end if;

  perform net.http_post(
    url     := base || '/extract-tag',
    body    := jsonb_build_object('tag_id', p_tag_id),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || key
               ),
    timeout_milliseconds := 120000
  );
end
$$;

create or replace function app.extract_on_new_image()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_current then
    perform app.request_extraction(new.tag_id);
  end if;
  return new;
end
$$;

-- After the versioning and rescan-closing triggers in 003, so the tag is back
-- at 'uploaded' before the extractor is asked to look at it. Trigger order is
-- alphabetical within the same timing, and 'z_' guarantees this runs last.
create trigger z_new_image_starts_extraction
  after insert on tag_images
  for each row execute function app.extract_on_new_image();

-- ------------------------------------------------------------- the backstop
-- A dropped HTTP call would otherwise strand a tag silently. This finds
-- anything that has sat unread for five minutes and asks again. The extract
-- function is idempotent, so asking twice costs one wasted call at worst.

create or replace function app.retry_stuck_extractions()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer := 0;
  t record;
begin
  for t in
    select tg.id
      from tags tg
     where tg.status = 'uploaded'
       and tg.created_at < now() - interval '5 minutes'
       and exists (select 1 from tag_images ti
                    where ti.tag_id = tg.id and ti.is_current)
     order by tg.created_at
     limit 50
  loop
    perform app.request_extraction(t.id);
    n := n + 1;
  end loop;
  return n;
end
$$;

select cron.schedule(
  'tagsnap-retry-extractions',
  '*/5 * * * *',
  $$select app.retry_stuck_extractions()$$
);

-- ------------------------------------------------------- push notifications
-- A driver who does not know the office sent a ticket back is a driver the
-- office is waiting on. Realtime covers the case where the app is open; this
-- covers the other 23 hours of the day.

create table device_tokens (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  token       text not null unique,       -- Expo push token
  platform    text,
  last_seen   timestamptz not null default now(),
  active      boolean not null default true
);
create index device_tokens_by_profile on device_tokens (profile_id) where active;

alter table device_tokens enable row level security;

-- A user registers their own device and nobody else's. Without the equality
-- check, a driver could register a token against another driver's profile and
-- receive their notifications.
create policy device_tokens_own on device_tokens
  for all using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create or replace function app.notify_rescan()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  base text := app.config('functions_url');
  key  text := app.config('service_role_key');
begin
  if base is null or key is null then
    return new;   -- not configured; the in-app list still shows the request
  end if;

  perform net.http_post(
    url     := base || '/push-rescan',
    body    := jsonb_build_object('rescan_id', new.id),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || key
               ),
    timeout_milliseconds := 30000
  );
  return new;
end
$$;

create trigger z_rescan_notifies_driver
  after insert on rescan_requests
  for each row execute function app.notify_rescan();

-- Tell someone their money moved. Cheap, and it is the notification people
-- actually want.
create or replace function app.notify_approved()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  base text := app.config('functions_url');
  key  text := app.config('service_role_key');
begin
  if base is null or key is null then return new; end if;

  perform net.http_post(
    url     := base || '/push-rescan',
    body    := jsonb_build_object('approved_tag_id', new.id),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || key
               ),
    timeout_milliseconds := 30000
  );
  return new;
end
$$;

create trigger z_approval_notifies_submitter
  after update of status on tags
  for each row when (new.status = 'approved' and old.status is distinct from 'approved')
  execute function app.notify_approved();
