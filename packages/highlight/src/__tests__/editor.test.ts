import { describe, expect, it } from "vitest";
import { SYNCED_BOX_PROPERTIES, attachEditor, layerText } from "../editor.js";
import { type FakeNode, createFakeDocument } from "./fakeDom.js";

describe("layerText", () => {
	it("adds a trailing space after a final newline", () => {
		expect(layerText("a\n")).toBe("a\n ");
		expect(layerText("a\r\n")).toBe("a\r\n ");
	});

	it("leaves other text alone", () => {
		expect(layerText("a")).toBe("a");
		expect(layerText("")).toBe("");
	});
});

describe("SYNCED_BOX_PROPERTIES", () => {
	it("covers everything that moves glyphs", () => {
		for (const prop of [
			"font-family",
			"font-size",
			"line-height",
			"letter-spacing",
			"padding-left",
			"padding-top",
			"border-left-width",
			"box-sizing",
			"tab-size",
		]) {
			expect(SYNCED_BOX_PROPERTIES).toContain(prop);
		}
	});
});

function mount() {
	const doc = createFakeDocument();
	const parent = doc.createElement("div");
	const before = doc.createElement("label");
	const after = doc.createElement("button");
	const textarea = doc.createElement("textarea");
	textarea.className = "input input--area";
	textarea.value = "[00:01.00]Hi";
	parent.append(before, textarea, after);
	const attach = () => attachEditor(textarea as unknown as HTMLTextAreaElement);
	return { doc, parent, before, after, textarea, attach };
}

describe("attachEditor lifecycle", () => {
	it("wraps the textarea in place and renders its value", () => {
		const { parent, before, after, textarea, attach } = mount();
		const editor = attach();
		const wrap = editor.wrap as unknown as FakeNode;
		expect(parent.children).toEqual([before, wrap, after]);
		expect(wrap.children).toEqual([editor.layer as unknown as FakeNode, textarea]);
		expect(textarea.className).toBe("input input--area bh-input");
		expect(editor.layer.textContent).toBe("[00:01.00]Hi");
	});

	it("re-renders on input", () => {
		const { textarea, attach } = mount();
		const editor = attach();
		textarea.value = "[00:02.00]Bye";
		textarea.dispatch("input");
		expect(editor.layer.textContent).toBe("[00:02.00]Bye");
	});

	it("refresh picks up a programmatic value write", () => {
		const { textarea, attach } = mount();
		const editor = attach();
		textarea.value = "<tt><p>x</p></tt>";
		expect(editor.layer.textContent).toBe("[00:01.00]Hi");
		editor.refresh();
		expect(editor.layer.textContent).toBe("<tt><p>x</p></tt>");
	});

	it("destroy restores the DOM, the class and the listeners", () => {
		const { doc, parent, before, after, textarea, attach } = mount();
		attach().destroy();
		expect(parent.children).toEqual([before, textarea, after]);
		expect(textarea.parent).toBe(parent);
		expect(textarea.className).toBe("input input--area");
		expect([...textarea.listeners.values()].every((set) => set.size === 0)).toBe(true);
		expect(doc.defaultView.observers.every((o) => !o.connected)).toBe(true);
	});

	it("destroy twice is safe", () => {
		const { parent, before, after, textarea, attach } = mount();
		const editor = attach();
		editor.destroy();
		expect(() => editor.destroy()).not.toThrow();
		expect(parent.children).toEqual([before, textarea, after]);
		expect(textarea.className).toBe("input input--area");
	});

	it("keeps a class the host set itself", () => {
		const { textarea, attach } = mount();
		textarea.className = "bh-input";
		attach().destroy();
		expect(textarea.className).toBe("bh-input");
	});
});

describe("attachEditor double attach", () => {
	it("returns the existing handle instead of wrapping twice", () => {
		const { parent, attach } = mount();
		const first = attach();
		expect(attach()).toBe(first);
		expect(parent.children.filter((c) => c.className === "bh-edit")).toHaveLength(1);
	});

	it("attaches afresh after destroy", () => {
		const { attach } = mount();
		const first = attach();
		first.destroy();
		const second = attach();
		expect(second).not.toBe(first);
		expect(second.layer.textContent).toBe("[00:01.00]Hi");
	});
});

describe("attachEditor stale handles", () => {
	it("a second destroy on an old handle leaves a newer editor alone", () => {
		const { parent, textarea, attach } = mount();
		const first = attach();
		first.destroy();
		const second = attach();
		first.destroy();
		expect(textarea.parent).toBe(second.wrap as unknown as FakeNode);
		expect(textarea.className).toContain("bh-input");
		expect(attach()).toBe(second);
		expect(parent.children).toContain(second.wrap as unknown as FakeNode);
	});
});
