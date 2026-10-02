---
"@braccato/highlight": minor
---

The editor overlay now wraps exactly like its textarea: each layer line is one text node coloured through the CSS Custom Highlight API instead of a span per token, so edits no longer land a line away from the colours. Background vocals and comments lose their italics in the editor, and one-line documents cost more paint per keystroke.
