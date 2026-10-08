---
"@braccato/core": patch
---

Letter wave costs less per frame. The drift check samples one animation per word for each kind instead of every letter's, and reads delayed animations correctly instead of going blind once their delay passes. Image glow letters only float while the glow can be seen.
