import { resolve } from "node:path";
import { defineConfig } from "vite";

// The demo page's copy of the parsers, as one self-contained file.
//
// The published build leaves `fast-xml-parser` as a bare specifier, which is right for a consumer
// with a bundler and impossible for a page that has neither a bundler nor an import map. So the demo
// gets its own build with nothing external, and the page loads that.
//
// It lands in demo/generated/ beside the synthesized audio: gitignored, rebuilt by `pnpm demo` and
// `pnpm site`, and copied out with the rest of the page. `emptyOutDir` is off because the audio is
// already in there and a library build would otherwise wipe it.
export default defineConfig({
	build: {
		outDir: resolve(__dirname, "../../demo/generated"),
		emptyOutDir: false,
		lib: {
			entry: resolve(__dirname, "src/index.ts"),
			formats: ["es"],
			fileName: () => "parsers.js",
		},
	},
});
