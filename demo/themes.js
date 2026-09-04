// Three themes to start from, written the way a theme is written: a stylesheet, with the module's
// settings declared in comments inside it. Each one reaches for a different part of the surface, so
// reading all three is close to reading the reference.
//
// The page hands whichever is selected to `view.theme` verbatim, so what is here is exactly what a
// consumer would ship.
//
// Sustain is the exception in one respect: it is a real published theme rather than one written for
// this page, and it is long enough that inlining it here would bury the other two. It lives beside
// this file and arrives as a string, which is the same thing the other two are.

import sustain from "./theme-sustain.css?raw";

export const THEMES = [
  {
    id: "amber",
    title: "Amber",
    summary: "Colour, the bloom on a held word, and where the active line sits.",
    css: `/* Settings live in comments. Everything outside one is CSS the browser reads, so a
   stylesheet cannot configure the module by accident. */
/* blyrics-target-scroll-pos-ratio = 0.42; */

.blyrics-container {
	--blyrics-font-weight: 700;
	--blyrics-lyric-active-color: oklch(0.87 0.14 84);
	--blyrics-lyric-inactive-color: oklch(0.87 0.14 84 / 0.26);
	/* Only the words held past blyrics-long-word-threshold spend this, so it can afford to be
	   nearly opaque. */
	--blyrics-glow-color: oklch(0.92 0.14 84 / 0.92);
}

.blyrics-background-lyric {
	--blyrics-lyric-inactive-color: oklch(0.87 0.14 84 / 0.16);
}
`,
  },
  {
    id: "better-lyrics",
    title: "Better Lyrics",
    summary: "What the renderer ships in the extension: the scaleX pop and per-word glow, plus the wave.",
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
    summary: "Depth by distance, and lines that sit where the singer puts them.",
    css: sustain,
  },
  {
    id: "spotlight",
    title: "Spotlight",
    summary: "A hard falloff either side of the line being sung, written against the class names.",
    css: `/* Half way down, so the lit line has room above and below it rather than sitting at an
   edge. */
/* blyrics-target-scroll-pos-ratio = 0.46; */
/* Low enough that the words this song holds at the end of a line earn the bloom. */
/* blyrics-long-word-threshold = 1000; */

.blyrics-container {
	--blyrics-font-weight: 600;
	--blyrics-padding: 1rem;
	--blyrics-scale: 0.94;
	/* The sung syllable is warm and everything else is cool. That is the whole palette. */
	--blyrics-lyric-active-color: oklch(0.99 0.014 96);
	--blyrics-lyric-inactive-color: oklch(0.74 0.016 248);
	--blyrics-glow-color: oklch(0.97 0.03 96 / 0.85);
}

/* Colour cannot say how far a line is from the one being sung, because every inactive line reads
   the same variable. The structure can.

   \`blyrics--active\` leads the voice rather than tracking it, so two lines carry it through every
   handoff. Each tier has to say which lines it is not about, or the neighbour rules outrank a bare
   \`.blyrics--active\` on the line still being sung and the light goes out. */
.blyrics-container:not(.blyrics-user-scrolling) > .blyrics--line:not(.blyrics--active) {
	opacity: 0.13;
	/* Late leaving, immediate arriving: a line holds its light through the handoff rather than
	   trading it away before the voice has got there. */
	transition: opacity 420ms cubic-bezier(0.2, 0, 0, 1) 340ms;
}

.blyrics-container:not(.blyrics-user-scrolling) > .blyrics--line:not(.blyrics--active):has(+ .blyrics--active),
.blyrics-container:not(.blyrics-user-scrolling) > .blyrics--active + .blyrics--line:not(.blyrics--active) {
	opacity: 0.36;
}

.blyrics-container > .blyrics--active {
	opacity: 1;
	transition: opacity 420ms cubic-bezier(0.2, 0, 0, 1);
}

/* The answering voice sits square under the line it answers. The module already prints it at three
   quarters of the size and mixes its colour down, so the only thing left to say is that it gets a
   little air above it. An inline indent here reads as a failed attempt to centre it. */
.blyrics-background-line {
	margin-top: 0.22em;
}

/* Even while it is sung it stays behind the lead. Written through the module's own variable, so the
   mix it already applies to a background vocal still runs on top. */
.blyrics-background-lyric {
	--blyrics-lyric-active-color: oklch(0.93 0.012 96 / 0.7);
}
`,
  },
];
