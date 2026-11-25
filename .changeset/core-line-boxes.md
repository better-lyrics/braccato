---
"@braccato/core": minor
---

Themes can draw boxes behind lines and change text shadows with a line's state:

- `--blyrics-line-bg-color` fills a box behind a line, and `--blyrics-line-border-color` with `--blyrics-line-border-width` (1px) draws a border inside its edge. The box covers the line's whole box, padding included, with the line's own `border-radius`, where the DOM renderer painted a line's `background`. It is set per line, so a selector such as `[data-layout="stage"] > .blyrics--line` scopes it. `--blyrics-line-hover-bg-color` and `--blyrics-line-hover-border-color` are what the hovered line's box eases to, alongside the other hover properties.
- `--blyrics-active-text-shadow` is the text shadow while a line is being sung, easing in and out with the line's scale transition, and `--blyrics-line-hover-text-shadow` the one while it is hovered. Like `--blyrics-text-shadow`, each is drawn once with the line, and changing between them only fades one into the other.
- `linear()` easings continue their first and last segments before the first stop and after the last, as CSS does, instead of holding there, as Chrome does. A hover easing settles on the hover look once it is done, whatever the curve's last value.
- A colour property set to something that is not a colour now counts as unset instead of transparent.
