# Setup

> **In a hurry?** [START-HERE.md](START-HERE.md) is the one-page version and it
> is the current one. This file is the long form: both database tracks, the
> reasoning, and the honest list of what is still unbuilt.
>
> **Two things below are out of date and are corrected in place:** the app is
> now native Swift and Kotlin rather than Expo (see [ios/README.md](../ios/README.md)
> and [android/README.md](../android/README.md)), and reading tickets no longer
> needs an Anthropic key or any paid API at all (see [OCR.md](OCR.md)).

Two parts. **Part A** is things only you can do. **Part B** is the commands.

Some of this has now actually been run on the target machine — `npm install`
succeeds, all three workspaces typecheck clean, and the office console builds.
What has *not* run is anything needing Docker, and there is a reason for that;
see A2.

---

# Part A — What you need to do

### A1. Tools — mostly done already

| | Status |
|---|---|
| **Node** | ✅ Installed — v26.7.0 at `C:\Program Files\nodejs` |
| **Git** | ✅ Installed |
| **Supabase CLI** | ✅ Bundled with the project. Use `npx supabase …` — do **not** run `npm i -g supabase`; Supabase removed support for global npm installs |
| **Docker Desktop** | ⚠️ Installed but cannot start. See A2 |

If your terminal says `npm is not recognized`, close it and open a new one —
PATH changes only apply to terminals opened afterwards.

### A2. Decide: hosted or local

The database can run in Supabase's cloud or on your machine. **Only the local
option needs Docker**, and Docker on this machine is currently broken.

**The diagnosis, precisely:** your CPU (i7-8700K) has virtualization enabled in
the BIOS — that part is fine. What is missing is Windows' hypervisor platform,
so `HypervisorPresent` reads `False` and Docker has nothing to run on.

**To fix it** — open PowerShell **as Administrator** and run:

```bash
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

```bash
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
```

Then **reboot**, and after the reboot:

```bash
wsl --update
```

```bash
wsl --set-default-version 2
```

Start Docker Desktop and wait for the whale icon to stop animating.

**Or skip Docker entirely.** A free hosted Supabase project works for
everything, needs no virtualization, and is what you would use in production
anyway. Track A below.

### A3. Nothing. This step is gone.

This used to say "get an Anthropic API key, put $20 on it, set a spend limit".

Reading tickets moved onto the phone — Apple Vision on iOS, ML Kit on Android.
Both are first-party, on-device, work with the phone in aeroplane mode, and are
**free at any volume**. There is no AI account to open, no card to add, no
per-ticket cost, and no key that can run up a bill.

If you set `ANTHROPIC_API_KEY` on a previous deployment, remove it:

```bash
supabase secrets unset ANTHROPIC_API_KEY
```

What that trade actually cost, and what it bought, is in [OCR.md](OCR.md). The
short version: a language model reads an unfamiliar ticket layout better than a
deterministic parser does — but when this one is wrong it usually says "I could
not read this field" rather than returning a confident wrong number, and for a
system where no unreviewed output may reach an invoice, that is the better
failure.

### A4. Collect 20–50 real ticket photos

**Do this before you trust any number this system produces.**

Photograph tickets off your own trucks, and deliberately include the bad ones:
faded, greasy, folded, shot at an angle, taken in a dark cab, carbon-copy
second sheets, anything with handwriting, and any ticket that ever caused a
payment dispute. The messy ones are the useful ones.

Drop them in `fixtures/tags/` — already gitignored, because real tickets carry
customer names and pricing.

Then run twenty through and count how often the **net tonnage** is right. If it
is not near-perfect, the review step needs to be heavier than planned, and it
is far better to learn that now than after the first settlement.

### A5. Decide four things

The code runs without these. It cannot go live without them.

1. **How is driver pay actually calculated?** Per ton is assumed. Ever per
   load, hourly, or a percentage of revenue? This shapes the rate table more
   than any other decision.
2. **What is a pay period?** Weekly, biweekly, semi-monthly? Same period for
   subhaulers as for employees? Monthly AP alongside weekly settlements is
   common.
3. **Who approves?** One person, or a second signature above a threshold? Note
   that whoever photographs a ticket **cannot** approve it — enforced in the
   database, not switchable.
4. **Are subhaulers paid on the same basis as your drivers?** See
   [ROLES.md](ROLES.md) §6.

### A6. Make five phone calls

**Worth more than anything in this repository.**

Call your top five quarries by volume. Ask the scale house or your account rep:

> *"Do you have e-ticketing, or can you send me a daily or weekly file of my
> tickets? CSV, Excel, PDF, emailed, FTP, portal export — anything digital.
> Whatever format you already produce is fine."*

Ask about **Command Alkon**, **HaulHub**, **Trux**, **Libra**, **Loadrite**, or
**WeighPay** by name if they hesitate.

One yes from a high-volume quarry deletes hundreds of photos a month from this
system permanently — and those tickets arrive as authoritative data from the
vendor's own scale, not a guess about what a photo says. Nothing to review,
ever.

Free. Make them before you spend anything else.

---

# Part B — The commands

## Already done

```bash
npm install
```

970 packages, and it worked. Re-run it only if you pull changes.

## Track A — Hosted (no Docker)

**Use this one.** It sidesteps the Docker problem entirely and is what
production looks like anyway.

**1.** Create a free project at [supabase.com](https://supabase.com). Note the
**project ref** from the URL (`https://supabase.com/dashboard/project/<ref>`).

**2.** From *Project Settings → API*, copy the URL and both keys into your
shell:

```bash
$env:SUPABASE_URL = "https://YOURREF.supabase.co"; $env:SUPABASE_ANON_KEY = "eyJ..."; $env:SUPABASE_SERVICE_ROLE_KEY = "eyJ..."
```

**3.** Write the config files:

```bash
npm run setup
```

**4.** Link and create the tables:

```bash
npx supabase link --project-ref YOURREF
```

```bash
npm run db:push
```

**5.** Load the test data. Paste the contents of `supabase/seed.sql` into the
dashboard's **SQL Editor** and run it. (`db:reset` is local-only and would wipe
a hosted database, so it is deliberately not used here.)

**6.** Deploy the server-side functions and their secrets:

```bash
npm run functions:deploy
```

```bash
npx supabase secrets set --env-file supabase/.env.secrets
```

> `.env.secrets`, not `.env`. Supabase refuses any secret whose name begins
> with `SUPABASE_` — it injects the URL and both keys into every deployed
> function itself — so pointing this at the full file fails on the first line.
> `npm run setup` writes both files.

**7.** Tell the database where to send push notifications:

```bash
npm run db:config
```

> **Do not skip this.** Without it, photos upload and then sit at "Sent"
> forever with no error anywhere, because the trigger that starts the reader
> has no address to call.

**8.** Run the apps:

```bash
npm run web
```

```bash
npm run mobile
```

## Track B — Local (after fixing Docker)

```bash
npm run db:start
```

```bash
npm run db:reset
```

```bash
npm run setup
```

```bash
npm run db:config
```

Then three terminals: `npm run functions`, `npm run web`, `npm run mobile`.

`npm run setup` detects which track you are on by itself — hosted if those
environment variables are set, local otherwise.

## Signing in

Four test accounts, all with the password **`tagsnap-dev-1`**:

| Email | Who |
|---|---|
| `dispatch@example.com` | Office — this is the one that approves |
| `admin@example.com` | Admin — can also void invoices |
| `driver@example.com` | A company driver |
| `sub@example.com` | A subhauler at "Ridgeline Trucking" |

- **Office console** — <http://localhost:5173>, sign in as `dispatch@example.com`.
  It will make you set up an authenticator app; that is required and cannot be
  skipped, because this account approves payments.
- **Phone app** — build and run it from Xcode or Android Studio; see
  [ios/README.md](../ios/README.md) or [android/README.md](../android/README.md).
  Choose **Driver**, switch to the **Email** tab, sign in as
  `driver@example.com`.

---

## Try the whole loop once

Fifteen minutes, and it exercises every control.

1. **On the phone**, tap the big **+** and photograph anything ticket-shaped.
   Turn on airplane mode first if you want to watch the offline queue work.
2. **Wait about ten seconds.** The ticket reads itself and appears in the queue.
3. **In the console**, open it. Photo on the left, fields on the right, a
   confidence percentage on each one, and gross − tare = net checked live under
   the weights.
4. **Send it back.** *Send back for a rescan* → "Can't read it".
5. **On the phone**, it jumps to the top with your reason on it and the phone
   buzzes. Tap, retake — your reason is printed across the camera screen.
6. **Approve it.** Correct anything wrong, *Save corrections*, *Approve*. The
   driver's phone buzzes with the dollar amount.
7. **Close the period.** *Close & invoices*, set the dates, close. Company
   drivers and subhaulers get separate invoices — two coloured totals, one for
   payroll and one for accounts payable.

Two things worth deliberately trying, because they are what protects the money:

- **Photograph a ticket from the office account, then try to approve it.**
  Refused. Whoever submits cannot approve.
- **Try to approve the same ticket twice.** Refused. Once approved it is
  frozen; a correction after that is a reversing entry, not an edit.

---

## Shipping the apps

You need an **Apple Developer account** ($99/year) and a **Google Play account**
($25 once).

```bash
npx eas login
```

```bash
npx eas build:configure
```

That fills in the project ID in `app.json`. Replace the placeholder zeros in
`eas.json` with your Apple ID and team ID, then:

```bash
npm run build:preview --workspace @tagsnap/mobile
```

That produces installable builds you can hand to a few drivers before going
near the stores.

**Push notifications do not work until `eas build:configure` has run** — the
app needs a real project ID to get a push token. Everything else works without
it.

**Replace the app icons** in `ios/TagSnap/Assets.xcassets/` and
`android/app/src/main/res/`. The current ones say "TS"
on a dark square; see the README in that folder.

### Text-message sign-in

The app defaults to texting drivers a code, which is right for a crew in gloves
with no work email. It needs Twilio or MessageBird connected under
*Authentication → Providers → Phone*. Budget **$10–20/month**. Until then
everyone signs in with email and password, which works fine.

---

## Still not built

**Google Sheets is not connected.** Rates come from the seed file and invoices
live in the database rather than being exported. Deliberately unbuilt — it
needs your service account credentials *and* the layout of your existing rate
sheet, neither of which can be guessed. Environment variables are waiting in
`.env.example`. Roughly a day once someone can see the real sheet.

**Rates are entered by hand** — by editing `supabase/seed.sql` or inserting
rows. There is no rate-management screen. Most likely first thing to want.

**No quarry-invoice reconciliation.** The idea that eventually retires most of
the reviewing: match your tickets against the quarry's own monthly invoice, and
anything that reconciles is proven correct without a human looking. Tables are
shaped for it; the workflow is not built.

**One extraction pass, not two.** Running each photo through two independent
reads and flagging only disagreements would turn silent wrong answers into
flagged ones. Cheap — it doubles a cost that is already rounding error.

**No dispatch or GPS cross-checking.** The app records where each photo was
taken. Nothing compares that to where the quarry is, which would verify several
fields for free.

**No global spend ceiling.** Each user is capped at 60 reads an hour, which
stops one phone in a retry loop. It does not stop fifty at once. The
`daily_extraction_spend` view exists to alert from; the alert is not wired.

---

## Before it holds real money

- [x] Every table locked down at the database level, deny by default
- [x] Submitter cannot approve their own ticket — enforced as a constraint
- [x] Duplicate ticket numbers rejected by the database
- [x] Re-photographed tickets caught by image fingerprinting
- [x] Approved tickets frozen — no edits, for anyone, including admins
- [x] Full audit trail written by triggers, not app code that could skip it
- [x] Ticket photos in a private bucket, read only through 60-second links
- [x] Two-factor required for every office and admin account
- [x] Per-user rate limit on the paid reader
- [x] All three workspaces typecheck clean; office console builds
- [ ] Confirm the service key is absent from the built app — `grep` the APK
- [ ] Try to read another driver's tickets with a real driver login; confirm it fails
- [ ] Submit the same ticket number from two phones at once; confirm one loses
- [ ] Set the daily spend alert
- [ ] Restore a backup into a scratch project — test it, do not assume it
- [ ] Write the offboarding checklist, and rehearse it once
- [ ] Publish a privacy policy; make the app store forms match it

The unchecked ones are mostly process rather than code, which is exactly why
they are the ones that get skipped.

---

## When something goes wrong

| Symptom | Almost always |
|---|---|
| `npm is not recognized` | Terminal opened before Node was installed. Open a new one |
| `Docker Desktop is unable to start` | Hypervisor platform not enabled. See A2 |
| Photos stay on "Sent" for over 30 minutes | They should not — `app.sweep_unread_tags()` moves them to the review queue. Check `pg_cron` is enabled |
| Phone says it cannot connect | Phone is on a different Wi-Fi from the laptop. Check the address `npm run setup` printed |
| App will not build: "SUPABASE_URL is not set" | `ios/Config.xcconfig` or `android/local.properties` was not created from its `.example` |
| Console rejects your login | That account is not office or admin. Drivers and subhaulers use the phone app |
| "No rate on file" when approving | No rate covers that driver/quarry/material/date. Add one |
| Every ticket lands in review | Normal at first. Correct the quarry and material names a few times; the resolver learns your vendors. See [OCR.md](OCR.md) |
| The phone says "hard to read" every time | Light and flatness, not software. Also check the document scanner is opening rather than a plain camera |
| Push notifications never arrive | APNs or FCM secrets not set, or `APNS_ENVIRONMENT` does not match the entitlement. See the platform READMEs |
| `supabase` command not found | Use `npx supabase`, or an `npm run db:*` script. It is a project dependency, not global |
