// Copies what @braccato/core publishes beside the renderer from the DOM renderer's build into dist/:
// the leaf modules (`constants`, `text`, `themeSettings`, `util`) and the stylesheets. Consumers of
// 1.x import them by these paths, and they are the same for both renderers. The leaves import
// nothing (packages/core's boundary self-check holds them to it), so a copy works on its own.
//
// Runs without Rust, so a contributor without it still gets these; the wasm build after it skips.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../../core/dist/", import.meta.url));
const to = fileURLToPath(new URL("../dist/", import.meta.url));
const LEAVES = ["constants", "text", "themeSettings", "util"];

if (!existsSync(from)) {
	console.error("@braccato/core (packages/core-rs): packages/core is not built. Run pnpm build.");
	process.exit(1);
}
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
for (const leaf of LEAVES) {
	for (const ext of [".js", ".d.ts"]) cpSync(`${from}${leaf}${ext}`, `${to}${leaf}${ext}`);
}
cpSync(`${from}styles`, `${to}styles`, { recursive: true });
