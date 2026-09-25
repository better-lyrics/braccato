// Four themes to start from, written the way a theme is written: a stylesheet, with the module's
// settings declared in comments inside it. Each one reaches for a different part of the surface, so
// reading all of them is close to reading the reference.
//
// The page hands whichever is selected to `view.theme` verbatim, so what is here is exactly what a
// consumer would ship.
//
// Sustain is the exception in one respect: it is a real published theme rather than one written for
// this page, and it is long enough that inlining it here would bury the rest. It lives beside
// this file and arrives as a string, which is the same thing the rest are.

import karaoke from "./theme-karaoke.css?raw";
import sustain from "./theme-sustain.css?raw";

export const THEMES = [
  {
    id: "default",
    title: "Default",
    summary: "White text, with a glow on words that are held.",
    css: `/* Settings go in comments. Everything else is normal CSS. */
/* blyrics-target-scroll-pos-ratio = 0.42; */

.blyrics-container {
	--blyrics-font-weight: 700;
	--blyrics-lyric-active-color: oklch(0.97 0.003 40);
	--blyrics-lyric-inactive-color: oklch(0.97 0.003 40 / 0.22);
	/* Only words held longer than blyrics-long-word-threshold glow, so this can be strong. */
	--blyrics-glow-color: oklch(0.97 0.003 40 / 0.9);
}

.blyrics-background-lyric {
	--blyrics-lyric-inactive-color: oklch(0.97 0.003 40 / 0.14);
}
`,
  },
  {
    id: "better-lyrics",
    title: "Better Lyrics",
    summary: "The look from the Better Lyrics extension: bigger text, a stretch on each word, and a glow.",
    css: `@import url("https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap");

/* blyrics-target-scroll-pos-ratio = 0.5; */

.blyrics-container {
	--blyrics-font-size: 3rem;
	--blyrics-line-height: 1.333;
	--blyrics-padding: 2rem;
	--blyrics-word-wobble-transform-from: scaleX(1);
	--blyrics-word-wobble-transform-peak: translateX(0.05em) scaleX(1.025);
	--blyrics-word-wobble-transform-settle: translateX(0) scaleX(1);
	--blyrics-word-wobble-transform-to: scaleX(1);
}

.blyrics-container .blyrics-word-highlight:not([data-long-word]) {
	--blyrics-glow-color: var(--blyrics-highlight-color, color(display-p3 1 1 1 / 0.5));
}
`,
  },
  {
    id: "sustain",
    title: "Sustain",
    summary: "Lines blur the further they are from the one being sung, and each singer gets a side.",
    css: sustain,
  },
  {
    id: "karaoke",
    title: "Karaoke",
    summary: "Only the current line shows, and words appear as they are sung.",
    css: karaoke,
  },
];
