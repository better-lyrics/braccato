# Visual evidence for Braccato PR #29

Related issue: https://github.com/better-lyrics/better-lyrics/issues/875

These are unedited Playwright screenshots of the live Braccato renderer, using
`createLyricsRenderer`, `injectRomanization`, and `injectTranslation`. Each browser
renders the same synthetic lyric fixture in 600px and 280px views, paused at 6.0s.
The left side uses the stylesheet at `2a3ce9c`; the right side uses `f01f88c`.
The JavaScript renderer is identical in those commits. Shared theme settings
disable scrolling, scaling, wobble, glow, and decoration entry for stable captures;
the renderer itself controls highlight visibility and animation progress.

- [Firefox before and after](firefox-before-after.png): zero-width highlights and
  overlapping words before; correctly aligned highlights and normal wrapping after.
- [Chromium before and after](chromium-before-after.png): highlights remain aligned.
- [Measured geometry](measurements.json): widths, heights, maximum word-position
  differences, and visible highlight counts from the captured DOM.
- [Capture script](capture.mjs): asserts the Firefox failure before the fix and
  word alignment after the fix in both browsers before saving screenshots.

To reproduce, build a separate Braccato checkout at `f01f88c` with
`pnpm install --frozen-lockfile` and `pnpm build:packages`. Put `capture.mjs` in
a separate directory, then run the following with Playwright 1.63.0 (Firefox
155.0 and Chromium 153.0.8010.12 used for the attached captures):

```sh
npm install playwright@1.63.0
npx playwright install firefox chromium --only-shell
BRACCATO_REPO=/absolute/path/to/braccato node capture.mjs
```

Screenshots and measurements are written to `screenshots/` beside the script.

Captured by Astra, working on behalf of @adaliea.
