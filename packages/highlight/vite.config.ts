import { resolve } from "node:path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

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
			external: [/^@braccato\//],
		},
	},
});
