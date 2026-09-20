---
"@braccato/core": minor
---

Remove the synced autoscroll cooldown and queue. New lyric groups scroll immediately while existing additive line animations continue. Lines included by lookahead are remembered when a scroll commits and do not trigger another scroll at their own start; entering the lookahead window alone never triggers a scroll. Seeking and resuming autoscroll still retarget the viewport.

Give `blyrics-early-scroll-consider-s` an independent default of 0.54 seconds. `blyrics-queue-scroll-ms` is no longer used. `--blyrics-lyric-scroll-duration` remains an animation fallback and no longer determines scheduling or lookahead.
