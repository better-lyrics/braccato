---
"@braccato/core": patch
---

Sung letters no longer lose the parts of a glyph that hang outside their box, such as a `j`'s hook or an italic `f`. With the letter wave on, each letter's reveal mask clipped that overhang, so it showed in the unsung colour. The mask now covers the overhang without moving any letter or changing the sweep, and image highlights carry the image under it too.
