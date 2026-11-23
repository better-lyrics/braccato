// What the real-browser checks of core-rs share: a headless Chrome on a page with one view, driven
// by a host that reports scrolls as Better Lyrics does, and a clock the check can stop.
//
// The checks need core-rs built (`pnpm -C packages/core-rs build`) and a Chrome (CHROME_PATH picks
// it). They take the directory of another build to check, an unpacked npm package say, as their
// only argument.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** How far apart the lines start, and how long each is, in seconds. */
export const STEP_S = 1.6;

export interface ViewOptions {
  /** Whether the host's scroll listener runs before the renderer's own (a page's first song). */
  hostFirst?: boolean;
  playing?: boolean;
  synced?: boolean;
  /** Two timed parts a line, each wide enough for a row of its own. */
  words?: boolean;
  lines?: number;
  at?: number;
}

const PAGE = `<!doctype html><meta charset="utf-8"><style id="theme"></style>
<style>html,body{margin:0;background:#000}#scroller{height:700px;width:820px;overflow:auto;overflow-anchor:none}</style>
<div id="scroller"><div id="mount"></div></div>
<script>
const realNow = performance.now.bind(performance);
const realDate = Date.now.bind(Date);
const realFrame = requestAnimationFrame.bind(window);
let frozenAt = null, lost = 0, held = null;
const now = () => (frozenAt ?? realNow()) - lost;
performance.now = now;
Date.now = () => Math.round(realDate() - realNow() + now());
window.requestAnimationFrame = callback => realFrame(() => (held ? held.push(callback) : callback(now())));
// The clock stops; frames still come, all at the same moment.
window.freeze = () => { frozenAt ??= realNow() };
// Time passes and nothing is drawn, as between two frames or while drawing is held up.
window.passUndrawn = ms => { held ??= []; lost -= ms };
window.thaw = () => {
  const waiting = held ?? [];
  held = null;
  if (frozenAt !== null) { lost += realNow() - frozenAt; frozenAt = null }
  for (const callback of waiting) callback(now());
};
</script>
<script type="module">
import * as core from "/js/renderer.js";
await core.load();
let view, ticker, scroller, button, seeks;
window.start = ({ hostFirst = false, playing = true, synced = true, words = false, lines = 40, at = 24 }) => {
  clearInterval(ticker);
  thaw();
  view?.destroy();
  document.getElementById("scroller").outerHTML = '<div id="scroller"><div id="mount"></div></div>';
  scroller = document.getElementById("scroller");
  const mount = document.getElementById("mount");
  button = false;
  seeks = [];
  view = core.createLyricsRenderer({ document, window, mount, host: {
    getScrollElement: () => scroller,
    setResumeAffordanceVisible: visible => { button = visible },
    seek: timeS => seeks.push(timeS),
  } });
  const report = () => view.noteUserScroll();
  if (hostFirst) scroller.addEventListener("scroll", report);
  const step = synced ? ${STEP_S * 1000} : 0;
  view.setLyrics(Array.from({ length: lines }, (_, i) => {
    const line = { startTimeMs: i * step, durationMs: step, words: "line number " + i + " of the song" };
    if (!words) return line;
    const first = "the first of the two rows that line " + i + " has ";
    const second = "and the second row of it that follows below";
    return { ...line, words: first + second, parts: [
      { startTimeMs: line.startTimeMs, durationMs: step / 2, words: first },
      { startTimeMs: line.startTimeMs + step / 2, durationMs: step / 2, words: second },
    ] };
  }), { mount, songKey: "check" });
  const hostContent = document.createElement("button");
  hostContent.id = "host-content";
  hostContent.textContent = "source";
  view.container.append(hostContent);
  if (!hostFirst) scroller.addEventListener("scroll", report);
  const started = now();
  const tick = () => view.tick(at + (playing ? (now() - started) / 1000 : 0),
    { isPlaying: playing, passiveScrollEnabled: true, eventCreationTime: Date.now() });
  window.seek = seconds => { at += seconds; tick() };
  tick();
  ticker = setInterval(tick, 20);
};
// Another song, as Better Lyrics puts one up: the player reads a stopped zero between songs, the
// view may be cleared first, the player clock reset, and the wrapper may slide the new lines in from
// below with a transform.
// Answers the furthest the scroll went before the new song had played two seconds, then plays on
// from playOn seconds and answers where the scroll got to.
window.switchSong = async ({ clear = false, slide = false, reset = false, playOn = 30 }) => {
  clearInterval(ticker);
  // Better Lyrics forgets the old song's time this way before it has the new song's lyrics.
  if (reset) core.resetPlaybackClock();
  const mount = document.getElementById("mount");
  const tickAt = (at, playing) => view.tick(at, { isPlaying: playing, passiveScrollEnabled: true, eventCreationTime: Date.now() });
  const zero = () => tickAt(0, false);
  zero();
  if (clear) view.clear();
  if (slide) {
    mount.style.transition = "none";
    mount.style.transform = "translateY(700px)";
  }
  view.setLyrics(Array.from({ length: 40 }, (_, i) => ({ startTimeMs: i * ${STEP_S * 1000}, durationMs: ${STEP_S * 1000},
    words: "line number " + i + " of the next song" })), { mount, songKey: "next" });
  if (slide) {
    mount.getBoundingClientRect();
    mount.style.transition = "transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)";
    mount.style.transform = "translateY(0)";
  }
  let furthest = 0, recording = true;
  const record = () => { furthest = Math.max(furthest, scroller.scrollTop); if (recording) requestAnimationFrame(record) };
  requestAnimationFrame(record);
  const wait = ms => new Promise(done => setTimeout(done, ms));
  ticker = setInterval(zero, 20);
  await wait(300);
  clearInterval(ticker);
  let started = now();
  ticker = setInterval(() => tickAt((now() - started) / 1000, true), 20);
  await wait(2000);
  recording = false;
  clearInterval(ticker);
  started = now() - playOn * 1000;
  ticker = setInterval(() => tickAt((now() - started) / 1000, true), 20);
  await wait(1500);
  return { furthest, after: scroller.scrollTop };
};
window.scrollByReader = px => { scroller.scrollTop += px };
window.hideButton = () => { button = false };
window.relayout = () => view.relayout();
window.state = () => ({ paused: view.container.classList.contains("blyrics-user-scrolling"), button });
window.frames_ = () => view.renderer.stats().frames;
window.takeSeek = () => seeks.shift() ?? null;
window.ready = true;
</script>`;

const TYPES: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm" };

export const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

function findChrome(): string {
  for (const candidate of [process.env.CHROME_PATH, "google-chrome-stable", "google-chrome", "chromium"]) {
    if (!candidate) continue;
    if (candidate.includes("/") ? existsSync(candidate) : !spawnSync(candidate, ["--version"]).error) return candidate;
  }
  throw new Error("no Chrome found; set CHROME_PATH");
}

async function openBrowser() {
  const profile = await mkdtemp(join(tmpdir(), "braccato-check-"));
  const chrome = spawn(
    findChrome(),
    [
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--enable-unsafe-swiftshader",
      "--remote-debugging-port=0",
      "--force-device-scale-factor=1.333",
      "--no-first-run",
      "--disable-extensions",
      "--window-size=900,900",
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  async function close() {
    if (chrome.exitCode === null) await new Promise(done => chrome.once("exit", done) && chrome.kill());
    await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
  for (let i = 0; i < 150; i++) {
    const address = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
    const [port, path] = address.trim().split("\n");
    if (path) return { url: `ws://127.0.0.1:${port}${path}`, close };
    await sleep(100);
  }
  await close();
  throw new Error("Chrome did not start");
}

/** The checks' hands on the page. */
export class Check {
  failed = 0;

  constructor(private call: (method: string, params?: object) => Promise<any>) {}

  async evaluate<T>(expression: string): Promise<T> {
    const { result, exceptionDetails } = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value as T;
  }

  async start(options: ViewOptions, settleMs = 1700) {
    await this.evaluate(`start(${JSON.stringify(options)})`);
    await sleep(settleMs);
  }

  async screenshot(): Promise<string> {
    return (await this.call("Page.captureScreenshot", { format: "png" })).data;
  }

  async mouse(type: "mousePressed" | "mouseReleased" | "mouseMoved", x: number, y: number, modifiers = 0) {
    await this.call("Input.dispatchMouseEvent", { type, x, y, modifiers, button: "left", buttons: 1, clickCount: 1 });
  }

  expect(name: string, ok: boolean, detail = "") {
    if (!ok) this.failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name} ${detail}`);
  }
}

/** Runs `body` against a fresh browser and sets the exit code from what it expected. */
export async function runCheck(body: (check: Check) => Promise<void>): Promise<void> {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../../packages/core-rs", import.meta.url)));
  if (!existsSync(join(root, "pkg/braccato_core_rs_bg.wasm"))) throw new Error(`no core-rs build in ${root}`);
  const server = createServer(async (request, response) => {
    const path = normalize(new URL(request.url ?? "/", "http://localhost").pathname);
    if (path === "/") return response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    const file = /^\/(js|pkg)\//.test(path) ? await readFile(join(root, path)).catch(() => null) : null;
    if (!file) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": TYPES[extname(path)] ?? "text/plain" }).end(file);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const browser = await openBrowser();
  const socket = new WebSocket(browser.url);
  try {
    await new Promise(done => socket.addEventListener("open", done, { once: true }));
    const pending = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting?.fail(new Error(message.error.message));
      else waiting?.done(message.result);
    });
    let id = 0;
    let sessionId: string | undefined;
    const call = (method: string, params: object = {}) =>
      new Promise<any>((done, fail) => {
        pending.set(++id, { done, fail });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });

    const { targetInfos } = await call("Target.getTargets");
    const targetId = targetInfos.find((target: { type: string }) => target.type === "page").targetId;
    sessionId = (await call("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    await call("Page.enable");
    await call("Page.navigate", { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` });

    const check = new Check(call);
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      await sleep(100);
      ready = await check.evaluate<boolean>("window.ready === true").catch(() => false);
    }
    if (!ready) throw new Error("the check's page did not load");
    await body(check);
    console.log(`failed: ${check.failed}`);
    if (check.failed > 0) process.exitCode = 1;
  } finally {
    socket.close();
    server.closeAllConnections();
    server.close();
    await browser.close();
  }
}
