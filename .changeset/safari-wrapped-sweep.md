---
"@braccato/core": minor
---

Keep the lit text on top of the text it covers when a line wraps in Safari. WebKit moved the baseline of every clipped sweep cell, so each wrapped row of the highlight drifted lower than the row beneath it. The container now carries `data-browser-engine="webkit"` on WebKit, and `isWebKit()` joins `isGecko()` in `@braccato/core/util`.
