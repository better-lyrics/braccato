// Runs a Rust step of this package, or skips it with a notice when the toolchain is missing.
//
// The rest of the workspace builds with Node alone, and this package is private, so a contributor
// (or a CI job) without Rust should still get through `pnpm build` and `pnpm test`.
//
//   node scripts/run.mjs build   wasm-pack into pkg/
//   node scripts/run.mjs test    cargo test --lib

import { spawnSync } from "node:child_process";

const STEPS = {
	build: {
		needs: ["cargo", "wasm-pack"],
		run: ["wasm-pack", ["build", "--target", "web", "--release", "--out-dir", "pkg", "--no-pack"]],
	},
	test: {
		needs: ["cargo"],
		run: ["cargo", ["test", "--lib"]],
	},
};

const step = STEPS[process.argv[2]];
if (!step) {
	console.error(`usage: node scripts/run.mjs ${Object.keys(STEPS).join(" | ")}`);
	process.exit(2);
}

const missing = step.needs.filter((tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).error);
if (missing.length > 0) {
	console.warn(`@braccato/core-rs: skipped, ${missing.join(" and ")} not installed. See packages/core-rs/README.md.`);
	process.exit(0);
}

const [command, args] = step.run;
const result = spawnSync(command, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
