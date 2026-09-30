# Start here

One page. Follow it top to bottom and you will have the database up, the office
console running, and the app on a phone reading a real ticket.

Budget about **90 minutes**, most of it waiting for Xcode or Android Studio.

---

## What you need first

| | |
|---|---|
| A computer | Mac for iOS. Anything for Android and the console. |
| [Node 20+](https://nodejs.org) | `node --version` should print a number. |
| A [Supabase](https://supabase.com) account | Free tier is enough to start. |
| 20–50 photos of real scale tickets | Include the bad ones. This is the important one. |

**Not needed any more:** an Anthropic key, or any AI account. Reading tickets
now happens on the phone, for free. Nothing in this system charges per ticket.

---

## 1. Create the database — 10 min

Make a new project at [supabase.com/dashboard](https://supabase.com/dashboard).
Save the database password somewhere; you cannot see it again.

From **Project Settings → API**, copy the **Project URL** and the **anon** key.

> Newer projects issue `sb_publishable_...` instead of a `eyJhbGci...` JWT.
> Either works — it goes in the same slot and TagSnap treats it as an opaque
> string. If you want to check one by hand, note that
> `GET /rest/v1/` answers 401 *"only secret API keys can be used for this
> endpoint"* for a publishable key. That is the schema endpoint being
> restricted, not a bad key. Query a real table path instead.

You do not need the service_role key — nothing in a hosted setup uses it, and a
key that bypasses every security policy is worth not copying around until
something asks for it.

```bash
npm install
```

Paste your two values in, once. This writes every config file the console and
both apps need, so you never edit one by hand. In PowerShell, one line at a
time — a half-pasted line leaves you at a `>` prompt waiting for a closing
quote, and Ctrl+C is the way out:

```bash
$env:SUPABASE_URL="https://YOURREF.supabase.co"
```

```bash
$env:SUPABASE_ANON_KEY="eyJhbGciOi..."
```

```bash
npm run setup
```

Then create the tables:

```bash
npx supabase link --project-ref YOUR-PROJECT-REF
```

```bash
npm run db:push
```

That last command creates every table, policy and function. If it prints no
errors, the backend is done.

Push notifications are optional and can wait — when you want them, see the
platform READMEs, then run `npm run db:config` once to tell the database where
to send them.

---

## 2. Add your company — 5 min

First make your account: dashboard → **Authentication → Users → Add user**.
Use your real email and a password you choose. Tick *Auto Confirm User*.

Then open **SQL Editor**, paste in `supabase/bootstrap.sql`, edit the six
values at the top, and run it. That creates your company, makes you an admin,
and adds one quarry, one material and one rate — enough to approve a load.

> Do **not** run `supabase/seed.sql` here. That one is for the local Docker
> stack and creates four accounts with a password printed in its own header.
> `bootstrap.sql` creates no accounts; it attaches a profile to the one you
> just made, so the only password involved is yours.

Make a **second** account the same way, with role `driver`, and add its profile:

```sql
insert into profiles (id, company_id, role, full_name)
values ('THE-DRIVER-UUID', (select id from companies limit 1), 'driver', 'Driver Name');
```

You need two, because `approver_is_not_submitter` stops an account approving a
ticket it filed itself. That is separation of duties, and it is a table
constraint rather than a setting — so there is no way to test the round trip
with one login.

---

## 3. Run the office console — 5 min

Step 1 already wrote `apps/web/.env`, so this is one command:

```bash
npm run web
```

Open <http://localhost:5173> and sign in. This is where tickets get reviewed and
approved — it is meant for a desktop, not a phone.

---

## 4. Build the phone app

Pick one. You do not need both to start.

Step 1 already wrote the config for both. What is left is the toolchain.

### Android — 20 min

Open the `android` folder in [Android Studio](https://developer.android.com/studio).
On first open it will offer to download **SDK platform 35** and to create the
Gradle wrapper — say yes to both. Then press **Run** and pick a device.

Android Studio brings its own Java, so it does not matter what `java -version`
says on your PATH. That only matters if you build from a terminal — see
[android/README.md](../android/README.md).

### iOS — 30 min

Needs a Mac with Xcode and an Apple Developer account.

```bash
brew install xcodegen
```

Open `ios/Config.xcconfig` and fill in the two Apple values — your Team ID and
the bundle id you registered. The Supabase pair is already there. Then:

```bash
cd ios && xcodegen generate && open TagSnap.xcodeproj
```

Press **Run**.

More detail, including push notifications, is in
[ios/README.md](../ios/README.md) and [android/README.md](../android/README.md).

---

## 5. Put a real ticket through it — 10 min

1. Sign in on the phone as a **driver**.
2. Photograph a real scale ticket. Hold it flat; it shoots itself.
3. The phone reads it on the spot and tells you whether it could.
4. Open the office console. The ticket is in the queue.
5. Check every field against the photo, correct anything wrong, approve it.

That round trip is the whole system. Everything else is volume.

---

## 6. The number that decides everything — do this next

Put **twenty real tickets** through, and count how many had the **net tonnage**
read correctly with no correction.

- **17 or more** — the app is doing its job. Approving is a glance and a tap.
- **12 to 16** — normal at the start. Correct the quarry and material names in
  the console; the resolver learns your vendors and this climbs on its own.
- **under 12** — something is systematic. Open a wrong ticket in the console and
  press **Show the raw text**. If the words are wrong, the photos need better
  light. If the words are right but the fields are wrong, that vendor's layout
  needs a label adding — see [OCR.md](OCR.md).

Nothing else on the roadmap matters until you know this number.

---

## The thing worth more than any of this

**Call your five biggest quarries and ask whether they can email you tickets as
data** — CSV, a spreadsheet, an API, anything. One yes from a high-volume
quarry removes hundreds of photos a month permanently, and those numbers come
off the vendor's own scale rather than off a picture of a piece of paper.

It costs five phone calls and no code.

---

## What this costs

| | Monthly |
|---|---|
| Reading tickets | **$0** — runs on the phone |
| Supabase | **$0** until ~2,000 tickets, then $25 |
| Push notifications | **$0** |
| Apple Developer (iOS only) | $99/year |
| Google Play (Android only) | $25 once |

A small fleet runs this for **nothing per month** for the first several months,
and $25/month after that.

---

## When something goes wrong

| Symptom | Look at |
|---|---|
| `npm` not recognised | Node is not on your PATH. Reopen the terminal. |
| `db:push` fails | You are not linked. Re-run `npx supabase link`. |
| Stuck at a `>` prompt | PowerShell is waiting for a closing quote. Ctrl+C, then paste one line at a time. |
| `secrets set` rejects a name | Use `supabase/.env.secrets`, not `supabase/.env`. Supabase refuses names starting with `SUPABASE_`. |
| Android Studio: "SDK 35 not found" | Accept the download it offers, or Tools → SDK Manager → Android 15 (API 35). |
| Sign-in says "wrong door" | The account's role does not match the button pressed. Office accounts use the browser. |
| Tickets stuck at "Sent" | Normal for 30 minutes at most; after that they move to the review queue automatically. |
| The phone says "hard to read" | Better light, ticket flat, no shadow. Retake it. |

Longer answers, both hosted and local setups, and the honest list of what is
still unbuilt: [SETUP.md](SETUP.md).
