# Build Log

A record of the session that produced TagSnap — what was asked for, what was
decided and why, what got built, and what broke along the way.

Written as a summary rather than a transcript. Where a decision could have gone
another way, the reasoning is recorded, because that is the part that is
expensive to reconstruct later.

**Date:** 25 August 2026
**Starting point:** `E:\projects\Trucktags` — four planning documents, a schema
sketch, no code. `E:\projects\TagSnap` — empty.

---

## 1. What was asked

Three requests, in order:

1. **"Read the mds and project details from truck tags and code both an iOS and
   Android app that connects to website that allows those working in the office
   to review and rescan (if needed) and/or approve of tags scanned. The app will
   give the option of logging in as driver or subhauler login to keep it separate
   of who's getting invoice of how much we owe them for their work."**
2. **"Fix and do what you can. Things I need to do — make simple instructions in
   the setup md. Also make a simple pitch deck with pictures that break down what
   the app does, what options we have to make it work, and cost options broken
   down monthly and yearly."**
3. **"Put this convo into a md."** — this file.

Between 2 and 3, the user hit `npm : The term 'npm' is not recognized`, which
turned into a diagnostic detour worth recording (§7).

---

## 2. What the source documents said

Four documents in `Trucktags/docs/` shaped everything. The single most
load-bearing line, from `ARCHITECTURE.md` §1:

> Strip away the phone and the camera and this is an **accounts-payable system
> with an OCR front door**.

Three consequences were treated as non-negotiable throughout:

- No unreviewed machine output may reach an invoice.
- The tag photo is evidence — retained, immutable, permanently linked.
- Every number that changes is attributable to a person or a model run.

`INGESTION.md` added a structural instruction that would have been expensive to
retrofit: **a photo is one ingestion source among several, not the foundation of
the system.** Hence `tags.source` existing from the first migration even though
only `driver_photo` is implemented.

`SECURITY.md` supplied the threat model, in order of likelihood — driver
inflating their own pay, lost phone, ex-employee retaining access, leaked API
key, hand-edited spreadsheet. The design weights those first, third and fifth
most heavily, because those are the ones that cost money in this industry.

---

## 3. The decisions that mattered

### 3.1 Driver vs subhauler is a schema decision, not a UI one

The request said "keep it separate of who's getting invoice." The obvious
reading — two login buttons — would have been the wrong build. Two logins that
write into one undifferentiated table separate nothing.

What was built instead: a `payee_type` discriminator (`employee_driver` |
`subhauler`) that follows a ticket from capture to payment, enforced at four
levels:

| Level | Mechanism |
|---|---|
| Row | `payee_target_is_consistent` check constraint — a subhauler ticket with no outfit cannot exist |
| Insert | RLS policy — a driver cannot file a ticket billed to a subhauler, or vice versa |
| Pricing | `rates.payee_type` is `not null` and never a wildcard |
| Invoice | `invoice_payee_is_consistent` — an invoice with both a driver and an outfit is unrepresentable |

The key insight that shaped the model: **you owe the outfit, not the person
driving.** A subhauling company may put three drivers in three trucks in a week;
that is one payable to one vendor, not three. So `subhauler_id` is the payee and
the individual is only who filed the ticket.

Written up in full in [ROLES.md](ROLES.md).

### 3.2 The portal picker is an affordance, not a permission

The app asks "Driver or Subhauler?" first. It would have been easy — and wrong —
to let that choice grant the role. Picking "Office" would then have been a
privilege escalation.

The flow instead: pick a door → authenticate → **ask the server who this
actually is** (`profiles.role`) → if it disagrees, sign back out and say which
door to use. See `reconcilePortal` in `apps/mobile/src/state/auth.tsx`.

Office and admin accounts are turned away from the phone app entirely. Their
work is the review screen, which needs a wide layout and a photo big enough to
read a faded carbon copy on.

### 3.3 The rescan loop is why the two apps are one system

This was new — not in the source documents. "Review and rescan (if needed)"
required an office→field round trip that did not exist in the plan.

Design: office picks a reason → trigger flips the tag to `rescan_requested` →
the driver's phone buzzes and the ticket jumps to the top of their list → **the
reason is printed across their camera screen while they retake it**.

Two constraints fell out of it:

- A tag needs **many images**, not one. Hence `tag_images` with versioning: a
  retake supersedes without destroying, because the original is the evidence for
  whatever was already extracted from it.
- A retake must attach to the **same tag**. A second tag for one ticket is
  exactly the duplicate the whole system exists to prevent.

### 3.4 The database enforces; the app merely asks

Every control that protects money is a constraint, a policy, or a trigger — not
a check in application code:

- `UNIQUE (quarry_id, ticket_number)` — the same ticket twice
- Perceptual hash — the same paper re-shot at an angle with a digit changed
- `approver_is_not_submitter` — separation of duties
- `weights_are_consistent` — gross − tare = net
- No update policy for `approved`/`invoiced` — frozen, for everyone, admin included
- Audit rows written by triggers, so they cannot be skipped

The anon key ships inside the mobile bundle and is trivially extractable. That
is fine and expected: RLS is what makes it safe. The working assumption
throughout was that someone will call the API directly with a valid driver
token.

### 3.5 Pay is computed once, at approval, and never recomputed

`approve_tag()` reads the rate table and freezes `computed_pay_cents`. Period
close copies that figure; it does not recalculate. Recomputing at close would let
a rate change after approval silently alter what someone is paid.

Related: the dollar figure printed on a scale ticket is **the quarry billing
their customer** — never what we owe the hauler. The extraction prompt is
explicit about not conflating them.

---

## 4. What was built

~9,500 lines at first pass, plus a second round closing gaps.

```
apps/mobile      Expo — iOS + Android from one codebase
apps/web         Office console: queue, review, rescan, approve, close
packages/shared  Types + validation rules both clients run
supabase/        9 migrations, 3 edge functions, seed data
scripts/         Two setup scripts
docs/            SETUP, ROLES, the deck, this log
```

### First pass

| Piece | Notes |
|---|---|
| Portal + sign-in | Phone OTP leads (gloves, no work email); email/password for owner-operators |
| Capture | Photo → SQLite + disk **before** anything touches the network. Biometric confirm. Resized to 2000px before queueing |
| Offline queue | Client-generated UUID doubles as idempotency key, so a retry storm cannot double-file |
| Tag list / detail | Read-only by design — a submitter who can edit tonnage afterwards is threat #1 |
| Pay screen | "Approved, not yet invoiced" is the number people actually open it for |
| Office queue | Blocking work first; filter by book |
| Review screen | Photo beside fields, per-field confidence, live arithmetic under the weights |
| Schema + RLS | 001–006: tables, policies, audit, storage, resolution, quota |
| Extraction | Claude vision, strict JSON schema, per-field confidence, instructed to return `null` rather than guess |

### Second pass — the gaps

| Was missing | Now |
|---|---|
| Nothing started the reader; tags sat at "Sent" forever | `pg_net` trigger on image insert + 5-minute cron backstop |
| No push | Rescan (high priority) and approval (with the amount). Tapping opens that ticket |
| Re-photographs undetectable | dHash — 9×8 greyscale, box-downsampled, 64 bits of structure. Survives a different angle; diverges immediately on a different document |
| No invoicing | `close_period` with preview-before-commit, issue, void. Separate books, always |

Deliberately **not** built, and why: Google Sheets needs the user's service
account *and* their real sheet layout, neither of which can be guessed.

---

## 5. Bugs found and fixed

Worth listing, because several were only findable by looking hard at code that
had never run.

**Found by review, before anything executed:**

1. `app.match_rate(...).id` — field access on a composite-returning function is a
   **syntax error** in Postgres without parentheses.
2. The rate limiter counted `audit_log` rows with `action='extract'`, which the
   audit trigger never writes. It was a **complete no-op** — a security control
   that did nothing. Replaced with an `api_usage` table that records and counts
   in one statement (counting then recording leaves a concurrency window).
3. A correlated `= any(select upper(unnest(aliases)))` subquery, rewritten to the
   clearer `from unnest(aliases) a` form.
4. `fontVariant: [...] as const` does not assign to React Native's `TextStyle`.
5. A `review_queue` view nothing used — deleted rather than left to rot.
6. `validation.ts` was dead code. Rather than delete it, it was wired into the
   review screen for live feedback on unsaved edits, so client and server share
   one definition of the rules.

**Found in the deck, by checking it with a pencil:**

7. The cost table listed an optional $400 scanner inside the column but excluded
   it from the totals — so the arithmetic did not add up. Moved to a footnote. A
   cost table has to survive being checked.
8. Diagram labels straddling box borders: the gaps were 43px and the labels
   wider than that at any readable size. They were also restating what the boxes
   said, so they were removed rather than shrunk.

**Found by the first real compile** (§7):

9. `App.tsx` — `navigate('TagDetail' as never, {...} as never)` does not
   typecheck. Replaced the casts with a real `RootStackParamList`, so route
   params are now genuinely checked.
10. `notifications.ts` — this expo-notifications version still requires
    `shouldShowAlert` alongside the newer `shouldShowBanner`/`shouldShowList`.

---

## 6. The deck

Published as an artifact and saved at [pitch.html](pitch.html). Nine slides:
what it does, the rescan loop, the two books, the controls, **four options for
getting tickets in**, and costs monthly and yearly.

Design notes, since they were deliberate:

- Palette from the world the app lives in — asphalt, concrete, signal blue for
  company trucks, hi-vis amber for subhaulers. The two lane colours are the same
  ones the app uses, so deck and product read as one thing.
- Archivo (industrial grotesque) + IBM Plex Sans + IBM Plex Mono. The mono
  carries the ticket mock, because scale tickets are monospace printouts.
- Slide numbers are real information — it is a deck and the order is the
  argument, not decoration hung on unordered sections.

**The costs, as presented:**

| | Pilot | Small fleet | Growing |
|---|---|---|---|
| Tickets/month | ~150 | ~500 | ~2,000 |
| Monthly | $3 | **$40** | $104 |
| Yearly running | $36 | $480 | $1,248 |
| First year all-in | $160 | $604 | $1,372 |
| Every year after | $135 | $579 | $1,347 |

Against roughly **17 hours a month** of hand-keying at 500 tickets (two minutes
each), or about $370/month of loaded time.

Option A on the ladder — a quarry digital feed — is free, needs five phone
calls, and is the only route with **zero** human touches, because the numbers
come off the vendor's own scale.

---

## 7. The environment detour

Worth recording in full, because the first diagnosis was wrong and the reason
is non-obvious.

**Symptom:** `npm : The term 'npm' is not recognized`.

**First diagnosis (wrong):** a probe of common install paths reported no Node
anywhere, so Node was installed via `winget`. That failed with MSI error 1603 at
`LaunchConditions` — the installer had read `VersionNT = 603`, `WindowsBuild =
9600`, i.e. **Windows 8.1**, on a machine actually running Windows 10 build
19045.

**Actual cause:** this session's sandbox is not expanding `$env:ProgramFiles`.
The probe tested `\nodejs\node.exe` and found nothing. The same bug had already
surfaced once, when a cleanup command was blocked for apparently targeting `/`.

Node **was** installed all along at `C:\Program Files\nodejs` (v26.7.0). The
user's terminal simply predated the PATH entry. A redundant Node 22 was
installed from the official ZIP during the detour and has been removed from PATH.

**Then, having a working Node — the first real compile:**

```
npm install          970 packages
npm run typecheck    mobile ✓  web ✓  shared ✓
vite build           422 KB, 121 KB gzipped
expo config          exit 0 under Node 26
```

Two errors surfaced and were fixed (items 9 and 10 above). Everything else that
had been written blind compiled.

**Docker, which remains blocked:** Docker Desktop is installed but cannot start.
Diagnosis is precise — the CPU (i7-8700K) has virtualization **enabled in the
BIOS**, but Windows' hypervisor platform is off, so `HypervisorPresent` reads
`False`. Fixing it needs elevation and a reboot, which a non-interactive session
cannot do.

Rather than leave the project blocked, the setup was restructured around **two
tracks**, with hosted Supabase requiring no Docker at all. `npm run setup` now
detects which track applies. Both paths were tested, including the message shown
when neither is configured.

**One more thing the detour caught:** `npm i -g supabase` — which the first draft
of SETUP.md instructed — would have failed. Supabase removed support for global
npm installs. The CLI is now a project dev dependency, so `npx supabase` and the
`npm run db:*` scripts resolve it automatically.

---

## 8. Where it stands

**Verified:** installs, typechecks clean across all three workspaces, office
console builds, Expo CLI runs.

**Not verified:** nothing has touched a real Supabase project, and no real scale
ticket has been through the reader. Every claim about extraction accuracy is
untested — which is exactly what step A4 in [SETUP.md](SETUP.md) exists to fix.

### Blocked on the user

1. Enable the Windows hypervisor features and reboot — *or* skip it entirely and
   use hosted Supabase.
2. Anthropic account, $20 of credit, and a $50/month spend limit.
3. Twenty to fifty real ticket photos, deliberately including the bad ones.
4. Four decisions: how driver pay is calculated, what a pay period is, who
   approves, and whether subhaulers are paid on the same basis.
5. Five phone calls to the biggest quarries.

### Still unbuilt

- Google Sheets — rate import and invoice export. ~1 day once someone can see
  the real sheet.
- A rate-management screen. Most likely first thing to want.
- Quarry-invoice reconciliation — the piece that eventually retires most of the
  reviewing.
- Second-pass consensus extraction.
- Dispatch/GPS cross-verification. Coordinates are captured; nothing compares
  them to quarry locations yet.
- A global daily spend ceiling. Per-user limits exist; fifty phones at once are
  not capped.

---

## 9. Things worth not forgetting

- **The five phone calls beat any code here.** One high-volume quarry saying yes
  to a digital feed removes hundreds of photos a month permanently.
- **Measure net-tonnage accuracy before trusting anything.** That single number
  decides how heavy the review step has to be.
- **The typing should go to zero. The checking should not.** An approval that
  takes one second on a screen where every field is already correct is not data
  entry — it is the control that makes a settlement defensible when a driver
  disputes it.

---

# Session 2 — native apps, and no more paid OCR

**Date:** 29 August 2026

## 10. What was asked

> "Read the build log from this directory. I want you to take that prototype and
> build a fully functioning app use whatever languages apis and tools needed for
> ios in swift and android. I want to get rid of the claude ocr I want to have no
> cost to low self cost on imaging and then make an easy one page guide on
> starting"

Three things: native apps rather than Expo, no paid reader, and one page to get
going. The third turned out to be the easiest to write once the second was true,
because the setup lost a whole step.

---

## 11. The decision that shaped everything: what replaces the model

The obvious substitutes were all worse than they look.

| Option | Why not |
|---|---|
| A cheaper hosted vision API | Still per-ticket, still needs signal, still a key that can run up a bill. Trades a good vendor for a worse one |
| A self-hosted model | "No cost" becomes a GPU bill and an ops burden for a small fleet |
| Tesseract on the server | Free, but the photo still has to reach a server, and the driver still finds out hours later that it was unreadable |
| **On-device OCR** | Free, offline, instant, and no key exists to leak |

So: **Apple Vision on iOS, ML Kit on Android.** Both first-party, both bundled,
both free at any volume, both run with the phone in aeroplane mode.

### The honest accounting

A language model reads a ticket layout it has never seen better than a
deterministic parser does. That is a real loss and it is written down in
[OCR.md](OCR.md) rather than glossed.

What buys it back is that **the failure modes differ in the right direction.** A
model that misreads returns a confident, well-formed, wrong number, and a
reviewer glancing at a clean form has no reason to doubt it. The parser, when it
misreads, usually finds no label or fails a shape test and returns `null` — which
is loud, routes to a person, and names the field it could not read. For a system
whose entire premise is that no unreviewed machine output reaches an invoice,
being wrong *visibly* beats being wrong *plausibly*.

### The thing that mattered more than the parser

`VNDocumentCameraViewController` and `GmsDocumentScanning` — the OS document
scanners. They find the edges of the paper, correct perspective, crop out the
truck seat and boost contrast before the recogniser sees a pixel. A ticket shot
at an angle across a lap comes through them reading like a flatbed scan.

Both are free and already on the phone. This was worth more to accuracy than any
amount of tuning inside the parser, and it was about thirty lines on each
platform.

### The control that genuinely moved

Reading moved to an untrusted client, so a client could claim confidence 1.0 on
everything and sail past the floors in `validate_tag()`. Three answers, in
`010_ondevice_ocr.sql`:

1. `apply_extraction()` can only reach `'extracted'`. Every control — duplicate
   ticket, arithmetic, capacity, rate lookup, separation of duties — still runs
   server-side afterwards, exactly as before.
2. `app.confidence_is_defensible()` re-derives what it can *without* consulting
   the client's numbers: a high-confidence ticket number appearing nowhere in the
   submitted OCR text was not read off that photo; certainty about weights that
   contradict each other is not certainty.
3. The photo is still uploaded and retained. A submitted reading that disagrees
   with the image is a reviewable lie with the proof attached — a better position
   than before, not a worse one.

Worth being clear that the photo was never the trusted part. A driver could
always photograph whichever ticket they liked.

---

## 12. The parser

Written three times from one specification, because there was no way around it:
TypeScript (canonical, and the only one runnable here), Swift, Kotlin.

Four ways a field gets a value — label on the same line, label to the left of the
value, label above the value, or a shape heuristic with no label — scored by
`ocr x label x pattern-fit x proximity`. The heuristic route is capped at 0.70
against a pay-critical floor of 0.95, so a guess from page position can never
clear the bar on its own.

**The arithmetic check is what makes a deterministic parser viable at all.**
Three weights agreeing to within a hundredth of a ton is genuine independent
confirmation that all three were read correctly, and it is the only route by
which anything here reaches 0.95. Everything else tops out below it.

Refusals that are deliberate and tested:

- **Net is never computed from gross minus tare.** That is what the ticket says
  net *should* be, not what it says net *is*, and net is the number that gets
  paid. The figure goes in the notes for the reviewer; the field stays null.
- **Cubic yards are detected, never converted.** Density varies by material by
  enough that a fixed factor would be a guess with a dollar sign on it.
- **A dollar figure is never a weight.** `NET AMOUNT DUE $486.64` sits on a line
  labelled NET, and taking it would hand a reviewer a plausible wrong tonnage.
- **A date with no year is not a date.**
- **Repairs cost confidence.** `O` to `0` inside a run of digits is allowed; each
  repaired character costs 12%, so two repairs land under every floor.

### The one bug that mattered

The first draft matched labels against a punctuation-stripped copy of the line
and took the value from that same copy — so `NET WT 48.32` became `NET WT 48 32`
and the parser read a **forty-eight ton** load instead of forty-eight point three
two. Six of sixteen tests failed on it.

Labels now match through a punctuation-tolerant regex while the value is taken
from the *unmodified* text, and all three implementations carry a comment saying
why. This is exactly the class of bug the conformance suite exists for: it is
invisible by inspection, it produces a plausible number, and it would have been
found by an argument about a settlement rather than by a test.

Second one, smaller: on a two-column ticket the row below a label is the *next
label*, so the truck number read as the word `PRODUCT`. Fixed by refusing any
candidate whose entire text is itself a known label.

**16/16 conformance tests pass** — `npm test --workspace @tagsnap/shared`.

---

## 13. What else got built

| | |
|---|---|
| `ios/` | Swift + SwiftUI, iOS 16, **zero third-party dependencies**. URLSession, SQLite, Keychain, Vision, VisionKit, CoreLocation, LocalAuthentication. Project generated from `project.yml` by XcodeGen |
| `android/` | Kotlin + Compose, API 26. ML Kit, OkHttp, WorkManager, EncryptedSharedPreferences |
| `010_ondevice_ocr.sql` | `apply_extraction`, `extraction_failed`, the agreement check, GPS quarry resolution, the unread sweep |
| `_shared/push.ts` | APNs (ES256) and FCM v1 (RS256) direct, replacing the Expo relay. Both free |
| [START-HERE.md](START-HERE.md) | The one page |
| [OCR.md](OCR.md) | How reading works, and how to improve it without writing code |

### Free signal the old pipeline never used

Every capture already recorded coordinates and every quarry already had a
location on file — nothing compared them. `app.quarry_near_capture()` now
resolves the vendor when the printed name does not match, recorded as a `gps`
verification so a reviewer can see why. That closes one of the "still unbuilt"
items from section 8, and it cost about forty lines of SQL.

### Things deliberately left alone

- **`apps/mobile`** — the Expo prototype. Superseded, marked as such, not
  deleted. There is no git in this directory and deletion is unrecoverable.
- **`extract-tag`** — moved to `supabase/functions/.retired/`, which the CLI
  ignores. It documents the extraction contract the parsers had to match, and if
  a layout ever genuinely defeats the parser it is the shape of the fallback: a
  per-ticket button on the review screen, not a call on every ticket.
- **The console's "read it again" button** — there is no server-side reader to
  ask twice. Replaced with **Show the raw text**, which is more useful anyway: it
  shows whether the reader misread the ticket or the parser picked the wrong
  line, and those are different problems with different fixes.

---

## 14. What was and was not verified

**Verified on this machine:**

- 16/16 parser conformance tests pass
- All three TypeScript workspaces typecheck clean
- The office console builds — 426 KB, 122 KB gzipped
- `setup-local.mjs` parses

**Not verified, and not verifiable here:** neither native app has been compiled.
This is a Windows machine with no Xcode and no Android SDK. The Swift and Kotlin
are written against documented APIs and reviewed by eye; expect the first build
on a Mac and in Android Studio to surface import and version adjustments. The
dependency versions in `libs.versions.toml` are the first thing to check.

Also still unverified from session 1: nothing has touched a real Supabase project
or a real scale ticket.

---

## 15. Cost, now

| | Before | Now |
|---|---|---|
| Reading one ticket | $0.01–0.03 | **$0** |
| 500 tickets/month | ~$10 | **$0** |
| 2,000 tickets/month | ~$40 | **$0** |
| Supabase | $25 | $0 until ~2,000 tickets, then $25 |
| Push | Expo relay | $0, direct to APNs and FCM |

The per-ticket cost of this system is now zero and stays zero as the fleet grows.
The only dial left is photo storage — the JPEG quality and the 2,000px cap in the
capture screens, about 400 KB a ticket, roughly 200 MB a month at 500 tickets.

---

## 16. Still the highest-value thing, still unchanged

**Call the five biggest quarries.** A digital feed from one high-volume vendor
removes hundreds of photos a month permanently, and those numbers come off the
vendor's own scale rather than off a picture of a piece of paper. Two sessions of
code have not moved this off the top of the list.

The second: **put twenty real tickets through and count how many had the net
tonnage read correctly with no correction.** Every decision about how heavy the
review step needs to be depends on that number, and it is still unmeasured.

---

# Session 3 — the first real database

**Date:** 8 September 2026
**Project:** `mdaogqnyaylqcvhpgxox`, hosted. Docker still will not start on this
machine (`HypervisorPresent = False`), so the local track stayed unavailable.

Sessions 1 and 2 both ended with the same caveat: *nothing has touched a real
Supabase project*. This is the session where it did, and three things fell out
of it that no amount of reading the SQL would have found.

---

## 17. What the deployment found

### 17.1 `array_to_string()` cannot be used in an index expression

`001_schema.sql` failed on statement 9 of the first push:

```
ERROR: functions in index expression must be marked IMMUTABLE (SQLSTATE 42P17)
create index quarries_alias_trgm on quarries
  using gin (array_to_string(aliases, ' ') gin_trgm_ops)
```

Postgres marks `array_to_string` STABLE, not IMMUTABLE, because an element
type's output function is *permitted* to be stable. For `text[]` it is not —
text output is the identity — so the fix is an immutable wrapper:

```sql
create or replace function app.alias_text(text[])
returns text language sql immutable parallel safe
as $fn$ select upper(array_to_string($1, ' ')) $fn$;
```

Three indexes in 001 and six expressions in 005 now use it.

**The `upper()` living inside the function is the part worth remembering.**
005 previously wrote `upper(array_to_string(aliases, ' '))` while the index was
built on `array_to_string(aliases, ' ')`. Those are different expressions, so
even once the index built, the resolver's query would never have used it —
a silent full scan of the alias list on every ticket. One function used
identically in both places is what makes the index real.

### 17.2 Every signed-in driver could read the service role key

`grant usage on schema app to authenticated` in 002 is necessary — RLS policy
expressions are evaluated as the calling user, so the helpers those policies
call must be callable by that user.

What was missed: **Postgres grants EXECUTE on every new function to PUBLIC by
default, and `authenticated` inherits PUBLIC.** Schema usage plus that default
meant every function in `app` was callable by every signed-in user, including:

```sql
app.config(text)   -- SECURITY DEFINER over app_config, which stores
                   -- service_role_key: the key that bypasses every policy
```

Being accurate about the exposure rather than dramatic: PostgREST only serves
the schemas listed under Settings → API → Exposed schemas, which is `public` by
default, so `app.config` was not reachable over the API *as configured*. The
problem is that it was one dashboard checkbox away from being reachable, the
checkbox exists for unrelated reasons, and a grant that is only safe because of
a setting somewhere else is not a safe grant.

`011_app_schema_grants.sql` revokes EXECUTE from PUBLIC across the schema, adds
`alter default privileges ... revoke execute` so later functions do not quietly
reappear, and grants back by name: the six policy helpers, the two storage-key
parsers, four pure functions, and the trigger functions. Six stay closed —
`config`, `match_rate`, `compute_pay_cents`, `sweep_unread_tags`,
`confidence_is_defensible`, `quarry_near_capture` — each of which is only ever
called from inside a SECURITY DEFINER function that runs as the owner, so
nothing legitimate lost access.

### 17.3 `push-rescan` was open to anyone holding the app

Its own header comment said it was "only reachable with the service key, which
never leaves the server". A `curl` with the **publishable** key — the one
compiled into both mobile apps — got a 200.

`verify_jwt = true` does not help, and this is the useful generalisation: the
gateway check is satisfied by *any valid key for the project*. For an endpoint
only the database should reach, the gateway cannot tell the difference. The
check has to be inside the function.

`isServiceRole()` in `_shared/http.ts` now compares the bearer token against
`SUPABASE_SERVICE_ROLE_KEY` in constant time, fails closed when the variable is
unset, and logs why. Verified after redeploy: 401.

Worth noting the severity honestly — no data came back either way, and the
worst an attacker could do was make a driver's phone buzz about their own
ticket. But a notification system strangers can fire is a notification system
people mute, and the muted one is the rescan.

### 17.4 The guide told you to run the wrong file

`docs/START-HERE.md` step 2 said to run `supabase/seed.sql` in the dashboard.
That file's own header says **"Never run this against a real project: it
creates accounts with known passwords"** — four of them, password
`tagsnap-dev-1`.

Replaced with `supabase/bootstrap.sql`, which creates no accounts at all. It
looks up a user you made yourself in Authentication → Users, attaches an admin
profile, and adds one quarry, one material and one wildcard rate — the minimum
needed for something to be approvable, since `validate_tag()` flags
`no_rate_on_file` otherwise.

---

## 18. What is now actually running

| | |
|---|---|
| 11 migrations | applied |
| `tag-images` bucket | created, private, 15 MB cap |
| `sign-image` | deployed, refuses unauthenticated callers |
| `push-rescan` | deployed, refuses non-service callers |
| 7 edge function secrets | set |
| Office console | builds and serves |

Anonymous REST access fails at `permission denied for function can_see_tag` —
the policy helper is unreachable to `anon`, so the request dies before a policy
is even evaluated. That is the earliest and cheapest place for it to fail.

**Still unverified:** no user has signed in, no photo has been captured, no
ticket has been read. The parser has still never seen a real scale ticket, and
that remains the number that decides everything.

---

## 19. Two environment notes for next time

**PowerShell blocks `npm.ps1` and `npx.ps1`** on this machine — an execution
policy, nothing to do with Node. `npx.cmd` works, and a plain `cmd.exe` prompt
works, so no security setting had to be changed to get past it. The guide now
gives PowerShell env vars one line at a time rather than chained with `;`,
because a half-pasted three-clause line is what left the terminal sitting at a
`>` continuation prompt.

**Newer Supabase projects issue `sb_publishable_...` keys** rather than a
`eyJhbGci...` JWT. They drop into the same slot and every client here treats
the key as an opaque string, so nothing needed changing. One trap worth
knowing: `GET /rest/v1/` answers 401 *"only secret API keys can be used for
this endpoint"* for a publishable key. That is the schema endpoint being
restricted, not a bad key — check against a real table path instead.

---

## 20. The rate book, and a fail-open bug it uncovered

**Asked for:** "web needs a page for rates which can be edited by company
owners." Section 8 predicted this would be the first thing wanted, and it was.

### 20.1 What the screen had to make obvious

Three facts about the `rates` table cost money quietly when misread, so the
layout is built around them rather than around the columns:

- **The two books never mix.** `payee_type` is the one matching column that is
  never a wildcard. One book is shown at a time — never a single list with a
  payee column somebody could misread.
- **Blank means "any".** A rate with no quarry applies at every quarry. Blank
  scopes render as the word "Any", never as an empty cell, because a wildcard
  that looks like missing data is how somebody deletes a rate believing it to
  be incomplete.
- **Most specific wins.** Rows are ordered by specificity, not alphabetically,
  so reading down the list is reading the same decision `app.match_rate` makes.

### 20.2 Supersede, not edit

The primary verb is **supersede**. A rate row is a historical record: editing
one in place rewrites what past loads would have paid. It does not rewrite what
they *did* pay — `approve_tag` freezes `computed_pay_cents` and period close
copies that frozen figure — but a rate table that disagrees with the
settlements printed off it cannot be reconciled against six months later.

So `rate_book` exposes `loads_priced`, and the screen offers a plain **Edit**
only when that is zero. Everything else gets **Change price**, which calls
`supersede_rate()`: close the old row the day before, open the new one, one
transaction. Doing that as two client-side writes leaves either a gap where
every load is held at `no_rate_on_file`, or an overlap where two rows of equal
specificity both match — neither discoverable until somebody is paid wrongly.

Superseding defaults to **tomorrow**, not today, because a rate starting today
would reprice loads hauled this morning, and the hauler agreed a price before
they drove.

### 20.3 The bug the tester found

The "what would this load pay?" panel calls `preview_rate()` rather than
working out the winning row in TypeScript, because two implementations of "most
specific wins" disagree eventually and the screen contradicting the settlement
is the worst place for it.

Calling that endpoint with nothing but the **publishable key** returned 200.
`supersede_rate` skipped its admin check entirely. The cause is three-valued
logic, and the code reads as though it is obviously correct:

```
app.current_role()   -> NULL when there is no profile row
app.is_office()      -> NULL in ('office','admin')  -> NULL, not false
if not app.is_office() then raise ...
                     -> `not NULL` is NULL
                     -> the branch is not taken
                     -> execution continues past the guard
```

Nine call sites were affected, five of them pre-existing since sessions 1
and 2: `price_tag`, `learn_alias`, `preview_close`, `close_period`,
`void_invoice`, plus the three new ones. `app.can_see_tag` had the same
problem, ending as it did in `t.created_by = auth.uid()` — NULL for a caller
with no session — so `price_tag` was reachable by anyone who knew a tag UUID.

**The RLS policies were never affected.** A policy treats NULL as "no", so
`using (app.is_office() and ...)` filtered every row out exactly as intended.
That is what made this survive review: the identical expression is safe in a
policy and fails open in a plpgsql guard.

`013_guards_fail_closed.sql` fixes it in the three helpers — `coalesce(...,
false)` — rather than at the nine call sites, because nine edits is nine
chances to miss one and the next function written would inherit it again. It
also adds `app.require_session()` in front of the privileged functions as a
second layer, so a future change to the helpers cannot quietly reopen the same
door.

Verified after the push: `preview_rate` and `supersede_rate` both answer 401
"not signed in"; `price_tag` answers "tag not found" without revealing whether
the tag exists.

### 20.4 New objects

| | |
|---|---|
| `rate_book` | the table with names joined, `loads_priced`, `in_force`, `specificity`. `security_invoker`, so a subhauler still sees only their own agreement |
| `preview_rate()` | the supervised way to reach `app.match_rate`, which stays revoked from clients |
| `supersede_rate()` | close and reopen, atomically |
| `end_rate()` | stop a rate without replacing it |
| `apps/web/src/pages/Rates.tsx` | the screen |

Office accounts can read the book and not change it — `rates_admin_write`
requires admin. The nav link is shown to both, because "why was this priced at
that?" is a reviewer's question and the page answers it.
