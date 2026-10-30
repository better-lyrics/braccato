---
"@braccato/core": minor
---

Lyrics given to a view that already shows a song are swapped into it instead of rebuilding it. Lines that did not change keep their elements, animations and decorations, and only the changed lines are built again. The scroll and a reader's manual scroll carry over. When lines above the followed line change height, that line holds still and the others slide into place, so a source upgrade or a live edit only shows what changed in the lyrics. Writing an empty array first still rebuilds from nothing. `injectTranslation` and `injectRomanization` now replace a different existing decoration instead of keeping the first one. A timed romanization hung on the line being sung now highlights straight away instead of waiting for the line to come round again.
