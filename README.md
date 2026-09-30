# TagSnap

Photograph a quarry scale ticket in the field. The office reviews it, sends it
back for a rescan if the photo is no good, and approves it. Approved tickets
become line items on the right person's invoice — a company driver's settlement
or a subhauler's payable, never both.

Implements the plan in [`../Trucktags/docs/`](../Trucktags/docs/ARCHITECTURE.md).

**Status:** the field app is native — Swift on iOS, Kotlin on Android — and
tickets are read **on the phone**, for nothing. The parser has a conformance
suite that runs in three languages; the TypeScript one passes here. Nothing has
touched a real Supabase project or a real scale ticket yet, and no native build
has been compiled on this machine (no Mac, no Android SDK).

**[docs/START-HERE.md](docs/START-HERE.md) is the one page to read first.**

---

## What is here

```
ios/             Swift + SwiftUI. No third-party dependencies at all
android/         Kotlin + Compose. ML Kit for reading, nothing else unusual
apps/web         The office console: review, rescan, approve
packages/shared  Types, validation rules, and the canonical ticket parser
supabase/        Schema, RLS policies, triggers, edge functions
apps/mobile      The Expo prototype these two replaced. Superseded; safe to delete
```

| | |
|---|---|
| [docs/START-HERE.md](docs/START-HERE.md) | **One page.** Database up, console running, app on a phone |
| [docs/OCR.md](docs/OCR.md) | How a photograph becomes fields, and why it costs nothing |
| [ios/README.md](ios/README.md) · [android/README.md](android/README.md) | Building each app, and what not to break |
| [docs/SETUP.md](docs/SETUP.md) | The long form: both database tracks, plus what is still unbuilt |
| [docs/ROLES.md](docs/ROLES.md) | Driver vs subhauler, and how the payee split is enforced |
| [fixtures/README.md](fixtures/README.md) | What ticket photos to collect, and the one number to measure |
| [docs/pitch.html](docs/pitch.html) | The deck: what it does, the options for getting tickets in, and costs |
| [docs/BUILD-LOG.md](docs/BUILD-LOG.md) | How this got built, what was decided and why, and what broke |

---

## The idea in one paragraph

This is an accounts-payable system with an OCR front door, not a camera app.
Money moves because of what it says, so no unreviewed machine output reaches an
invoice, the photo is retained permanently as the evidence, and every number
that changes is attributable to a person or a model run. Build it as "a cool
OCR app" and the first payment dispute is unanswerable. Build it this way and
a dispute is answered in ten seconds by pulling up the original ticket next to
the audit trail.

## The flow

```
  FIELD                        SERVER                      OFFICE
  -----                        ------                      ------
  photograph the ticket
  saved to SQLite instantly
  works with no signal
        |
  the phone reads it
  Vision / ML Kit, offline
  per-field confidence
  nulls, never guesses
        |
        | when there is signal
        v
  upload  ------------->  private bucket
                          tags row + the reading
                                |
                                v
                          controls run
                          - duplicate ticket?
                          - gross - tare = net?
                          - over capacity?
                          - quarry resolves?
                          - rate on file?
                                |
                   +------------+------------+
                   v                         v
               all clear                 something tripped
               ready                     needs_review
                   |                         |
                   +------------+------------+
                                v
                                              review screen:
                                              photo beside the fields
                                              correct, then either
                                                approve  -> FROZEN
                                                rescan   -> back to field
                                                reject
                                |
                                v
                          period close
                          driver settlement  |  subhauler payable
                          -> payroll         |  -> accounts payable
                          (separate books, always)
```

The review step is the control point. Everything before it is a suggestion;
everything after it is a financial record.

## Three things worth knowing before reading the code

**The database is the system of record, and it does the enforcing.** Duplicate
tickets, separation of duties, the arithmetic check, the payee split, the
freeze on approved tags — all of them are constraints and RLS policies, not
checks in application code. The anon key ships inside the mobile bundle and is
trivially extractable; that is fine, because RLS is what makes it safe. Assume
someone will call the API directly with a valid driver token.

**A driver and a subhauler are paid out of different books.** The app asks
which one you are before it asks anything else, and the answer follows the
ticket all the way to the invoice. [docs/ROLES.md](docs/ROLES.md) explains why
that is a schema decision and not a UI one.

**The rescan loop is the reason the office console and the field app are one
system.** A reviewer who cannot read the net weight presses one button and
picks a reason. The driver's phone buzzes, and that reason is printed across
their camera screen while they retake it. The new photo supersedes the old one
without destroying it — the original is the evidence for whatever was already
extracted from it.

## Cost

**Reading a ticket costs nothing.** Apple Vision and ML Kit are first-party,
on-device and free at any volume, so the per-ticket cost of this system is zero
and stays zero as the fleet grows. The only recurring bill is Supabase — free
until roughly 2,000 tickets, $25/month after — plus store fees.

A small fleet runs this for **nothing per month** to start with. What that
traded away, and what it bought, is in [docs/OCR.md](docs/OCR.md).

## The five phone calls

Still the highest-value thing on the list, and no code here changes it: call
your top five quarries and ask whether they can send tickets digitally in any
format. A yes from one high-volume quarry removes hundreds of photos a month
from this pipeline permanently, and those tickets arrive as authoritative data
from the vendor's own scale rather than a guess about what a photo says.
See [`../Trucktags/docs/INGESTION.md`](../Trucktags/docs/INGESTION.md).

The `tags.source` column is `driver_photo` today and exists so a quarry feed
can be added later as another adapter writing into the same pipeline, rather
than as a second system bolted alongside this one.
