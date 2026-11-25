---
"@braccato/core": patch
---

The scroll position is read with its fraction. Chrome keeps scroll positions on whole device pixels, so at a device pixel ratio of 1.25 or 1.5 the scroller sits at positions such as 100.8 px. The renderer read those as whole numbers, so its lines and the page's layout could disagree by up to 0.8 px. A glide planned while the canvas moved with the page could then start with a small jump.
