// Runs a Rust step of this package, or skips it with a notice when the toolchain is missing.
//
// The rest of the workspace builds with Node alone, so a contributor without Rust should still get
// through `pnpm build` and `pnpm test`. The release sets BRACCATO_REQUIRE_RUST, which turns the
// skip into a failure: a published package without its wasm would be broken.
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
	const message = `@braccato/core-rs: ${missing.join(" and ")} not installed. See packages/core-rs/README.md.`;
	if (process.env.BRACCATO_REQUIRE_RUST) {
		console.error(message);
		process.exit(1);
	}
	console.warn(`${message} Skipped.`);
	process.exit(0);
}

const [command, args] = step.run;
const result = spawnSync(command, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
