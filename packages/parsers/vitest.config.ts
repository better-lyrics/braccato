import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		// Nothing under src/ touches the DOM. jsdom was here for a TTML parser that read documents with
		// the global DOMParser, and it cost more to stand up than the whole suite costs to run.
		environment: "node",
	},
});
