// Benchmarks the renderers on the demo's compare page, in a real Chrome, and optionally profiles them.
//
//   pnpm bench                                   the default scenarios, Rust renderer, 3 runs each
//   pnpm bench --renderers rs,dom                both renderers, for a comparison
//   pnpm bench --scenarios kettle:sustain --runs 5 --seconds 20
//   pnpm bench --save before.json                then, after a change:
//   pnpm bench --baseline before.json            which prints each number's change and whether it is noise
//   pnpm bench --profile                         adds one CPU-profiled run per scenario (see below)
//
// A scenario is `song[:theme[:layout]]`: a song id from demo/song.js, a theme from demo/themes.js
// (default `default`), and `scroll` or `stage` (default `scroll`). `song*N` plays the song's lines N
// times over, one copy after another (the audio plays once): every built-in song fits a few screens,
// so its lines are all drawn before it plays, and only a longer one draws lines while it scrolls.
//
// Each run loads `compare.html` with only that renderer, plays the song muted from `--start` and
// throws away the first `--warmup` seconds, then measures for `--seconds`:
//
// - The Rust renderer's own profile (`Renderer.takeProfile()`): every frame's CPU time, split into
//   phases (see packages/core-rs/src/profile.rs), and GPU time where the browser can time it.
// - The page's main thread: busy, script, layout and style milliseconds per second of playback, from
//   Chrome's own counters. This is the number to compare the two renderers by, since the DOM
//   renderer's cost is mostly style and layout rather than script.
// - CPU time of Chrome's renderer and GPU processes, per second, which includes compositing.
//
// Runs interleave scenarios and renderers, so a slow stretch of the machine spreads across all of
// them. Each number is the median over runs, with the range beside it: a change smaller than the
// range is noise.
//
// `--profile` profiles the main thread with Chrome's sampling profiler, in a run of its own (the
// profiler slows what it samples, so profiled runs are left out of the timings). It writes a
// `.cpuprofile` per scenario to `--out`, which Chrome DevTools' Performance panel opens, and prints the
// functions with the most time. Rust functions are named only in a profiling build:
// `pnpm -C packages/core-rs build:profiling`, which is optimized like a release.
//
// The script starts its own dev server in `bench` mode, which isolates the page so `performance.now()`
// has microsecond resolution, and its own Chrome, with a fresh profile and a window on the screen: a
// headless Chrome draws with a software GPU, which says nothing about real GPU cost. `--headless` is
// there for a machine without a display. CHROME_PATH picks the browser.
//
// Needs core built (`pnpm build`) and core-rs built.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO = join(ROOT, "demo");
const WASM = join(ROOT, "packages/core-rs/pkg/braccato_core_rs_bg.wasm");

const { values: args } = parseArgs({
  options: {
    scenarios: {
      type: "string",
      default: "kettle:default,kettle:sustain,the-steps:default,kettle*4:default,kettle:default:stage",
    },
    renderers: { type: "string", default: "rs" },
    timing: { type: "string", default: "syllables" },
    runs: { type: "string", default: "3" },
    seconds: { type: "string", default: "15" },
    warmup: { type: "string", default: "3" },
    start: { type: "string", default: "0" },
    window: { type: "string", default: "1280x960" },
    profile: { type: "boolean", default: false },
    out: { type: "string", default: join(ROOT, ".bench") },
    save: { type: "string" },
    baseline: { type: "string" },
    url: { type: "string" },
    headless: { type: "boolean", default: false },
    "chrome-flag": { type: "string", multiple: true, default: [] },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  console.log(
    source
      .split("\n")
      .filter(line => line.startsWith("//"))
      .map(line => line.slice(3))
      .join("\n")
  );
  process.exit(0);
}

const RUNS = Number(args.runs);
const SECONDS = Number(args.seconds);
const WARMUP = Number(args.warmup);
const START = Number(args.start);
const [WIDTH, HEIGHT] = args.window.split("x").map(Number);
const RENDERERS = args.renderers.split(",").map(r => r.trim()) as Renderer[];
const SCENARIOS = args.scenarios.split(",").map(parseScenario);

type Renderer = "rs" | "dom";
interface Scenario {
  song: string;
  repeat: number;
  theme: string;
  layout: "scroll" | "stage";
}

function parseScenario(text: string): Scenario {
  const [named, theme = "default", layout = "scroll"] = text.trim().split(":");
  if (layout !== "scroll" && layout !== "stage") throw new Error(`${text}: layout is scroll or stage`);
  const [song, times = "1"] = named.split("*");
  const repeat = Number(times);
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error(`${text}: song*N repeats a song N times, N 1 or more`);
  return { song, repeat, theme, layout };
}

const label = (s: Scenario, r: Renderer) =>
  `${s.song}${s.repeat > 1 ? `*${s.repeat}` : ""}:${s.theme}:${s.layout}:${r}`;

// -- Chrome DevTools Protocol ------------------------------------------------

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

class Cdp {
  #id = 0;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as Message;
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new Cdp(ws);
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.#id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  close() {
    this.ws.close();
  }
}

class Page {
  constructor(
    private cdp: Cdp,
    private session: string
  ) {}

  send(method: string, params: object = {}) {
    return this.cdp.send(method, params, this.session);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value as T;
  }
}

// -- Processes -----------------------------------------------------------------

const children: ChildProcess[] = [];
const temporary: string[] = [];

async function cleanUp() {
  for (const child of children) {
    try {
      // Detached, so the group goes: pnpm and the vite it started.
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  for (const dir of temporary) await rm(dir, { recursive: true, force: true }).catch(() => {});
}

process.on("SIGINT", () => cleanUp().then(() => process.exit(130)));

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor<T>(what: string, check: () => Promise<T | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function startDevServer(): Promise<string> {
  const audio = spawnSync("pnpm", ["-C", DEMO, "run", "audio"], { stdio: "inherit" });
  if (audio.status !== 0) throw new Error("generating the demo's audio failed");
  const port = await freePort();
  const server = spawn(
    "pnpm",
    ["-C", DEMO, "exec", "vite", "--mode", "bench", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { detached: true, stdio: "ignore" }
  );
  children.push(server);
  const url = `http://127.0.0.1:${port}`;
  await waitFor("the dev server", async () => (await fetch(`${url}/compare.html`)).ok);
  return url;
}

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return candidate;
    } else if (!spawnSync(candidate, ["--version"], { stdio: "ignore" }).error) {
      return candidate;
    }
  }
  throw new Error("no Chrome found; set CHROME_PATH");
}

async function startChrome(): Promise<{ cdp: Cdp; page: Page }> {
  const profile = await mkdtemp(join(tmpdir(), "braccato-bench-"));
  temporary.push(profile);
  const chrome = spawn(
    findChrome(),
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      // Keep frames coming when the window is covered or not focused.
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--autoplay-policy=no-user-gesture-required",
      `--window-size=${WIDTH},${HEIGHT}`,
      // The same screen every time: its refresh rate and pixel ratio change every number.
      "--window-position=0,0",
      ...(args.headless ? ["--headless=new"] : []),
      ...args["chrome-flag"],
      "about:blank",
    ],
    { detached: true, stdio: "ignore" }
  );
  children.push(chrome);
  const portFile = join(profile, "DevToolsActivePort");
  const [port, path] = await waitFor("Chrome", async () => {
    const text = await readFile(portFile, "utf8");
    const lines = text.trim().split("\n");
    return lines.length === 2 ? lines : undefined;
  });
  const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const target = targetInfos.find((t: { type: string }) => t.type === "page");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const page = new Page(cdp, sessionId);
  await page.send("Page.enable");
  await page.send("Performance.enable");
  return { cdp, page };
}

// -- Measuring -------------------------------------------------------------------

interface Counters {
  at: number;
  metrics: Record<string, number>;
  processes: Record<string, number>;
}

async function counters(cdp: Cdp, page: Page): Promise<Counters> {
  const [{ metrics }, { processInfo }] = await Promise.all([
    page.send("Performance.getMetrics"),
    cdp.send("SystemInfo.getProcessInfo"),
  ]);
  const processes: Record<string, number> = {};
  for (const p of processInfo as { type: string; cpuTime: number }[]) {
    processes[p.type] = (processes[p.type] ?? 0) + p.cpuTime;
  }
  return {
    at: performance.now(),
    metrics: Object.fromEntries((metrics as { name: string; value: number }[]).map(m => [m.name, m.value])),
    processes,
  };
}

interface PageProfile {
  fields: string[] | null;
  frames: number[] | null;
  gpu: number[] | null;
  quads: number | null;
  canvas: string | null;
  songTime: number;
  ended: boolean;
}

interface Setup {
  duration: number;
  isolated: boolean;
  viewport: string;
}

type Numbers = Record<string, number>;

interface RunResult {
  label: string;
  run: number;
  setup: Setup;
  numbers: Numbers;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

class Reloaded extends Error {}

/** Measures once, again if the page reloaded under the measurement. */
async function measureSettled(...params: Parameters<typeof measure>): ReturnType<typeof measure> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await measure(...params);
    } catch (error) {
      if (!(error instanceof Reloaded) || attempt === 2) throw error;
    }
  }
}

async function measure(
  cdp: Cdp,
  page: Page,
  scenario: Scenario,
  renderer: Renderer,
  base: string,
  profileTo?: string
): Promise<{ setup: Setup; numbers: Numbers }> {
  const query = new URLSearchParams({
    song: scenario.song,
    repeat: String(scenario.repeat),
    theme: scenario.theme,
    layout: scenario.layout,
    timing: args.timing,
    mode: renderer,
    t: String(START),
    bench: "",
  });
  await page.send("Page.navigate", { url: `${base}/compare.html?${query}` });
  const view = renderer === "rs" ? "rsView" : "domView";
  // A profiled run leaves the renderer's own timers off, so the profile shows only the renderer.
  const timed = renderer === "rs" && !profileTo;
  await waitFor(
    "the renderer",
    () => page.evaluate<boolean>(`!!window.compare?.${view}?.renderer && window.compare.player.readyState >= 1`),
    60_000
  );
  const setup = await page.evaluate<Setup>(`(async () => {
		await document.fonts.ready;
		const { player, rsView } = window.compare;
		${timed ? "rsView.renderer.setProfiling(true);" : ""}
		// Gone if the page reloads mid-run, as the dev server does when it finds a dependency.
		window.benchRun = true;
		player.muted = true;
		player.currentTime = ${START};
		await player.play();
		return { duration: player.duration, isolated: crossOriginIsolated, viewport: innerWidth + "x" + innerHeight + "@" + devicePixelRatio };
	})()`);
  if (START + WARMUP + SECONDS > setup.duration) {
    throw new Error(
      `${label(scenario, renderer)}: the song is ${setup.duration.toFixed(1)} s long, shorter than --start + --warmup + --seconds`
    );
  }
  await sleep(WARMUP * 1000);
  if (timed) await page.evaluate("void window.compare.rsView.renderer.takeProfile()");
  if (profileTo) {
    await page.send("Profiler.enable");
    await page.send("Profiler.setSamplingInterval", { interval: 100 });
    await page.send("Profiler.start");
  }
  const before = await counters(cdp, page);
  await sleep(SECONDS * 1000);
  const after = await counters(cdp, page);
  const cpuProfile = profileTo ? (await page.send("Profiler.stop")).profile : undefined;
  const result = await page.evaluate<PageProfile | null>(`(() => {
		const { player, rsView } = window.compare;
		const renderer = ${renderer === "rs"} ? rsView.renderer : null;
		const profile = ${timed} ? renderer.takeProfile() : null;
		const stats = renderer?.stats();
		const canvas = renderer ? rsView.querySelector("canvas") : null;
		if (!window.benchRun) return null;
		player.pause();
		return {
			fields: profile?.fields ?? null,
			frames: profile ? Array.from(profile.frames) : null,
			gpu: profile ? Array.from(profile.gpu) : null,
			quads: stats?.quads ?? null,
			canvas: canvas ? canvas.width + "x" + canvas.height : null,
			songTime: player.currentTime,
			ended: player.ended,
		};
	})()`);
  if (!result) throw new Reloaded();
  if (result.ended) throw new Error(`${label(scenario, renderer)}: the song ended during the measurement`);
  if (cpuProfile && profileTo) await writeFile(profileTo, JSON.stringify(cpuProfile));

  const seconds = (after.at - before.at) / 1000;
  const perSecond = (from: Record<string, number>, to: Record<string, number>, key: string) =>
    (((to[key] ?? 0) - (from[key] ?? 0)) * 1000) / seconds;
  const numbers: Numbers = {
    "main busy": perSecond(before.metrics, after.metrics, "TaskDuration"),
    "main script": perSecond(before.metrics, after.metrics, "ScriptDuration"),
    "main layout": perSecond(before.metrics, after.metrics, "LayoutDuration"),
    "main style": perSecond(before.metrics, after.metrics, "RecalcStyleDuration"),
    "process renderer": perSecond(before.processes, after.processes, "renderer"),
    "process gpu": perSecond(before.processes, after.processes, "GPU"),
    "process browser": perSecond(before.processes, after.processes, "browser"),
  };
  if (result.fields && result.frames) {
    const width = result.fields.length;
    const count = result.frames.length / width;
    const column = (index: number) => Array.from({ length: count }, (_, row) => result.frames![row * width + index]);
    const total = column(0).sort((a, b) => a - b);
    numbers.fps = count / seconds;
    numbers["frame mean"] = mean(total);
    numbers["frame p50"] = percentile(total, 0.5);
    numbers["frame p95"] = percentile(total, 0.95);
    numbers["frame p99"] = percentile(total, 0.99);
    numbers["frame max"] = total[total.length - 1];
    for (let index = 1; index < width; index++) numbers[`phase ${result.fields[index]}`] = mean(column(index));
    if (result.gpu && result.gpu.length > 0) {
      const gpu = [...result.gpu].sort((a, b) => a - b);
      numbers["gpu mean"] = mean(gpu);
      numbers["gpu p95"] = percentile(gpu, 0.95);
    }
    if (result.quads !== null) numbers.quads = result.quads;
  }
  return {
    setup: { ...setup, viewport: `${setup.viewport}${result.canvas ? `, canvas ${result.canvas}` : ""}` },
    numbers,
  };
}

// -- Reporting -------------------------------------------------------------------

const UNITS: [RegExp, string][] = [
  [/^(frame|phase|gpu) /, "ms/frame"],
  [/^(main|process) /, "ms/s"],
  [/^fps$/, "Hz"],
  [/^quads$/, ""],
];

const unit = (key: string) => UNITS.find(([pattern]) => pattern.test(key))?.[1] ?? "";

interface Summary {
  median: number;
  min: number;
  max: number;
}

type Report = Record<string, { setup: Setup; runs: number; numbers: Record<string, Summary> }>;

function summarize(results: RunResult[]): Report {
  const report: Report = {};
  for (const name of new Set(results.map(r => r.label))) {
    const runs = results.filter(r => r.label === name);
    const numbers: Record<string, Summary> = {};
    for (const key of Object.keys(runs[0].numbers)) {
      const values = runs.map(r => r.numbers[key]).sort((a, b) => a - b);
      numbers[key] = { median: values[values.length >> 1], min: values[0], max: values[values.length - 1] };
    }
    report[name] = { setup: runs[0].setup, runs: runs.length, numbers };
  }
  return report;
}

const fmt = (value: number) =>
  !Number.isFinite(value)
    ? "-"
    : Math.abs(value) >= 100
      ? value.toFixed(0)
      : Math.abs(value) >= 10
        ? value.toFixed(1)
        : value.toFixed(3);

function printReport(report: Report, baseline?: Report) {
  for (const [name, entry] of Object.entries(report)) {
    console.log(`\n${name}  (${entry.runs} runs, ${entry.setup.viewport})`);
    const before = baseline?.[name]?.setup.viewport;
    if (before && before !== entry.setup.viewport) {
      console.log(`  ! the baseline ran at ${before}: per-second and GPU numbers do not compare`);
    }
    const rows: string[][] = [["", "median", "range", "unit", ...(baseline ? ["baseline", "change"] : [])]];
    for (const [key, { median, min, max }] of Object.entries(entry.numbers)) {
      const row = [key, fmt(median), `${fmt(min)}–${fmt(max)}`, unit(key)];
      const before = baseline?.[name]?.numbers[key];
      if (baseline) {
        if (!before) row.push("-", "-");
        else {
          const change = (median - before.median) / before.median;
          // Within the wider of the two ranges, it could be either run's noise.
          const noise = Math.max(max - min, before.max - before.min) / Math.abs(before.median);
          const sign = change > 0 ? "+" : "";
          row.push(
            fmt(before.median),
            `${sign}${(change * 100).toFixed(1)}%${Math.abs(change) <= noise ? " (noise)" : ""}`
          );
        }
      }
      rows.push(row);
    }
    const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
    for (const row of rows) {
      console.log(
        `  ${row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  ")}`
      );
    }
  }
}

// -- CPU profiles ------------------------------------------------------------------

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}

function functionName({ functionName, url, lineNumber }: ProfileNode["callFrame"]): string {
  // Rust symbols end in a hash; wasm frames have no useful URL.
  const name = functionName.replace(/::h[0-9a-f]{16}$/, "") || "(anonymous)";
  if (!url || url.startsWith("wasm://")) return url ? `${name}  [wasm]` : name;
  return `${name}  ${basename(url.split("?")[0])}:${lineNumber + 1}`;
}

/** wasm-bindgen's trampolines, which every call into the renderer passes through. */
const GLUE = /^(real|js-to-wasm|wasm_bindgen__convert__|wasm_bindgen::convert::)/;

function printTopFunctions(path: string, profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }) {
  const parent = new Map<number, number>();
  const byId = new Map<number, ProfileNode>();
  for (const node of profile.nodes) {
    byId.set(node.id, node);
    for (const child of node.children ?? []) parent.set(child, node.id);
  }
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  let active = 0;
  let wall = 0;
  const IDLE = new Set(["(idle)", "(program)", "(root)"]);
  for (let i = 0; i < profile.samples.length; i++) {
    // A sample's time runs until the next one.
    const ms = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    wall += ms;
    const leaf = byId.get(profile.samples[i])!;
    if (IDLE.has(leaf.callFrame.functionName)) continue;
    active += ms;
    const name = functionName(leaf.callFrame);
    self.set(name, (self.get(name) ?? 0) + ms);
    const seen = new Set<string>();
    for (let id: number | undefined = leaf.id; id !== undefined; id = parent.get(id)) {
      const frame = byId.get(id)!.callFrame;
      if (IDLE.has(frame.functionName) || GLUE.test(frame.functionName)) continue;
      seen.add(functionName(frame));
    }
    for (const key of seen) total.set(key, (total.get(key) ?? 0) + ms);
  }
  const seconds = wall / 1000;
  console.log(`\n${basename(path)}: main thread busy ${fmt(active / seconds)} ms/s`);
  const show = (title: string, map: Map<string, number>) => {
    console.log(`  ${title}`);
    for (const [name, ms] of [...map].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(
        `    ${fmt(ms / seconds).padStart(7)} ms/s  ${((ms / active) * 100).toFixed(1).padStart(5)}%  ${name}`
      );
    }
  };
  show("self time", self);
  show("total time (with what it calls)", total);
}

/** When core-rs's newest Rust source, shader or build setting was last changed. */
function newestSource(): number {
  const crate = join(ROOT, "packages/core-rs");
  const files = ["build.rs", "Cargo.toml", "Cargo.lock", ".cargo/config.toml"].map(file => join(crate, file));
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(join(crate, "src"));
  return Math.max(...files.filter(existsSync).map(file => statSync(file).mtimeMs));
}

function hasNames(wasm: Buffer): boolean {
  let at = 8;
  const leb = () => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = wasm[at++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  while (at < wasm.length) {
    const id = wasm[at++];
    const size = leb();
    const end = at + size;
    if (id === 0) {
      const length = leb();
      if (wasm.subarray(at, at + length).toString() === "name") return true;
    }
    at = end;
  }
  return false;
}

// -- Main ----------------------------------------------------------------------------

async function main() {
  if (RENDERERS.includes("rs") && !existsSync(WASM)) {
    throw new Error("core-rs is not built: pnpm -C packages/core-rs build (or build:profiling)");
  }
  if (!existsSync(join(ROOT, "packages/core/dist"))) throw new Error("core is not built: pnpm build");
  if (RENDERERS.includes("rs") && newestSource() > statSync(WASM).mtimeMs) {
    console.warn("The wasm is older than core-rs's Rust sources, so this measures old code: rebuild it first.");
  }
  if (args.profile && RENDERERS.includes("rs") && !hasNames(readFileSync(WASM))) {
    console.warn(
      "The wasm has no function names, so Rust frames will show as wasm-function[n]. For names: pnpm -C packages/core-rs build:profiling"
    );
  }
  const base = args.url ?? (await startDevServer());
  const { cdp, page } = await startChrome();
  const results: RunResult[] = [];
  let isolated = true;
  for (let run = 1; run <= RUNS; run++) {
    for (const scenario of SCENARIOS) {
      for (const renderer of RENDERERS) {
        const name = label(scenario, renderer);
        process.stdout.write(`run ${run}/${RUNS}  ${name} … `);
        const { setup, numbers } = await measureSettled(cdp, page, scenario, renderer, base);
        isolated &&= setup.isolated;
        results.push({ label: name, run, setup, numbers });
        const frame = numbers["frame mean"];
        console.log(
          `main busy ${fmt(numbers["main busy"])} ms/s${frame === undefined ? "" : `, frame ${fmt(frame)} ms`}`
        );
      }
    }
  }
  if (!isolated) {
    console.warn("\nThe page was not cross-origin isolated, so frame times are rounded to 100 µs (see --url).");
  }

  const report = summarize(results);
  const baseline = args.baseline ? (JSON.parse(await readFile(args.baseline, "utf8")).report as Report) : undefined;
  printReport(report, baseline);
  if (args.save) {
    await writeFile(args.save, JSON.stringify({ args, date: new Date().toISOString(), report, results }, null, "\t"));
    console.log(`\nSaved to ${args.save}`);
  }

  if (args.profile) {
    await mkdir(args.out, { recursive: true });
    for (const scenario of SCENARIOS) {
      for (const renderer of RENDERERS) {
        const path = join(args.out, `${label(scenario, renderer).replace(/[:*]/g, "-")}.cpuprofile`);
        await measureSettled(cdp, page, scenario, renderer, base, path);
        printTopFunctions(path, JSON.parse(await readFile(path, "utf8")));
      }
    }
    console.log(`\nProfiles are in ${args.out}; open one in Chrome DevTools' Performance panel.`);
  }
  cdp.close();
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(cleanUp);
