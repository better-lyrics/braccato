---
"@braccato/core": patch
---

The letter wave glides on Firefox instead of stepping a whole pixel at a time. The container now carries `data-browser-engine="gecko"` on Firefox, and `isGecko()` in `@braccato/core/util` answers the same question for script.
