// Runs a Rust step of this package, or skips it with a notice when the toolchain is missing.
//
// The rest of the workspace builds with Node alone, so a contributor without Rust should still get
// through `pnpm build`, `pnpm lint` and `pnpm test`. CI and the release set BRACCATO_REQUIRE_RUST,
// which turns the skip into a failure: a published package without its wasm would be broken.
//
//   node scripts/run.mjs build             wasm-pack into pkg/
//   node scripts/run.mjs build:profiling   the same, keeping function names for CPU profiles
//   node scripts/run.mjs lint              cargo fmt --check, and clippy with warnings as errors
//   node scripts/run.mjs test              cargo test --lib
//
// Turbo does not cache these (see turbo.json): a run that skipped would be replayed as a success
// once Rust is installed, and Cargo already rebuilds only what changed.

import { spawnSync } from "node:child_process";

const WASM_PACK = ["wasm-pack", "build", "--target", "web", "--out-dir", "pkg", "--no-pack"];

const STEPS = {
	build: {
		needs: ["cargo", "wasm-pack"],
		run: [[...WASM_PACK, "--release"]],
	},
	"build:profiling": {
		needs: ["cargo", "wasm-pack"],
		run: [[...WASM_PACK, "--profiling"]],
	},
	lint: {
		needs: ["cargo", "rustfmt", "cargo-clippy"],
		run: [
			["cargo", "fmt", "--check"],
			// The wasm target: the renderer's code only compiles there.
			["cargo", "clippy", "--target", "wasm32-unknown-unknown", "--", "-D", "warnings"],
		],
	},
	test: {
		needs: ["cargo"],
		run: [["cargo", "test", "--lib"]],
	},
};

const step = STEPS[process.argv[2]];
if (!step) {
	console.error(`usage: node scripts/run.mjs ${Object.keys(STEPS).join(" | ")}`);
	process.exit(2);
}

const missing = step.needs.filter((tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).error);
if (missing.length > 0) {
	const message = `@braccato/core (packages/core-rs): ${missing.join(" and ")} not installed. See packages/core-rs/README.md.`;
	if (process.env.BRACCATO_REQUIRE_RUST) {
		console.error(message);
		process.exit(1);
	}
	console.warn(`${message} Skipped.`);
	process.exit(0);
}

for (const [command, ...args] of step.run) {
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.status !== 0) process.exit(result.status ?? 1);
}
