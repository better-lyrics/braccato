---
"@braccato/core": patch
---

Romanizations keep their spaces as written, so the two spaces between the words of a line stay two. The renderer drew them that way already, but measured the pill around the text as the page laid it out, with each run of spaces collapsed to one, so the end of a romanization with double spaces was cut off at the pill's edge. Other text the renderer draws untimed, such as translations, now collapses its spaces as the page does, so it is no longer cut off the same way either.
