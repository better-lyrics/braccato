---
"@braccato/highlight": patch
---

Keep the editor overlay's colours on the textarea's text in long, wrapped documents. A unitless `line-height` such as `1.7` is now copied as written instead of as its resolved pixel value, which Chrome rounds to a slightly different row height, so the colours no longer creep down by a fraction of a pixel per row (about 5 px by line 160 at 12px/1.7). When a page shows the textarea's scrollbar, the overlay now leaves the same space for it, so both wrap at the same width; previously every line that wrapped differently pushed the colours down another row.
