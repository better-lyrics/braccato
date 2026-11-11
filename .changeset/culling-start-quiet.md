---
"@braccato/core": patch
---

Long songs no longer trigger a "ResizeObserver loop completed with undelivered notifications" error when the lyrics load, resize or swap. Skipping off-screen lines now waits for rendering with an intersection observation instead of a resize observation.
