---
"@braccato/core": patch
---

Autoscroll now pauses on a reader's first scroll, and says so, where it could miss it: when the host's scroll listener runs before the renderer's (as it does for a page's first song, and on every scroll of drifting unsynced lyrics there), and after the lyrics were laid out while playback was paused. The scroll state is also reported on every scroll again, as in 1.x, so a resume button the host hid during the pause comes back.
