// A reader's scroll pauses autoscroll and says so, and nothing else does.
//
//   pnpm exec tsx tooling/browser/resume-autoscroll.ts

import { runCheck, sleep } from "./harness";

runCheck(async check => {
  async function expectPaused(name: string, paused: boolean) {
    const state = await check.evaluate<{ paused: boolean; button: boolean }>("state()");
    check.expect(name, state.paused === paused && state.button === paused, JSON.stringify(state));
  }
  async function scroll(px: number) {
    await check.evaluate(`scrollByReader(${px})`);
    await sleep(150);
  }

  for (const hostFirst of [true, false]) {
    const order = `host listener ${hostFirst ? "first" : "last"}`;

    await check.start({ hostFirst });
    await scroll(-260);
    await expectPaused(`${order}: one scroll while playing`, true);

    // Settling counts frames, and paused nothing else asks for any.
    await check.start({ hostFirst, playing: false });
    await check.evaluate("relayout()");
    await sleep(1300);
    await scroll(-260);
    await expectPaused(`${order}: one scroll while paused, after a layout`, true);

    await check.start({ hostFirst, synced: false, at: 1 });
    await sleep(800);
    for (let i = 0; i < 6; i++) await scroll(90);
    await expectPaused(`${order}: scrolling lyrics that drift`, true);

    await check.start({ hostFirst });
    await sleep(6000);
    await expectPaused(`${order}: autoscroll alone`, false);

    await check.start({ hostFirst, synced: false, at: 1, lines: 14 });
    await sleep(6000);
    await expectPaused(`${order}: drift alone`, false);

    await check.start({ hostFirst, playing: false });
    await expectPaused(`${order}: lyrics built while paused`, false);
  }

  await check.start({});
  await scroll(-260);
  await check.evaluate("hideButton()");
  await scroll(-120);
  await expectPaused("the button, hidden by the host, on the next scroll", true);

  await check.start({ playing: false }, 3000);
  const before = await check.evaluate<number>("frames_()");
  await sleep(3000);
  const drawn = (await check.evaluate<number>("frames_()")) - before;
  check.expect("paused and idle draws no frames", drawn <= 2, `${drawn} in 3 s`);
});
