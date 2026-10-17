---
"@braccato/core": patch
---

The highlight swipe no longer jumps back mid-word on Firefox. Firefox reports media time in steps of about 40ms, and the renderer read each step as drift and reseeked the line. It now smooths that clock on Firefox only.
