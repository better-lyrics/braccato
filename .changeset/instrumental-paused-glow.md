---
"@braccato/core": patch
---

Keep the instrumental note, and the glow around it, in place when playback is paused. A leftover `!important` transform on `.blyrics--paused .blyrics--wave-clip` outranked the paused fill animation and dropped the fill out of view; the animation already holds its position on its own.
