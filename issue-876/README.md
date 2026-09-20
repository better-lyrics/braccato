# Issue 876 visual evidence

Captured in headless Chrome using the actual Braccato renderer modules and Better Lyrics font styles. These are controlled browser fixtures, not live YouTube Music screenshots.

- Before: published `@braccato/core@1.7.0`, Better Lyrics commit `2330e50c`.
- After: Braccato commit `50822b792716ba156bf167d5d1df91f0391f4128`, Better Lyrics commit `2a8aaeb19faa325db46b63fc66743194e12dfd91`.
- `regional-glyphs-before-after.png`: identical Unicode text rendered for five language/region settings.
- `source-translation-documents.png`: a Japanese original, Latin romanization, and Traditional Chinese translation; the fixed version renders in two independent iframe documents with different UI languages.
- `rendered-fonts.json`: 16 font selections checked using Chrome DevTools Protocol `CSS.getPlatformFontsForNode`. Captions are populated from these results, not from expected CSS declarations.

The fixture changes spacing, colors, animation, and viewport presentation for a readable comparison. It does not override the renderer's font families or language attributes. The actual before/after renderer APIs set the language attributes.

## Reproduce

Create a local directory containing the HTML files with these paths:

- `before-core/`: published core 1.7.0 `dist/`.
- `after-core/`: built `packages/core/dist/` from the Braccato commit above.
- `public/`: Better Lyrics `public/` from the after commit.
- `before-misc.css`: `public/css/blyrics/misc.css` from the before commit.

Serve it on `127.0.0.1:8876`, start Chrome with remote debugging port `9336`, and run `capture.mjs`. The script writes files to `/tmp/blyrics-876-evidence/`. Google Fonts access is required. The comparisons assert the actual rendered font for every sample before saving a screenshot.
