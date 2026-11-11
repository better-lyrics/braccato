---
"@braccato/core": patch
---

Line scrolls run off the main thread, so they no longer stall while the page is busy. A line that is still moving when the next scroll starts carries what is left of that motion into the new scroll, and a decoration slide joins it, as one animation the browser can composite. While a line scrolls or slides, that animation replaces any `translate` a theme sets on the line itself.
