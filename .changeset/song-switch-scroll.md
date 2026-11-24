---
"@braccato/core": patch
---

A new song starts at its top. Before, it could scroll down and glide back when it came up: it took on the previous song's time, which `resetPlaybackClock()` and a stop at zero between songs no longer carry over, and it measured its lines where a page's slide-in transform had put them for a moment. A song put up while the view was scrolled elsewhere is now scrolled to its start at once, instead of gliding there when it plays, and unsynced lyrics drift from their top again.
