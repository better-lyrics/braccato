// A click during a glide seeks to what the canvas showed there, and only clicks that mean a line
// seek. The screenshots' colours say what is drawn under each click.
//
//   pnpm exec tsx tooling/browser/click-seek.ts

import { type Check, runCheck, STEP_S, sleep, type ViewOptions } from "./harness";

const ALT = 1;
/** The default rich-sync and line-sync timing offsets, which a seek takes off. */
const WORD_SHIFT_S = 0.15;
const LINE_SHIFT_S = 0.115;

const PALETTE = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
  [255, 128, 0],
];

interface Point {
  x: number;
  y: number;
  /** The palette's index: the line's number modulo its length, or the row of a line of words. */
  colour: number;
}

/** Colours each line, or with `words` each of a line's two rows, by its first word. */
async function paint(check: Check, words: boolean) {
  const colour = (index: number) => {
    const rgb = `rgb(${PALETTE[index]})`;
    return `{--blyrics-lyric-inactive-color:${rgb};--blyrics-lyric-active-color:${rgb}}`;
  };
  const rules = words
    ? [
        `.blyrics-word-group:first-child .blyrics--word${colour(0)}`,
        `.blyrics-word-group:not(:first-child) .blyrics--word${colour(1)}`,
      ]
    : Array.from(
        { length: 40 },
        (_, i) =>
          `.blyrics--line[data-line-number="${i}"],.blyrics--line[data-line-number="${i}"] .blyrics--word${colour(i % PALETTE.length)}`
      );
  const css =
    ".blyrics-container{--blyrics-font-size:26px;--blyrics-padding:18px;--blyrics-scale:1;" +
    `--blyrics-animate-highlight-glow:0;--blyrics-animate-word-wobble:0}${rules.join("")}`;
  await check.evaluate(`document.getElementById("theme").textContent = ${JSON.stringify(css)}`);
}

/** The first solid pixel of each coloured row on the screen. */
async function drawn(check: Check): Promise<Point[]> {
  const png = await check.screenshot();
  return check.evaluate(`(async () => {
    const image = await createImageBitmap(await (await fetch("data:image/png;base64,${png}")).blob());
    const context = new OffscreenCanvas(image.width, image.height).getContext("2d");
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    const palette = ${JSON.stringify(PALETTE)};
    const points = [];
    let previous = -1;
    for (let y = 8; y < 692; y += 2) {
      let found = null;
      for (let x = 6; x < 700 && !found; x++) {
        const at = (Math.round(y * devicePixelRatio) * image.width + Math.round(x * devicePixelRatio)) * 4;
        const colour = palette.findIndex(rgb => rgb.every((value, i) => Math.abs(value - data[at + i]) < 12));
        if (colour >= 0 && !document.elementFromPoint(x, y)?.closest("#host-content")) found = { x, y, colour };
      }
      if (found && found.colour !== previous) points.push(found);
      previous = found ? found.colour : -1;
    }
    return points;
  })()`);
}

async function click(check: Check, { x, y }: Point, modifiers = 0): Promise<number | null> {
  await check.mouse("mousePressed", x, y, modifiers);
  await check.mouse("mouseReleased", x, y, modifiers);
  await sleep(80);
  return check.evaluate<number | null>("takeSeek()");
}

const lineOf = (timeS: number) => Math.round((timeS + LINE_SHIFT_S) / STEP_S) % PALETTE.length;
/** Parts are timed word by word: the second half of a line's time is its second row. */
const rowOf = (timeS: number) => ((timeS + WORD_SHIFT_S + 0.02) % STEP_S >= STEP_S / 2 ? 1 : 0);

interface Glides {
  rounds: number;
  options: ViewOptions;
  modifiers?: number;
  seekS?: number[];
  /** Time that passes after the last frame and before the click. */
  undrawnMs?: number;
  seekedTo: (timeS: number) => number;
}

async function clickDuringGlides(check: Check, name: string, glides: Glides) {
  let wrong = 0;
  let clicks = 0;
  for (let round = 0; round < glides.rounds; round++) {
    await check.start({ ...glides.options, at: 22 + (round % 5) * 2 * STEP_S });
    if (glides.seekS) await check.evaluate(`seek(${glides.seekS[round % glides.seekS.length]})`);
    await sleep(40 + ((round * 53) % 640));
    await check.evaluate("freeze()");
    await sleep(100);
    const points = await drawn(check);
    if (points.length === 0) continue;
    const point = points[(round * 7) % points.length];
    if (glides.undrawnMs) await check.evaluate(`passUndrawn(${glides.undrawnMs})`);
    const seeked = await click(check, point, glides.modifiers);
    clicks++;
    if (seeked === null || glides.seekedTo(seeked) !== point.colour) wrong++;
  }
  check.expect(name, clicks === glides.rounds && wrong === 0, `${wrong} wrong of ${clicks}`);
}

runCheck(async check => {
  const seekS = [-3.2, -8, -16, 4.8, 9.6];

  await paint(check, false);
  await clickDuringGlides(check, "click during a glide", { rounds: 25, options: {}, seekS, seekedTo: lineOf });
  await clickDuringGlides(check, "click after the last frame was drawn", {
    rounds: 25,
    options: {},
    seekS,
    undrawnMs: 180,
    seekedTo: lineOf,
  });

  await check.start({ playing: false });
  const still = (await drawn(check))[2];
  const stillSeek = await click(check, still);
  check.expect("click with nothing gliding", stillSeek !== null && lineOf(stillSeek) === still.colour);

  await check.start({}, 1700);
  await check.evaluate("seek(-8)");
  await sleep(120);
  await check.evaluate("freeze()");
  await check.evaluate(`document.querySelector('[data-line-number="18"]').click()`);
  const keyboard = await check.evaluate<number | null>("takeSeek()");
  check.expect("click without a position", keyboard !== null && Math.round((keyboard + LINE_SHIFT_S) / STEP_S) === 18);

  await check.start({}, 1700);
  await check.evaluate("seek(-8)");
  await sleep(120);
  await check.evaluate("freeze()");
  await check.evaluate(`document.getElementById("host-content").dispatchEvent(
    new MouseEvent("click", { bubbles: true, detail: 1, clientX: 100, clientY: 300 }))`);
  check.expect("click on host content", (await check.evaluate("takeSeek()")) === null);

  await check.start({}, 1700);
  await check.evaluate("seek(-8)");
  await sleep(120);
  await check.evaluate("freeze()");
  await sleep(100);
  const rows = await drawn(check);
  const from = rows[0];
  const to = { x: from.x + 160, y: rows[rows.length - 1].y };
  await check.mouse("mousePressed", from.x, from.y);
  for (let i = 1; i <= 8; i++) await check.mouse("mouseMoved", from.x + 20 * i, from.y + ((to.y - from.y) * i) / 8);
  await check.mouse("mouseReleased", to.x, to.y);
  await sleep(80);
  check.expect("selecting text across lines", (await check.evaluate("takeSeek()")) === null);

  await check.start({ synced: false, at: 1 });
  const [unsynced] = await drawn(check);
  check.expect("click on unsynced lyrics", (await click(check, unsynced)) === null);

  await paint(check, true);
  await clickDuringGlides(check, "alt-click during a glide", {
    rounds: 20,
    options: { words: true },
    modifiers: ALT,
    seekS,
    seekedTo: rowOf,
  });
  await clickDuringGlides(check, "alt-click after the last frame was drawn", {
    rounds: 20,
    options: { words: true },
    modifiers: ALT,
    seekS,
    undrawnMs: 180,
    seekedTo: rowOf,
  });
});
