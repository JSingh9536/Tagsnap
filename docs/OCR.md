# Reading tickets

How a photograph becomes fields, why it costs nothing, and what to do when it
gets one wrong.

---

## What changed, and why

The first version of TagSnap sent every photo to Claude and got back structured
fields with per-field confidence. It worked well and cost $0.01–0.03 a ticket.

It has been replaced by OCR that runs on the phone:

| | Old | Now |
|---|---|---|
| Reader | Claude vision, server-side | Apple Vision (iOS) / ML Kit (Android) |
| Cost per ticket | $0.01–0.03 | **$0** |
| Works with no signal | No | **Yes** |
| Time to a result | 2–6 seconds, needs a server | 0.3–0.6 seconds, on the device |
| Failure feedback | Hours later, from the office | Immediately, ticket still in hand |
| Understands an unseen layout | Very well | Only via labels it knows |

The last row is the real trade, and it is worth stating plainly: **a language
model reads a ticket it has never seen better than this does.** What it buys
back is everything else in the table — and one thing that does not fit in a
table.

### The failure modes are different, and this one is better

A vision model that misreads a ticket returns a confident, well-formed, wrong
number. A reviewer glancing at a clean-looking form has no reason to doubt it.

This parser, when it misreads, usually finds no label at all, or finds a value
that fails a shape test, and returns `null`. A null is loud. It routes to a
person and it says which field it could not read.

For a system whose entire purpose is that no unreviewed machine output reaches
an invoice, **being wrong visibly beats being wrong plausibly.**

---

## The pipeline

```
  the phone                                    the server
  ---------                                    ----------

  document scanner
    edge detect, deskew, crop, contrast
    (VisionKit / ML Kit — free, on-device)
        |
        v
  text recognition
    lines + boxes + confidence
    (Vision / ML Kit — free, on-device)
        |
        v
  ScaleTicketParser
    labels -> values -> confidence
        |
        v
  saved to SQLite with the photo  ---------->  apply_extraction()
  (works with no signal at all)                  resolve quarry/material/job
                                                 GPS fallback for the quarry
                                                 write the reading
                                                       |
                                                       v
                                                 validate_tag()
                                                   confidence floors
                                                   gross - tare = net
                                                   over capacity
                                                   duplicate ticket
                                                   rate on file
                                                       |
                                                       v
                                                 ready  |  needs_review
```

Nothing on this path can approve anything. The device pushes a *reading*; every
control that protects money still runs server-side where a client cannot reach
it. See the long comment at the top of `010_ondevice_ocr.sql` for exactly which
guarantees survived the change and which one had to be replaced.

### The document scanner matters more than the parser

`VNDocumentCameraViewController` on iOS and `GmsDocumentScanning` on Android
find the edges of the paper, correct the perspective, crop out the truck seat,
and boost contrast on a faded carbon copy — before the recogniser sees a pixel.

A ticket photographed at an angle across a lap, run through this, reads like a
flatbed scan. The same photo from a plain camera reads like a photo taken at an
angle across a lap. Both scanners are free and ship with the OS.

---

## How the parser decides

Four ways a field gets a value, in order of preference:

| How | Example | Ceiling |
|---|---|---|
| Label, same line | `NET WT 21.34` | 0.99 |
| Label, value to the right | two columns | 0.94 |
| Label, value beneath | a column header | 0.84 |
| Shape heuristic, no label | the vendor name in the header block | **0.70** |

The 0.70 cap is deliberate. `PAY_CRITICAL_FLOOR` in `validation.ts` is 0.95, so
a guess based on page position can never clear the floor on its own. It reaches
a person every time — but a person with the right answer already typed in.

### The arithmetic check is what makes this viable

Three weights that agree to within a hundredth of a ton were almost certainly
all read correctly; if a single digit had been misread they would not. That is
genuine independent confirmation, not a heuristic, and it is the **only** route
by which this parser reaches the pay-critical floor.

When they disagree, all three drop by half and the note says by how much.

### Things it will not do

- **Compute net from gross minus tare.** That is what the ticket says net
  *should* be, not what it says net *is*, and net is the number that gets paid.
  The figure goes in the notes for the reviewer; the field stays null.
- **Convert cubic yards to tons.** Density varies by material by enough that a
  fixed factor would be a guess with a dollar sign on it.
- **Take a dollar figure as a weight.** The amount printed on a scale ticket is
  the quarry billing their customer. A line mentioning money is heavily
  penalised as a weight candidate.
- **Assume a year.** A date with no year printed is not a date.
- **Repair a value into existence.** `O` inside a run of digits becomes `0`, and
  each repaired character costs 12% confidence. Two repairs put a field under
  every floor.

---

## Three implementations, one behaviour

| Where | File |
|---|---|
| Canonical | `packages/shared/src/parse/` |
| iOS | `ios/TagSnap/OCR/ScaleTicketParser.swift` |
| Android | `android/app/src/main/java/com/tagsnap/ocr/ScaleTicketParser.kt` |

The TypeScript version is the one to change first. It has the conformance suite
— sixteen fixtures covering every ticket layout and every refusal above — and it
is the only one that can be run without a device:

```bash
npm test --workspace @tagsnap/shared
```

The Swift and Kotlin suites carry the same fixtures. All three must agree on the
values and, more importantly, on **which side of the confidence floors** each
field lands, because that is what decides whether a human sees the ticket.

---

## Making it better at your vendors

This is the part that pays off, and it needs no code.

### 1. Correct the quarry and material names in the console

Every correction appends the raw OCR text to that entity's alias list —
`learn_alias()` in `003_logic.sql`. After a few hundred tickets the resolver
knows what your specific vendors print, and the "quarry unresolved" flag stops
appearing. Nobody trains anything.

### 2. Add a label when the same field is wrong twice on the same vendor

Open one of those tickets in the console and press **Show the raw text**. If the
words are right but the field is empty, that vendor prints a label the lexicon
does not know.

Add it to `packages/shared/src/parse/lexicon.ts`, then to the Swift and Kotlin
files, then add a fixture. It is a one-line change and it costs nothing at
runtime.

### 3. Watch the number that matters

```sql
select day, engine, readings, clean, round(100.0 * clean / readings) as pct_clean
  from daily_extraction_health
 order by day desc;
```

`clean / readings` is the fraction of tickets nobody had to retype. That single
number decides how heavy the review step has to be, and it is the one to put on
a wall.

---

## If a photo genuinely cannot be read

The phone calls `extraction_failed()` instead of `apply_extraction()`. The tag
goes straight to the review queue with the photo attached and an honest note
saying the phone could not read it. Somebody types the fields in — a known cost,
and far better than a ticket sitting at "Sent" forever.

A tag that has had a photo for thirty minutes with no reading is swept into the
same place by `app.sweep_unread_tags()`, in case the phone died or the app was
uninstalled mid-upload.

---

## If you ever want the model back

`supabase/functions/.retired/extract-tag/` is the original Claude extractor,
kept intact and not deployed. The sensible way to reintroduce it is **not** on
every ticket — it is as a per-ticket button on the review screen, for the
handful of layouts that defeat the parser. That keeps the cost proportional to
the problem instead of proportional to the volume.

It should call `apply_extraction()` rather than writing to `tags` directly, so
both readers run the same controls.
