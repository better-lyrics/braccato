// `<braccato-lyrics>` can be its own scroller, as 1.x's element could: the canvas draws the lines
// where its scroll puts them. And what a page writes before the element is defined reaches it.
//
//   pnpm exec tsx tooling/browser/self-scroll.ts

import { type Check, runCheck, STEP_S } from "./harness";

const AT_S = 38;
const LINE = Math.floor(AT_S / STEP_S);

/** Line LINE drawn red, every other line blue. */
const THEME =
  ".blyrics-container{--blyrics-font-size:26px;--blyrics-scale:1;--blyrics-active-scale:1;" +
  "--blyrics-lyric-inactive-color:rgb(0,0,255);--blyrics-lyric-active-color:rgb(0,0,255);" +
  "--blyrics-animate-highlight-glow:0;--blyrics-animate-word-wobble:0}" +
  `.blyrics--line[data-line-number="${LINE}"],.blyrics--line[data-line-number="${LINE}"] .blyrics--word` +
  "{--blyrics-lyric-inactive-color:rgb(255,0,0);--blyrics-lyric-active-color:rgb(255,0,0)}";

/** The first and last screen rows, in CSS pixels, with red drawn in them. */
async function red(check: Check): Promise<{ top: number; bottom: number } | null> {
  const png = await check.screenshot();
  return check.evaluate(`(async () => {
    const image = await createImageBitmap(await (await fetch("data:image/png;base64,${png}")).blob());
    const context = new OffscreenCanvas(image.width, image.height).getContext("2d");
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    let top = null, bottom = null;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const at = (y * image.width + x) * 4;
        if (data[at] > 200 && data[at + 1] < 60 && data[at + 2] < 60) {
          top ??= y;
          bottom = y;
          break;
        }
      }
    }
    return top === null ? null : { top: top / devicePixelRatio, bottom: (bottom + 1) / devicePixelRatio };
  })()`);
}

runCheck(async check => {
  await check.evaluate(`document.getElementById("theme").textContent = ${JSON.stringify(THEME)}`);
  for (const early of [false, true]) {
    const name = early ? "written before the element is defined" : "set on the defined element";
    const box = await check.evaluate<{ scrolled: number; top: number | null; bottom: number | null }>(
      `selfScrolling(${JSON.stringify({ seconds: AT_S, line: LINE, early })})`
    );
    check.expect(`${name}: scrolls itself to the time`, box.scrolled > 500, `scrolled to ${box.scrolled}`);
    const { top, bottom } = box;
    if (top === null || bottom === null) {
      check.expect(`${name}: builds its lines`, false);
      continue;
    }
    const drawn = await red(check);
    check.expect(
      `${name}: draws the line where its box is`,
      drawn !== null && drawn.top >= top - 2 && drawn.bottom <= bottom + 2,
      `box ${top.toFixed(1)}–${bottom.toFixed(1)}, drawn ${drawn ? `${drawn.top.toFixed(1)}–${drawn.bottom.toFixed(1)}` : "nowhere"}`
    );
  }
});
