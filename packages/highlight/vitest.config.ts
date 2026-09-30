import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		// The DOM helpers are exercised against a small fake document (src/__tests__/fakeDom.ts), so
		// the suite needs no jsdom, same as parsers.
		environment: "node",
	},
});
