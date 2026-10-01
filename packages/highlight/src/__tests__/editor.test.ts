import { detectFormat } from "@braccato/parsers/format";
import { describe, expect, it } from "vitest";
import { SYNCED_BOX_PROPERTIES, attachEditor, layerText } from "../editor.js";
import { mergeTokens } from "../render.js";
import { tokenize } from "../tokenize.js";
import { TOKEN_TYPES, type TokenType } from "../types.js";
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
			"direction",
			"text-align",
			"text-indent",
			"text-transform",
			"word-break",
			"overflow-wrap",
			"font-stretch",
			"font-variant",
			"font-feature-settings",
			"font-kerning",
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

describe("attachEditor box sync", () => {
	it("copies the textarea's computed text box onto the layer", () => {
		const { textarea, attach } = mount();
		textarea.computed = { direction: "rtl", "text-align": "right", "font-feature-settings": '"liga" 0' };
		const layer = attach().layer as unknown as FakeNode;
		expect(layer.style.getPropertyValue("direction")).toBe("rtl");
		expect(layer.style.getPropertyValue("text-align")).toBe("right");
		expect(layer.style.getPropertyValue("font-feature-settings")).toBe('"liga" 0');
	});

	it("mirrors the dir attribute, including removing it", () => {
		const { textarea, attach } = mount();
		textarea.setAttribute("dir", "auto");
		const editor = attach();
		const layer = editor.layer as unknown as FakeNode;
		expect(layer.getAttribute("dir")).toBe("auto");
		textarea.removeAttribute("dir");
		editor.refresh();
		expect(layer.getAttribute("dir")).toBeNull();
	});
});

describe("attachEditor preconditions", () => {
	it("throws a clear error for a textarea that is not in the DOM", () => {
		const textarea = createFakeDocument().createElement("textarea");
		expect(() => attachEditor(textarea as unknown as HTMLTextAreaElement)).toThrow(/parent/);
		expect(textarea.parent).toBeNull();
		expect(textarea.className).toBe("");
	});
});

// -- Incremental rendering --------------------------

const TTML = [
	'<tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata">',
	"<head><metadata>",
	'<ttm:agent xml:id="v1"/>',
	"</metadata></head>",
	"<body>",
	'<p begin="00:01.000" end="00:02.000"><span begin="00:01.000" end="00:01.500">one</span> <span begin="00:01.500" end="00:02.000">two</span></p>',
	'<p begin="00:02.000" end="00:03.000"><span begin="00:02.000" end="00:03.000">three</span></p>',
	'<p begin="00:03.000" end="00:04.000"><span begin="00:03.000" end="00:04.000">four</span></p>',
	"</body>",
	"</tt>",
].join("\n");

function mountWith(value: string) {
	const doc = createFakeDocument();
	const parent = doc.createElement("div");
	const textarea = doc.createElement("textarea");
	textarea.value = value;
	parent.append(textarea);
	const editor = attachEditor(textarea as unknown as HTMLTextAreaElement);
	const layer = editor.layer as unknown as FakeNode;
	const type = (text: FakeNode): TokenType => {
		for (let at = text.parent; at && at !== layer; at = at.parent) {
			const type = TOKEN_TYPES.find((t) => at.className === `bh-${t}`);
			if (type) return type;
		}
		return "text";
	};
	const leaves = (node: FakeNode): FakeNode[] =>
		node.nodeName === "#text" ? [node] : node.children.flatMap((child) => leaves(child));
	const rendered = () => mergeTokens(leaves(layer).map((leaf) => ({ type: type(leaf), text: leaf.textContent })));
	const input = (next: string) => {
		textarea.value = next;
		textarea.dispatch("input");
	};
	const expected = () => mergeTokens(tokenize(layerText(textarea.value), detectFormat(textarea.value)));
	return { textarea, editor, layer, rendered, input, expected, leaves };
}

describe("attachEditor incremental rendering", () => {
	it("keeps the nodes of lines an edit did not touch", () => {
		const { layer, input, leaves } = mountWith(TTML);
		const before = leaves(layer);
		input(TTML.replace(">three<", ">thre<"));
		const after = leaves(layer);
		const rebuilt = after.filter((leaf) => !before.includes(leaf));
		expect(rebuilt.map((leaf) => leaf.textContent).join("")).toBe(
			'<p begin="00:02.000" end="00:03.000"><span begin="00:02.000" end="00:03.000">thre</span></p>\n',
		);
	});

	it("renders one bh-line element per line", () => {
		const { layer } = mountWith("a\nb\n");
		expect(layer.children.map((c) => `${c.nodeName}.${c.className}:${c.textContent}`)).toEqual([
			"SPAN.bh-line:a\n",
			"SPAN.bh-line:b\n",
			"SPAN.bh-line: ",
		]);
	});

	it("re-colours later lines when an edit changes the TTML state", () => {
		const { input, rendered, expected } = mountWith(TTML);
		input(TTML.replace("<body>", '<body><span ttm:role="x-bg">'));
		expect(rendered()).toEqual(expected());
		expect(rendered().some((t) => t.type === "bgText" && t.text === "four")).toBe(true);
	});

	it("renders a pasted document of another format", () => {
		const { input, rendered, expected, layer } = mountWith(TTML);
		input("[00:01.00]a\n[00:02.00]b\n");
		expect(layer.textContent).toBe("[00:01.00]a\n[00:02.00]b\n ");
		expect(rendered()).toEqual(expected());
	});

	it("refresh rebuilds a layer that drifted", () => {
		const { editor, layer, rendered, expected } = mountWith(TTML);
		layer.children[0].remove();
		editor.refresh();
		expect(layer.textContent).toBe(TTML);
		expect(rendered()).toEqual(expected());
	});

	describe("invariants", () => {
		const SNIPPETS = [
			"x",
			"\n",
			"\r\n",
			"\n\n",
			'<span ttm:role="x-bg">',
			"</span>",
			"<head>",
			"</head>",
			"<!--",
			"-->",
			'<p begin="00:05.000">five\nsix</p>\n',
			"\uFEFF",
			'"',
			"<",
		];

		it("matches a full render after random edit sequences", () => {
			let seed = 42;
			const random = () => {
				seed = (seed * 1103515245 + 12345) % 2147483648;
				return seed / 2147483648;
			};
			for (let round = 0; round < 20; round++) {
				const { textarea, layer, input, rendered, expected } = mountWith(TTML);
				for (let step = 0; step < 40; step++) {
					const value = textarea.value;
					const at = Math.floor(random() * (value.length + 1));
					const roll = random();
					if (roll < 0.5) {
						input(value.slice(0, at) + SNIPPETS[Math.floor(random() * SNIPPETS.length)] + value.slice(at));
					} else if (roll < 0.9) {
						input(value.slice(0, at) + value.slice(at + Math.floor(random() * 80)));
					} else if (roll < 0.95) {
						input(TTML.replace(/\n/g, "\r\n"));
					} else {
						input("");
					}
					expect(layer.textContent).toBe(layerText(textarea.value));
					expect(rendered()).toEqual(expected());
				}
			}
		});
	});

	describe("performance", () => {
		it("regression: a keystroke in a 1 MB document stays linear", () => {
			const line = `<p begin="00:01.000" end="00:02.000">${"la ".repeat(100)}</p>\n`;
			const src = `<tt><body>\n${line.repeat(3_000)}</body></tt>`;
			const { input, layer } = mountWith(src);
			const at = src.length / 2;
			const started = performance.now();
			input(`${src.slice(0, at)}x${src.slice(at)}`);
			expect(performance.now() - started).toBeLessThan(1000);
			expect(layer.textContent.length).toBe(src.length + 1);
		});

		it("regression: attaches to a document with very many lines without overflowing the call stack", () => {
			const src = "a\n".repeat(150_000);
			const { layer } = mountWith(src);
			expect(layer.children).toHaveLength(150_001);
		});
	});
});
