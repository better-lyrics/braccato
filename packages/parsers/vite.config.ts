import { resolve } from "node:path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

// A watch build empties dist/ before it rewrites it, which leaves the emitted types missing for about
// a second on every rebuild. Nothing notices in a one package repo; here `@braccato/provider-blyrics`
// resolves `Lyric` out of dist/index.d.ts, and under `pnpm dev` its own build lands inside that
// window and fails with "Cannot find module '@braccato/parsers'". Keeping the previous output in
// place until the new one overwrites it closes the hole. A one off build still cleans, so a renamed
// entry point cannot leave a stale file behind in anything published.
const isWatch = process.argv.includes("--watch") || process.argv.includes("-w");

export default defineConfig({
	plugins: [dts({ rollupTypes: true })],
	build: {
		emptyOutDir: !isWatch,
		lib: {
			entry: resolve(__dirname, "src/index.ts"),
			formats: ["es"],
			fileName: "index",
		},
		rollupOptions: {
			// Left to itself vite inlines every import that is not marked external, which would bake a
			// copy of fast-xml-parser into the bundle instead of resolving the one the consumer installs.
			external: [/^@braccato\//, /^fast-xml-parser/],
		},
	},
});
