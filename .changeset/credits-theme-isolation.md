---
"@braccato/core": patch
---

Keep theme rules written for the lines off the songwriter credits. The credits were a `div`, so `.blyrics-container > div` rules such as hover scaling and per-line opacity reached them too; they are a `p` now and carry their own inset and scale.
