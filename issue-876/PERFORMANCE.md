# Selector and language-update profiling

This is a controlled headless Chrome stress fixture, not a live YouTube Music performance trace or an end-to-end frame measurement.

The fixture builds 150 rich-synced lyric lines through the real Braccato renderer: 11,561 elements, with lyric culling disabled for the test. It uses the actual core and extension CSS. Each measured operation forces style resolution. Variants run in rotating order over nine repetitions; the values below are medians from DevTools Protocol `Performance.getMetrics` (`RecalcStyleDuration`).

`current` keeps the PR's `:where(.blyrics--line, .blyrics--translated, .blyrics--romanized)` selectors. `expanded` replaces each group with three ordinary class selectors for comparison (which also raises specificity). `disabled` removes just the regional font rules as a diagnostic baseline; it does not preserve the correct glyph selection.

| Workload | Current :where | Expanded selectors | Regional rules removed |
| --- | ---: | ---: | ---: |
| 400 word-state + line-class updates | 7.95 ms | 7.88 ms | 7.47 ms |
| 400 translation-node replacements | 20.71 ms | 20.75 ms | 19.92 ms |
| 40 identical language updates, after guard | 0 ms | 0 ms | 0 ms |

The first run before the guard measured 7.97 vs 9.00 ms for word updates and 20.61 vs 20.22 ms for translation replacements. This comparison does not show a repeatable practical benefit from expanding the grouped selector.

The first run did find a larger issue: repeating `setLanguage('ja')` unnecessarily rewrote every lyric's `lang` attribute and called `measure()`. Forty identical updates spent a median 770.42 ms in style recalculation (~19.26 ms per update) in this stress fixture. Commit `551be4e` caches the normalized source language, so duplicate/canonical-equivalent updates return without DOM writes or measurement. The repeated-language scenario then recorded zero style recalculations. Genuine language changes still update the view.

Source-language publication occurs on content/settings changes rather than every playback tick. Word-state mutations remain independent of the source-language setter. Keeping :where also preserves the intended low specificity for theme overrides.

Files:

- `perf.html`: renderer and CSS workload.
- `profile.mjs`: CDP metric collection and rotating comparison.
- `selector-performance-before-guard.json`: raw first-run samples, Braccato `50822b7`.
- `selector-performance.json`: raw post-guard samples, Braccato `551be4e`.

Serve this directory on `127.0.0.1:8876` using the asset mappings described in `README.md`, start Chrome on debugging port `9336`, and run `profile.mjs`. These are local measurements in Chrome; Firefox and other devices were not profiled.
