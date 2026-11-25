---
"@braccato/core": patch
---

Scrolls start smoothly again:

- A line that comes within a screen of the view as a scroll starts is no longer drawn on that same frame, which could take 8 to 15 ms and drop frames just as the lines began to glide. Drawing a line is also much quicker, because its canvas is now kept in memory, where Chrome copies it to the GPU in well under a millisecond.
- The sung line no longer rises by a pixel just before the others start to move. Lines at rest still sit on whole device pixels, but each glide now starts exactly where its line was drawn and ends on a whole pixel. A line is no longer pulled to the nearest pixel while it moves.
