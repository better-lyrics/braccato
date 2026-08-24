// Rebuilds the published @braccato/core artifact whenever one of its inputs changes. Better Lyrics
// links to that artifact, rather than to the TypeScript sources, so a complete package build is the
// boundary its own dev server needs to observe.

import { spawn, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const toolingDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(toolingDir, "..");
const packageDir = join(repoRoot, "packages", "core");

const PACKAGE_INPUTS = new Set(["LICENSE", "README.md", "package.json"]);
const TOOLING_INPUTS = new Set(["build-package.ts", "check-api-docs.ts", "tsconfig.package.json"]);
const SOURCE_PREFIX = `src${sep}`;
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

let child: ChildProcess | null = null;
let buildAgain = false;
let debounce: NodeJS.Timeout | null = null;
let stopping = false;

const scheduleBuild = (changedPath: string) => {
  if (stopping) return;

  console.log(`[package:watch] ${changedPath} changed`);
  if (debounce !== null) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    runBuild();
  }, 75);
};

const runBuild = () => {
  if (child !== null) {
    buildAgain = true;
    return;
  }

  console.log("[package:watch] Building @braccato/core...");
  child = spawn(pnpm, ["package"], {
    cwd: repoRoot,
    env: { ...process.env, BRACCATO_PACKAGE_WATCH: "1" },
    stdio: "inherit",
  });
  child.once("error", error => {
    console.error(`[package:watch] Could not start the package build: ${error.message}`);
  });
  child.once("close", code => {
    child = null;
    if (stopping) return;

    if (code === 0) console.log("[package:watch] Watching for renderer changes...");
    else console.error(`[package:watch] Package build failed with exit code ${code ?? "unknown"}`);

    if (buildAgain) {
      buildAgain = false;
      runBuild();
    }
  });
};

const watchers: FSWatcher[] = [
  watch(packageDir, { recursive: true }, (_event, filename) => {
    if (filename === null) return;
    const relative = normalize(filename);
    if (relative.startsWith(SOURCE_PREFIX) || PACKAGE_INPUTS.has(relative)) scheduleBuild(relative);
  }),
  watch(toolingDir, (_event, filename) => {
    if (filename === null) return;
    const relative = normalize(filename);
    if (TOOLING_INPUTS.has(relative)) scheduleBuild(join("tooling", relative));
  }),
];

const stop = () => {
  if (stopping) return;
  stopping = true;
  if (debounce !== null) clearTimeout(debounce);
  for (const watcher of watchers) watcher.close();
  if (child !== null) child.kill("SIGTERM");
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

runBuild();
