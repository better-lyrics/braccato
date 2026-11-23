// A new song starts at its top: it does not take the old song's time, nor scroll to where the
// page's slide-in transform puts its lines for a moment.
//
//   pnpm exec tsx tooling/browser/song-switch.ts

import { runCheck } from "./harness";

const CASES = [
  { clear: false, slide: false, reset: false },
  { clear: false, slide: true, reset: false },
  { clear: true, slide: false, reset: false },
  { clear: true, slide: true, reset: false },
  // As Better Lyrics does it.
  { clear: true, slide: true, reset: true },
];

runCheck(async check => {
  for (const { clear, slide, reset } of CASES) {
    const name = `${reset ? "clock reset, " : ""}${clear ? "cleared, then " : ""}another song${slide ? ", slid in" : ""}`;
    // Well into the old song, so its time and scroll are far from the new song's start.
    await check.start({ at: 40 });
    const before = await check.evaluate<number>("document.getElementById('scroller').scrollTop");
    const { furthest, after } = await check.evaluate<{ furthest: number; after: number }>(
      `switchSong(${JSON.stringify({ clear, slide, reset })})`
    );
    check.expect(
      `${name}: starts at its top`,
      before > 500 && furthest <= 2,
      `scrolled ${before}, then at most ${furthest}`
    );
    check.expect(`${name}: then follows the song`, after > 500, `scrolled to ${after} at 30 s`);
  }
});
