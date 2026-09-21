---
"@braccato/core": minor
---

Remove the synced autoscroll cooldown and queue. New lyric groups scroll immediately while existing additive line animations continue. Lines included by lookahead are remembered when a scroll commits and do not trigger another scroll at their own start; entering the lookahead window alone never triggers a scroll. Seeking and resuming autoscroll still retarget the viewport.

Give `blyrics-early-scroll-consider-s` an independent default of 0.54 seconds. `blyrics-queue-scroll-ms` is no longer used. Remove `--blyrics-lyric-scroll-duration`, its `--blyrics-lyric-transition-duration` alias and the obsolete container transform transition. Set visual duration with the line-scroll duration knobs; invalid or nonpositive durations use an internal 750ms fallback. Themes that explicitly reference the removed variables must replace those references with a duration or their own custom property.
