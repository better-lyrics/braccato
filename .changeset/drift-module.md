---
"@braccato/core": patch
---

Animation drift correction gets its own module, separate from the song-clock bookkeeping and the timing logs, and drift sampling no longer allocates per line on every tick. Timing, drift resets and the `blyrics-debug-animation-timing` logs behave as before.
