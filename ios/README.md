# TagSnap for iOS

Swift and SwiftUI. **No third-party dependencies at all** — everything it uses
ships with iOS.

| | |
|---|---|
| Minimum | iOS 16.0 (iPhone 8 and newer) |
| Reading tickets | Vision — on-device, free, works offline |
| Capture | VisionKit document scanner — edge detect, deskew, contrast |
| Storage | SQLite, Keychain, files on disk |
| Networking | URLSession against Supabase's REST APIs |
| Push | APNs directly, no Firebase |

---

## Build it

```bash
brew install xcodegen
```

```bash
cd ios && cp Config.example.xcconfig Config.xcconfig
```

Fill in `Config.xcconfig`:

```
SUPABASE_URL = https:/$()/your-project.supabase.co
SUPABASE_ANON_KEY = your-anon-key
TAGSNAP_TEAM_ID   = your Apple Developer team id
TAGSNAP_BUNDLE_ID = com.tagsnap.field
```

> The `$()` in the URL is not a typo. `//` starts a comment in an xcconfig
> file, and the empty interpolation breaks it up without changing the value.

```bash
cd ios && xcodegen generate && open TagSnap.xcodeproj
```

Press **Run**. The `.xcodeproj` is generated, not committed — it is a
3,000-line plist that every branch edits and nobody can review, and
regenerating it from `project.yml` removes a whole category of merge conflict.

Neither the URL nor the anon key is a secret. The anon key is published by
design: it names the project and grants nothing on its own, because every
policy in `002_rls.sql` decides what a request may actually do. Assume it is
extracted from the IPA on day one. The key that *would* matter — the service
role key — exists only in the edge function environment and appears in no app
target on either platform.

---

## Run the tests

⌘U in Xcode, or:

```bash
cd ios && xcodebuild test -scheme TagSnap -destination 'platform=iOS Simulator,name=iPhone 15'
```

`TagSnapTests/ScaleTicketParserTests.swift` is the parser conformance suite —
the same sixteen fixtures as the TypeScript and Kotlin versions. All three must
agree on which side of the confidence floors each field lands, because that is
what decides whether a human sees a ticket before somebody is paid on it.

---

## Push notifications

Optional. The app works without them; the driver just has to look at the
Tickets tab to see a rescan.

1. **developer.apple.com → Certificates, Identifiers & Profiles → Keys** →
   create a key with **Apple Push Notifications service** enabled. Download the
   `.p8`. You get one download; keep it.
2. Set the edge function secrets:

```bash
supabase secrets set APNS_KEY_ID=ABC123DEFG APNS_TEAM_ID=YOURTEAMID APNS_BUNDLE_ID=com.tagsnap.field APNS_ENVIRONMENT=development
```

```bash
supabase secrets set APNS_KEY_P8="$(cat AuthKey_ABC123DEFG.p8)"
```

3. Deploy: `npm run functions:deploy`

One `.p8` works for every app on the team, for both environments, and never
expires — this is token auth, not the old certificate-per-year arrangement.

**`APNS_ENVIRONMENT` must match `aps-environment` in
`TagSnap/TagSnap.entitlements`.** `development` for Xcode builds, `production`
for TestFlight and the App Store. A token minted in one environment is rejected
by the other, and that mismatch is the single most common reason push "works on
my machine and not on the tester's phone".

---

## Where things are

```
TagSnap/
  App/         entry point, root view, who-is-signed-in
  Core/        config, keychain, theme, biometrics, location, logging
  Net/         Supabase client, models, reads
  OCR/         Vision, the parser, the lexicon, perceptual hashing
  Store/       the offline outbox and the upload worker
  Features/    the five screens
  Push/        APNs registration
```

Three files carry most of the thinking:

- **`OCR/ScaleTicketParser.swift`** — how a photograph becomes fields. Ported
  from `packages/shared/src/parse/parse.ts`, which is canonical. Read
  [docs/OCR.md](../docs/OCR.md) first.
- **`Store/Uploader.swift`** — four idempotent steps, in an order the storage
  policies require. A worker killed mid-flight and restarted lands in the same
  place.
- **`Net/Supabase.swift`** — why there is no SDK here, and what the actor
  isolation on the token refresh is protecting against.

---

## Things worth knowing before you change something

**`usesLanguageCorrection` must stay off.** It is on by default in Vision and it
is the worst setting you can leave enabled for this job — it runs a language
model over the output and pulls text towards real words, which mangles ticket
number `0245871` and vendor codes like `57 CR STONE`. There are no sentences on
a scale ticket.

**The Vision coordinate flip in `TextRecognizer.swift` is load-bearing.** Vision
reports bottom-left origin; the parser assumes top-left. Miss the flip and "the
line below the label" silently becomes "the line above", which is the most
likely way a port of this goes wrong.

**Orientation before hashing.** `cgImage` ignores `imageOrientation`, and a
camera photo is almost never `.up`. The perceptual hashes are compared *across
platforms* by `similar_tag_images()`, so an unrotated buffer would give a
portrait ticket a different hash on iOS than the same ticket gets on Android.

**Disk before anything else at capture.** The photograph is the only
irreplaceable thing in the whole flow. It is written to disk before OCR, before
hashing, before the outbox row, and long before any network call.
