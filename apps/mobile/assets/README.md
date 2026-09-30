# Placeholder assets

`icon.png`, `adaptive-icon.png`, `splash.png`, and `favicon.png` are generated
placeholders — flat "TS" on the app's background colour. They exist so
`expo start` does not fail on a missing asset, not because they are any good.

Replace before submitting to either store. Requirements:

| File | Size | Notes |
|---|---|---|
| `icon.png` | 1024×1024 | No transparency, no rounded corners — iOS masks it itself |
| `adaptive-icon.png` | 1024×1024 | Android foreground layer. Keep the artwork inside the centre 66%; Android crops the rest to whatever shape the launcher uses |
| `splash.png` | any, portrait | Shown while the JS bundle loads. Background colour is set separately in `app.json` |
| `favicon.png` | 48×48 | Only used if the app is ever run on web |
