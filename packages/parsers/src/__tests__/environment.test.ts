import { describe, expect, it } from "vitest";

describe("test environment", () => {
	// The TTML parser used to read a document with the global DOMParser, which is why the suite ran
	// under jsdom. It reads it with fast-xml-parser now and nothing else here touches the DOM, so the
	// suite runs on node. This is what says so: a parser that reached for a browser global again
	// would fail here rather than quietly reinstate a browser to test in.
	it("runs without a DOM", () => {
		expect(typeof globalThis.document).toBe("undefined");
		expect(typeof globalThis.DOMParser).toBe("undefined");
	});
});
