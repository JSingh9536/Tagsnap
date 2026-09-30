# Retired

Nothing in this directory is deployed. The Supabase CLI ignores dot-prefixed
directories, so `supabase functions deploy` cannot pick these up by accident.

## extract-tag

The Claude vision extractor. Removed when reading moved onto the phone —
Apple Vision on iOS, ML Kit on Android — which costs nothing per ticket
instead of $0.01–0.03, works with no signal, and takes the Anthropic key out
of the deployment entirely.

Kept, not deleted, for two reasons. It documents the extraction contract the
on-device parsers had to match, field for field. And if a ticket layout ever
turns out to be genuinely unreadable on-device, this is the shape of the
fallback — a per-ticket paid read, invoked by hand from the review screen on
the handful that need it, rather than on all of them.

Bringing it back would need: `ANTHROPIC_API_KEY` set as a secret again, an
`app_config` row for `functions_url`, and something to call it. It should call
`apply_extraction()` rather than writing to `tags` directly, so both paths run
the same controls.

## phash.ts

Perceptual hashing, previously done here because the server had the image
bytes. The devices now compute the same 64-bit dHash before upload and send it
with the `tag_images` row — same algorithm, same bit layout, same
`app.phash_distance()` comparison in SQL.

Swift: `ios/TagSnap/Sources/OCR/PerceptualHash.swift`
Kotlin: `android/app/src/main/java/com/tagsnap/ocr/PerceptualHash.kt`

Kept as the reference implementation those two were written against.
