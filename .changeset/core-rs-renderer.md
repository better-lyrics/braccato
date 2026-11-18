---
"@braccato/core-rs": minor
---

First release of `@braccato/core-rs`, the braccato lyrics renderer rewritten in Rust and drawn with WebGL2. It shows lyrics the way `@braccato/core` does (the same wrapping, sweep, glow, wobble, letter wave, scroll glide, decorations, instrumental note, credits and stage layout) from one canvas, so a playing song costs a fraction of a millisecond of main-thread time per frame.

It has `@braccato/core`'s renderer interface: `createLyricsRenderer`, `injectTranslation`, `injectRomanization`, `resetPlaybackClock` and `resumeAllAutoscroll` take the same arguments, so a consumer can switch renderers without changing how it drives one. Call `load()` (or `loadSync()` with the wasm's bytes) first; the wasm is exported as `@braccato/core-rs/wasm`. Lyrics given with the `songKey` of the song on screen are swapped into it, keeping the lines the two share. Themes carry over through their `--blyrics-*` custom properties and comment settings; rules that style line elements directly have no effect.
