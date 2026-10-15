---
"@braccato/parsers": minor
---

LRC and enhanced LRC now get instrumental lines on the same terms as TTML. Blank and music-note lines no longer render as empty rows: they end the line before them, and a silence longer than `instrumentalGapMs` (now an option on `parseLRC`) becomes an instrumental, including the intro and the outro. A closing word timestamp in enhanced LRC ends the line there instead of opening an empty part.
