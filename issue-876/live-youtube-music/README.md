# Live YouTube Music evidence for issue 876

These are unedited browser screenshots of Better Lyrics running on live YouTube Music, captured on 2026-09-20. Lyrics, romanization, and translations were loaded through the extension's normal provider and translation flows.

Song: [Lemon — Kenshi Yonezu](https://music.youtube.com/watch?v=3NNhrqHZqlI), paused around 0:14. The UI language is English; the translation target is Traditional Chinese (`zh-TW`). Romanization is enabled. This song has line-level romanization, not timed transliterations.

| Capture | Better Lyrics | Core | Original | Translation | Romanization |
| --- | --- | --- | --- | --- | --- |
| Before | `2330e50c` | published `1.7.0` | Noto Sans HK, inherits `en` | Noto Sans HK, inherits `en` | Satoshi, inherits `en` |
| After | `cc97e1ab4274863ff9c74b07dfd6afc9ec156c12` | published `1.8.0` | Noto Sans JP, `ja` | Noto Sans TC, `zh-TW` | Satoshi, `ja-Latn` |
| Actual floating window, after | same after build | published `1.8.0` | Noto Sans JP, `ja` | Noto Sans TC, `zh-TW` | Satoshi, `ja-Latn` |

- `youtube-music-before.png` and `youtube-music-after.png`: live main-window comparison, same 1618 × 862 CSS-pixel viewport and device scale 1.25.
- `youtube-music-pip-after.png`: the actual Document Picture-in-Picture window opened with the extension's control; 720 × 244 CSS pixels. Its evidence records the YouTube Music opener and verifies `opener.documentPictureInPicture.window === window`.
- Matching JSON files record the source commits, browser version, playback position, element visibility, language attributes, and actual rendered fonts from `CSS.getPlatformFontsForNode`. All nine font/language assertions passed before screenshots were written.

Chrome reports the CJK variable fonts with internal family names ending in `Thin`; these are its rendered-font identifiers, not a claim that the text uses a thin CSS weight.

## Reproduce

1. Check out the before/after revisions into separate worktrees and run `npm ci` in each.
2. Run `npm run start` in each profile once. The extension automatically completes its normal Turnstile flow and saves its API token.
3. Close that production-mode browser, then run `npm run dev`, which reuses the persistent profile. The sessions used local CDP ports 9223 (before) and 9222 (after).
4. Enable translation to Traditional Chinese and romanization. Open the song link above, select Lyrics, and pause around 0:14 after the lyrics and decorations load. Collapse the navigation sidebar and use matching window dimensions.
5. Use `capture-cdp.mjs` with the `record` action. It checks actual fonts, language tags, and viewport visibility before capturing a raw screenshot. Use the three sample selectors and expected font/language values in the matching JSON evidence. Pass `port`, `path`, `commit`, `core`, and `samples` as JSON on standard input. Each sample expects `selector`, `font` (family substring), and `language`.
6. Open the extension's Picture-in-Picture control, identify that page with the `targets` action, and capture it using `id`. If the development debugger pauses the newly created target, resume it with `Runtime.runIfWaitingForDebugger` before capture.

No API tokens, browser storage, account credentials, or provider payloads are included in this evidence directory.
