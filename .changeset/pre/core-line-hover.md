---
"@braccato/core": minor
---

Themes can give the line under the mouse its own look, as `:hover` rules did with the DOM renderer: `--blyrics-line-hover-opacity`, `--blyrics-line-hover-blur` and `--blyrics-line-hover-scale` replace the line's distance opacity, distance blur and scale while the pointer is on it, eased over `--blyrics-line-hover-duration` (0.2s) with `--blyrics-line-hover-easing` (`ease`). A value the theme leaves unset keeps the line as it is, so existing themes look the same. Touch input does not hover.
