# TagSnap for Android

Kotlin and Jetpack Compose.

| | |
|---|---|
| Minimum | API 26 (Android 8.0, 2017) |
| Reading tickets | ML Kit Text Recognition v2 — on-device, bundled model, free |
| Capture | ML Kit document scanner — edge detect, deskew, contrast |
| Storage | SQLite, EncryptedSharedPreferences, files in internal storage |
| Networking | OkHttp against Supabase's REST APIs |
| Background | WorkManager drains the outbox when coverage returns |
| Push | Firebase Cloud Messaging |

---

## What the build needs

Android Studio provides all three of these; check them only if you are building
from a terminal.

| | Why |
|---|---|
| **JDK 17–21** | AGP 8.7 does not run on JDK 22 or newer. Android Studio bundles JetBrains Runtime 21 and uses it by default, so opening the project works regardless of what `java -version` says on your PATH |
| **SDK platform 35** | `compileSdk = 35`. Studio offers to download it on first open |
| **The Gradle wrapper** | `gradle/wrapper/gradle-wrapper.properties` pins the version; Studio writes the `gradlew` scripts and the jar the first time it opens the project |

## Build it

Open the `android` folder in Android Studio. Accept the SDK download when it
offers, and let it create the Gradle wrapper.

```bash
cp android/local.properties.example android/local.properties
```

Fill in:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
```

Press **Run**. Once the wrapper exists, from a terminal:

```bash
cd android && ./gradlew installDebug
```

If that fails with a message about an unsupported class file version or an
unsupported JDK, you are on a JDK newer than 21. Point Gradle at Studio's:

```bash
cd android && ./gradlew installDebug -Dorg.gradle.java.home="/c/Program Files/Android/Android Studio/jbr"
```

Neither value is a secret. The anon key is published by design: it names the
project and grants nothing on its own, because every policy in `002_rls.sql`
decides what a request may actually do. Assume it is extracted from the APK on
day one. The key that *would* matter — the service role key — exists only in
the edge function environment and appears in no app target on either platform.

---

## Run the tests

```bash
cd android && ./gradlew testDebugUnitTest
```

`app/src/test/.../ScaleTicketParserTest.kt` is the parser conformance suite —
the same sixteen fixtures as the TypeScript and Swift versions. A plain JVM
test: no Robolectric, no emulator, no device, because the parser deliberately
touches nothing Android-specific.

All three implementations must agree on which side of the confidence floors each
field lands, because that is what decides whether a human sees a ticket before
somebody is paid on it.

---

## Push notifications

Optional. The app builds and runs without it — the account screen says so
plainly — and the driver just has to look at the Tickets tab to see a rescan.

1. Create a Firebase project at
   [console.firebase.google.com](https://console.firebase.google.com), add an
   Android app with package name **`com.tagsnap.field`** (and
   `com.tagsnap.field.debug` if you want push in debug builds).
2. Download `google-services.json` into `android/app/`. It is gitignored; the
   Gradle build detects it and applies the plugin only when it is present.
3. In Firebase, **Project settings → Service accounts → Generate new private
   key**. Then:

```bash
supabase secrets set FCM_SERVICE_ACCOUNT_JSON="$(cat service-account.json)"
```

4. Deploy: `npm run functions:deploy`

FCM is free at any volume this system will reach.

---

## Where things are

```
app/src/main/java/com/tagsnap/
  core/     secure storage, formatting, biometrics, location
  net/      Supabase client, models, reads
  ocr/      ML Kit, the parser, the lexicon, perceptual hashing
  store/    the offline outbox and the upload worker
  ui/       theme, state, the five screens
  push/     FCM
```

Three files carry most of the thinking:

- **`ocr/ScaleTicketParser.kt`** — how a photograph becomes fields. Ported from
  `packages/shared/src/parse/parse.ts`, which is canonical. Read
  [docs/OCR.md](../docs/OCR.md) first.
- **`store/Uploader.kt`** — four idempotent steps, in an order the storage
  policies require. A worker killed mid-flight and restarted lands in the same
  place.
- **`net/Supabase.kt`** — why there is no SDK here, and what the mutex on the
  token refresh is protecting against.

---

## Things worth knowing before you change something

**The model is bundled, not downloaded.** The manifest declares
`com.google.mlkit.vision.DEPENDENCIES = ocr`, which costs about 4 MB of APK and
means a driver whose first shift starts in a dead zone can still read a ticket.
That is precisely the case this app exists for; a reader that has to download
itself before it can read anything fails on day one.

**`SCANNER_MODE_FULL`, not `BASE`.** `BASE` is a plain camera with a crop box,
which throws away the edge detection and contrast correction that make the
reading good. The scanner is worth more to accuracy than any amount of parser
tuning.

**The pixel-to-normalised conversion in `TextRecognizer.kt` is load-bearing.**
ML Kit reports pixels; the parser assumes 0..1 with a top-left origin. Get it
wrong and "the line below the label" silently becomes something else.

**The perceptual hashes are compared across platforms.**
`similar_tag_images()` in `008_phash.sql` compares an Android hash against an
iOS one, because a mixed fleet is the normal case. The 9×8 grid, the Rec. 601
luma weights and the upright bitmap all have to match the Swift version exactly.

**Disk before anything else at capture.** The photograph is the only
irreplaceable thing in the whole flow. It is written to internal storage before
OCR, before hashing, before the outbox row, and long before any network call.
Internal storage rather than the shared media store, because these are somebody's
pay evidence and have no business appearing in the phone's gallery next to
family photos.

**R8 will silently break decoding if the serializer rules go.** Without the
`kotlinx.serialization` keeps in `proguard-rules.pro`, every response decodes as
an empty list in a release build — which looks exactly like "this driver has no
tickets" rather than like a crash.
