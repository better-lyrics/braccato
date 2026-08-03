import { resolve } from "node:path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
	plugins: [dts({ rollupTypes: true })],
	build: {
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
