---
"@braccato/highlight": patch
---

Keep the editor overlay on the textarea's rows while editing a scrolled document. Chrome's scroll anchoring moved the overlay up a row whenever an edit removed a row near the top of the view, but the textarea did not move, so the colours showed one or more lines above the caret and the text under the caret looked like a different line.
