import { detectFormat } from "@braccato/parsers/format";
import { describe, expect, it } from "vitest";
import { SYNCED_BOX_PROPERTIES, attachEditor, layerText } from "../editor.js";
import { splitLines } from "../lines.js";
import { pushToken, tokenize } from "../tokenize.js";
import { type LyricFormat, TOKEN_TYPES, type Token, type TokenType } from "../types.js";
import { type FakeNode, createFakeDocument } from "./fakeDom.js";

const merged = (tokens: readonly Token[]) => {
	const out: Token[] = [];
	for (const { type, text } of tokens) pushToken(out, type, text);
	return out;
};

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

	it("refresh after destroy does nothing", () => {
		const { doc, textarea, attach } = mount();
		const editor = attach();
		editor.destroy();
		textarea.value = "[00:09.00]Late";
		editor.refresh();
		doc.defaultView.flushFrames();
		expect(editor.layer.textContent).toBe("[00:01.00]Hi");
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

describe("attachEditor setFormat", () => {
	const LRC_LOOKING = "[00:01.00]Hi\n[00:02.00]there";
	const classes = (layer: FakeNode) => layer.children.flatMap((line) => line.children.map((c) => c.className));
	const mountFixed = (format?: LyricFormat) => {
		const { doc, parent, textarea } = mount();
		textarea.value = LRC_LOOKING;
		const editor = attachEditor(textarea as unknown as HTMLTextAreaElement, { format });
		return { doc, parent, textarea, editor, layer: editor.layer as unknown as FakeNode };
	};

	it("re-colours a live editor in the new format", () => {
		const { editor, layer } = mountFixed();
		expect(classes(layer)).toContain("bh-timestamp");
		editor.setFormat("plain");
		expect(classes(layer).every((name) => name === "")).toBe(true);
		expect(layer.textContent).toBe(LRC_LOOKING);
	});

	it("goes back to detecting on every render when given undefined", () => {
		const { editor, layer, textarea } = mountFixed("plain");
		expect(classes(layer)).not.toContain("bh-timestamp");
		editor.setFormat(undefined);
		expect(classes(layer)).toContain("bh-timestamp");
		textarea.value = "<tt><p>x</p></tt>";
		textarea.dispatch("input");
		expect(classes(layer)).toContain("bh-tag");
	});

	it("keeps the fixed format across input until it is changed", () => {
		const { editor, layer, textarea } = mountFixed();
		editor.setFormat("plain");
		textarea.value = `${LRC_LOOKING}\n[00:03.00]more`;
		textarea.dispatch("input");
		expect(classes(layer)).not.toContain("bh-timestamp");
		editor.setFormat("lrc");
		expect(classes(layer)).toContain("bh-timestamp");
		expect(layer.textContent).toBe(`${LRC_LOOKING}\n[00:03.00]more`);
	});

	it("draws what a full render of the new format draws", () => {
		const { editor, layer, textarea } = mountFixed();
		textarea.value = `<tt><p begin="1">[00:01.00]a</p>\n<p>(1000,20)b</p></tt>`;
		editor.refresh();
		const snapshot = () => layer.children.map((line) => line.children.map((c) => `${c.className}:${c.textContent}`));
		for (const format of ["lrc", "qrc", "srt", "plain", "ttml", undefined] as const) {
			editor.setFormat(format);
			const switched = snapshot();
			editor.refresh();
			expect(switched, String(format)).toEqual(snapshot());
		}
	});

	it("is a no-op when the format is unchanged", () => {
		const { editor, layer, textarea } = mountFixed("lrc");
		const lines = [...layer.children];
		const nodes = lines.flatMap((line) => [...line.children]);
		textarea.value = "[00:09.00]written from code";
		editor.setFormat("lrc");
		expect(layer.children).toEqual(lines);
		expect(layer.children.flatMap((line) => line.children)).toEqual(nodes);
		expect(layer.textContent).toBe(LRC_LOOKING);
	});

	it("is a no-op when detection is already on", () => {
		const { editor, layer } = mountFixed();
		const lines = [...layer.children];
		editor.setFormat(undefined);
		expect(layer.children).toEqual(lines);
	});

	it("does not rebuild the textarea or the wrapper", () => {
		const { editor, parent, textarea, layer } = mountFixed();
		const wrap = editor.wrap as unknown as FakeNode;
		const listeners = [...textarea.listeners.values()].map((set) => [...set]);
		editor.setFormat("plain");
		expect(parent.children).toContain(wrap);
		expect(wrap.children).toEqual([layer, textarea]);
		expect(textarea.parent).toBe(wrap);
		expect(textarea.value).toBe(LRC_LOOKING);
		expect([...textarea.listeners.values()].map((set) => [...set])).toEqual(listeners);
	});

	it("does nothing after destroy", () => {
		const { editor, layer } = mountFixed();
		editor.destroy();
		editor.setFormat("plain");
		expect(classes(layer)).toContain("bh-timestamp");
	});

	it("is owned by the editor: mutating the options object after attach changes nothing", () => {
		const { textarea } = mount();
		textarea.value = LRC_LOOKING;
		const options: { format?: LyricFormat } = {};
		const editor = attachEditor(textarea as unknown as HTMLTextAreaElement, options);
		options.format = "plain";
		editor.refresh();
		expect(classes(editor.layer as unknown as FakeNode)).toContain("bh-timestamp");
	});

	it("ignores the options of a second attach, so setFormat is the way to change format", () => {
		const { editor, textarea, layer } = mountFixed("lrc");
		const again = attachEditor(textarea as unknown as HTMLTextAreaElement, { format: "plain" });
		expect(again).toBe(editor);
		again.refresh();
		expect(classes(layer)).toContain("bh-timestamp");
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

describe("attachEditor line height", () => {
	const typedLineHeight = (textarea: FakeNode, written: string) => {
		const live = { written };
		textarea.computedStyleMap = () => ({
			get: (prop) => (prop === "line-height" ? { toString: () => live.written } : undefined),
		});
		return live;
	};

	it("regression: copies a unitless line-height as written, because Blink rounds its resolved px differently", () => {
		const { textarea, attach } = mount();
		textarea.computed = { "font-size": "12px", "line-height": "20.4px" };
		typedLineHeight(textarea, "1.7");
		const layer = attach().layer as unknown as FakeNode;
		expect(layer.style.getPropertyValue("line-height")).toBe("1.7");
		expect(layer.style.getPropertyValue("font-size")).toBe("12px");
	});

	it("follows the textarea when its line-height changes form", () => {
		const { textarea, attach } = mount();
		textarea.computed = { "line-height": "20.4px" };
		const lineHeight = typedLineHeight(textarea, "1.7");
		const layer = attach().layer as unknown as FakeNode;
		lineHeight.written = "20.4px";
		textarea.dispatch("input");
		expect(layer.style.getPropertyValue("line-height")).toBe("20.4px");
		lineHeight.written = "normal";
		textarea.dispatch("input");
		expect(layer.style.getPropertyValue("line-height")).toBe("normal");
	});

	it("falls back to the computed line-height in an engine without CSS Typed OM", () => {
		const { textarea, attach } = mount();
		textarea.computed = { "line-height": "20.4px" };
		const layer = attach().layer as unknown as FakeNode;
		expect(layer.style.getPropertyValue("line-height")).toBe("20.4px");
	});
});

describe("attachEditor scrollbar gutters", () => {
	const FRAME = {
		"padding-top": "12px",
		"padding-right": "14px",
		"padding-bottom": "12px",
		"padding-left": "14px",
		"border-top-width": "2px",
		"border-right-width": "2px",
		"border-bottom-width": "2px",
		"border-left-width": "2px",
		"writing-mode": "horizontal-tb",
	};
	const mountBox = (scrollbar: Partial<FakeNode["scrollbar"]> = {}) => {
		const { doc, textarea, attach } = mount();
		textarea.computed = { ...FRAME };
		textarea.box = { width: 560, height: 360 };
		textarea.scrollbar = { vertical: 0, horizontal: 0, side: "right", ...scrollbar };
		const layer = attach().layer as unknown as FakeNode;
		const resize = () => {
			for (const observer of doc.defaultView.observers) if (observer.connected) observer.callback();
			doc.defaultView.flushFrames();
		};
		const px = (el: FakeNode, prop: string) => Number.parseFloat(el.style.getPropertyValue(prop)) || 0;
		const css = (prop: string) => Number.parseFloat(textarea.computed[prop] ?? "") || 0;
		const box = () => textarea.box ?? { width: 0, height: 0 };
		const exact = (value: number) => Math.round(value * 1e6) / 1e6;
		const layerContent = () => ({
			left: exact(px(layer, "left") + px(layer, "border-left-width") + px(layer, "padding-left")),
			right: exact(box().width - px(layer, "right") - px(layer, "border-right-width") - px(layer, "padding-right")),
		});
		const textareaContent = () => {
			const { vertical, side } = textarea.scrollbar;
			const leftGutter = side === "right" ? 0 : vertical;
			const rightGutter = side === "left" ? 0 : vertical;
			return {
				left: exact(css("border-left-width") + leftGutter + css("padding-left")),
				right: exact(box().width - css("border-right-width") - rightGutter - css("padding-right")),
			};
		};
		const layerClientHeight = () =>
			box().height -
			px(layer, "top") -
			px(layer, "bottom") -
			px(layer, "border-top-width") -
			px(layer, "border-bottom-width");
		const textareaClientHeight = () =>
			box().height - css("border-top-width") - css("border-bottom-width") - textarea.scrollbar.horizontal;
		return { textarea, layer, resize, layerContent, textareaContent, layerClientHeight, textareaClientHeight };
	};

	it("lays the layer's text out in the textarea's content box when a classic scrollbar takes width from it", () => {
		const { resize, layerContent, textareaContent } = mountBox({ vertical: 15 });
		resize();
		expect(layerContent()).toEqual(textareaContent());
	});

	it("regression: narrows the layer again when a scrollbar appears after the content grows", () => {
		const { textarea, resize, layerContent, textareaContent } = mountBox();
		resize();
		expect(layerContent()).toEqual(textareaContent());
		textarea.scrollbar = { ...textarea.scrollbar, vertical: 11 };
		resize();
		expect(layerContent()).toEqual(textareaContent());
		textarea.scrollbar = { ...textarea.scrollbar, vertical: 0 };
		resize();
		expect(layerContent()).toEqual(textareaContent());
	});

	it("reserves a scrollbar on the left, where Blink puts it for right-to-left text", () => {
		const { textarea, resize, layerContent, textareaContent } = mountBox({ vertical: 15, side: "left" });
		textarea.computed = { ...FRAME, direction: "rtl" };
		resize();
		expect(layerContent()).toEqual(textareaContent());
	});

	it("regression: keeps a right scrollbar on the right when a fractional border makes clientLeft round up", () => {
		const { textarea, resize, layer, layerContent, textareaContent } = mountBox({ vertical: 15 });
		textarea.computed = { ...FRAME, "border-left-width": "0.666667px", "border-right-width": "0.666667px" };
		resize();
		expect(textarea.clientLeft).toBe(1);
		expect(layerContent()).toEqual(textareaContent());
		expect(Number.parseFloat(layer.style.getPropertyValue("left")) || 0).toBe(0);
	});

	it("reserves a left scrollbar in full when a fractional border makes clientLeft round", () => {
		const { textarea, resize, layerContent, textareaContent } = mountBox({ vertical: 15, side: "left" });
		textarea.computed = { ...FRAME, "border-left-width": "0.666667px", "border-right-width": "0.666667px" };
		resize();
		expect(layerContent()).toEqual(textareaContent());
	});

	it("splits a both-edges gutter between the two sides", () => {
		const { resize, layerContent, textareaContent } = mountBox({ vertical: 15, side: "both" });
		resize();
		expect(layerContent()).toEqual(textareaContent());
	});

	it("matches the textarea's client height when a horizontal scrollbar takes height from it", () => {
		const { resize, layerClientHeight, textareaClientHeight, layerContent, textareaContent } = mountBox({
			vertical: 15,
			horizontal: 15,
		});
		resize();
		expect(layerClientHeight()).toBe(textareaClientHeight());
		expect(layerContent()).toEqual(textareaContent());
	});

	it("leaves the layer at the full box in a vertical writing mode, where the gutters fall on other edges", () => {
		const { textarea, layer, resize } = mountBox({ vertical: 15, horizontal: 15 });
		resize();
		expect(Number.parseFloat(layer.style.getPropertyValue("right"))).toBe(15);
		textarea.computed = { ...FRAME, "writing-mode": "vertical-rl" };
		resize();
		for (const side of ["left", "right", "bottom"])
			expect(Number.parseFloat(layer.style.getPropertyValue(side)) || 0).toBe(0);
	});

	it("keeps the layer at the full box with overlay scrollbars", () => {
		const { layer, resize, layerContent, textareaContent } = mountBox();
		resize();
		expect(layerContent()).toEqual(textareaContent());
		for (const side of ["left", "right", "bottom"])
			expect(Number.parseFloat(layer.style.getPropertyValue(side)) || 0).toBe(0);
	});

	it("measures scrollbars only on resize, never while handling input", () => {
		const { textarea, resize } = mountBox({ vertical: 15 });
		resize();
		let reads = 0;
		Object.defineProperty(textarea, "clientLeft", {
			get: () => {
				reads++;
				return 2;
			},
			configurable: true,
		});
		textarea.value = "[00:02.00]Bye";
		textarea.dispatch("input");
		expect(reads).toBe(0);
	});
});

describe("attachEditor layout reads", () => {
	it("does not read scroll offsets while handling input", () => {
		const { textarea, attach } = mount();
		attach();
		let reads = 0;
		let top = 0;
		Object.defineProperty(textarea, "scrollTop", {
			get: () => {
				reads++;
				return top;
			},
			set: (value: number) => {
				top = value;
			},
			configurable: true,
		});
		textarea.value = "[00:02.00]Bye";
		textarea.dispatch("input");
		expect(reads).toBe(0);
	});

	it("follows the textarea's scroll position on scroll", () => {
		const { textarea, attach } = mount();
		const layer = attach().layer as unknown as FakeNode;
		textarea.scrollTop = 40;
		textarea.scrollLeft = 7;
		textarea.dispatch("scroll");
		expect(layer.scrollTop).toBe(40);
		expect(layer.scrollLeft).toBe(7);
	});

	it("writes only the box properties that changed", () => {
		const { textarea, attach } = mount();
		textarea.computed = { "font-size": "13px", "padding-top": "4px" };
		const layer = attach().layer as unknown as FakeNode;
		const writes: string[] = [];
		const setProperty = layer.style.setProperty;
		layer.style.setProperty = (prop, value) => {
			writes.push(prop);
			setProperty(prop, value);
		};
		textarea.value = "[00:02.00]Bye";
		textarea.dispatch("input");
		expect(writes).toEqual([]);
		textarea.computed = { "font-size": "20px", "padding-top": "4px" };
		textarea.dispatch("input");
		expect(writes).toEqual(["font-size"]);
		expect(layer.style.getPropertyValue("font-size")).toBe("20px");
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

const ONE_LINE = TTML.replace(/\n/g, "");

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
	const rendered = () => merged(leaves(layer).map((leaf) => ({ type: type(leaf), text: leaf.textContent })));
	const input = (next: string) => {
		textarea.value = next;
		textarea.dispatch("input");
	};
	const expected = () => tokenize(layerText(textarea.value), detectFormat(textarea.value));
	return { textarea, editor, layer, rendered, input, expected, leaves };
}

describe("attachEditor incremental rendering", () => {
	it("keeps the nodes of lines an edit did not touch", () => {
		const { layer, input, leaves } = mountWith(TTML);
		const lineEls = [...layer.children];
		const before = leaves(layer);
		input(TTML.replace(">three<", '><span ttm:role="x-bg">three</span><'));
		expect(layer.children).toEqual(lineEls);
		const edited = layer.children[6];
		const rebuilt = leaves(layer).filter((leaf) => !before.includes(leaf));
		expect(rebuilt.length).toBeGreaterThan(0);
		expect(rebuilt.every((leaf) => leaves(edited).includes(leaf))).toBe(true);
	});

	it("edits a token's text in place when a keystroke stays inside it", () => {
		const { layer, input, leaves, rendered, expected } = mountWith(ONE_LINE);
		const before = leaves(layer);
		input(ONE_LINE.replace(">three<", ">thrxee<"));
		const after = leaves(layer);
		expect(after).toHaveLength(before.length);
		expect(after.every((leaf, k) => leaf === before[k])).toBe(true);
		expect(rendered()).toEqual(expected());
	});

	it("rebuilds only the tokens a structural edit changed inside one long line", () => {
		const { layer, input, leaves, rendered, expected } = mountWith(ONE_LINE);
		const before = leaves(layer);
		input(ONE_LINE.replace("</p><p", '</p><p begin="00:09.000">new</p><p'));
		const after = leaves(layer);
		expect(before.filter((leaf) => !after.includes(leaf)).length).toBeLessThanOrEqual(2);
		expect(after.filter((leaf) => !before.includes(leaf)).length).toBeLessThanOrEqual(12);
		expect(rendered()).toEqual(expected());
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
		}, 20_000);
	});
});

// -- Style window --------------------------

function mountWindowed(value: string, rows = 3, charsPerRow = 0) {
	const doc = createFakeDocument();
	doc.rowHeight = 10;
	doc.charsPerRow = charsPerRow;
	doc.layerHeight = rows * 10;
	const parent = doc.createElement("div");
	const textarea = doc.createElement("textarea");
	textarea.value = value;
	parent.append(textarea);
	const editor = attachEditor(textarea as unknown as HTMLTextAreaElement);
	const layer = editor.layer as unknown as FakeNode;
	const attachedPlain = layer.children.every((line) => line.children.every((c) => c.nodeName === "#text"));
	doc.defaultView.flushFrames();
	const isPlain = (line: number) => layer.children[line].children.every((c) => c.nodeName === "#text");
	const type = (text: FakeNode): TokenType => {
		for (let at = text.parent; at && at !== layer; at = at.parent) {
			const found = TOKEN_TYPES.find((t) => at.className === `bh-${t}`);
			if (found) return found;
		}
		return "text";
	};
	const lineTypes = (line: number) =>
		merged(layer.children[line].children.map((c) => ({ type: type(c.firstChild ?? c), text: c.textContent })));
	const expectedTypes = (line: number) =>
		splitLines(tokenize(layerText(textarea.value), detectFormat(textarea.value)))[line];
	const input = (next: string) => {
		textarea.value = next;
		textarea.dispatch("input");
		doc.defaultView.flushFrames();
	};
	const scrollTo = (top: number) => {
		textarea.scrollTop = top;
		textarea.dispatch("scroll");
	};
	const charTypes = (line: number) =>
		lineTypes(line).flatMap((token) => Array.from({ length: token.text.length }, () => token.type));
	const expectedCharTypes = (line: number) =>
		expectedTypes(line).flatMap((token) => Array.from({ length: token.text.length }, () => token.type));
	return {
		doc,
		textarea,
		editor,
		layer,
		isPlain,
		lineTypes,
		expectedTypes,
		charTypes,
		expectedCharTypes,
		input,
		scrollTo,
		attachedPlain,
	};
}

const LRC_LINES = Array.from({ length: 200 }, (_, k) => `[00:${String(k % 60).padStart(2, "0")}.00]line ${k}`).join(
	"\n",
);

describe("attachEditor style window", () => {
	it("styles the rows near the visible ones and renders far rows as plain text", () => {
		const { isPlain, lineTypes, expectedTypes } = mountWindowed(LRC_LINES);
		for (const line of [0, 2, 5]) expect(lineTypes(line)).toEqual(expectedTypes(line));
		expect(isPlain(100)).toBe(true);
		expect(isPlain(199)).toBe(true);
	});

	it("attaches a sized editor as plain text and styles the visible rows in the first frame", () => {
		const { attachedPlain, lineTypes, expectedTypes } = mountWindowed(LRC_LINES);
		expect(attachedPlain).toBe(true);
		expect(lineTypes(0)).toEqual(expectedTypes(0));
	});

	it("styles the rows a scroll brings into view before the next paint", () => {
		const { isPlain, lineTypes, expectedTypes, scrollTo, layer } = mountWindowed(LRC_LINES);
		scrollTo(1000);
		expect(layer.scrollTop).toBe(1000);
		for (const line of [99, 100, 102]) expect(lineTypes(line)).toEqual(expectedTypes(line));
		expect(isPlain(0)).toBe(true);
	});

	it("setFormat keeps the window: visible rows take the new format and far rows stay plain", () => {
		const { editor, isPlain, lineTypes, expectedTypes, scrollTo, layer } = mountWindowed(LRC_LINES);
		editor.setFormat("plain");
		scrollTo(1000);
		for (const line of [99, 100, 102]) expect(isPlain(line)).toBe(true);
		editor.setFormat("lrc");
		for (const line of [99, 100, 102]) expect(lineTypes(line)).toEqual(expectedTypes(line));
		for (const line of [0, 199]) expect(isPlain(line)).toBe(true);
		expect(layer.textContent).toBe(LRC_LINES);
	});

	it("does not restyle on a small scroll that stays inside the window", () => {
		const { layer, scrollTo } = mountWindowed(LRC_LINES);
		const before = [...layer.children[4].children];
		scrollTo(10);
		expect(layer.children[4].children).toEqual(before);
	});

	it("waits for scrolling to settle before recentring a window that still covers the visible rows", () => {
		const { isPlain, scrollTo, doc } = mountWindowed(LRC_LINES);
		expect(isPlain(7)).toBe(true);
		scrollTo(20);
		expect(isPlain(7)).toBe(true);
		doc.defaultView.flushFrames();
		expect(isPlain(7)).toBe(false);
	});

	it("measures no layout for a keystroke or a scroll that stays well inside the window", () => {
		const { layer, input, textarea, scrollTo } = mountWindowed(LRC_LINES);
		let measures = 0;
		const measure = layer.getBoundingClientRect;
		layer.getBoundingClientRect = () => {
			measures++;
			return measure();
		};
		input(textarea.value.replace("line 1\n", "line 1x\n"));
		scrollTo(5);
		expect(measures).toBe(0);
	});

	it("regression: survives emptying the document and scrolling", () => {
		const { input, scrollTo, layer, textarea } = mountWindowed(LRC_LINES);
		input("");
		scrollTo(40);
		expect(layer.textContent).toBe("");
		input(LRC_LINES);
		expect(layer.textContent).toBe(layerText(textarea.value));
	});

	it("measures again when a web font finishes loading, and stops listening on destroy", () => {
		const { layer, doc, textarea } = mountWindowed(LRC_LINES);
		let measures = 0;
		const measure = layer.getBoundingClientRect;
		layer.getBoundingClientRect = () => {
			measures++;
			return measure();
		};
		const fire = () => {
			for (const listener of doc.fonts.listeners.get("loadingdone") ?? []) listener();
			doc.defaultView.flushFrames();
		};
		fire();
		expect(measures).toBeGreaterThan(0);
		attachEditor(textarea as unknown as HTMLTextAreaElement).destroy();
		expect(doc.fonts.listeners.get("loadingdone")?.size ?? 0).toBe(0);
	});

	it("measures again when the textarea's text box changes", () => {
		const { layer, input, textarea } = mountWindowed(LRC_LINES);
		let measures = 0;
		const measure = layer.getBoundingClientRect;
		layer.getBoundingClientRect = () => {
			measures++;
			return measure();
		};
		textarea.computed = { "font-size": "20px" };
		input(textarea.value.replace("line 1\n", "line 1x\n"));
		expect(measures).toBeGreaterThan(0);
	});

	it("regression: keeps visible rows styled while lines are joined one newline at a time", () => {
		const { input, textarea, lineTypes, expectedTypes } = mountWindowed(LRC_LINES.split("\n").slice(0, 60).join("\n"));
		for (let step = 0; step < 40; step++) {
			const value = textarea.value;
			const at = value.indexOf("\n");
			input(value.slice(0, at) + value.slice(at + 1));
			for (const line of [0, 1, 2]) expect(lineTypes(line)).toEqual(expectedTypes(line));
		}
	});

	it("regression: windows a document typed into an editor attached empty", () => {
		const { input, isPlain, lineTypes, expectedTypes } = mountWindowed("");
		input(LRC_LINES);
		expect(isPlain(150)).toBe(true);
		expect(lineTypes(1)).toEqual(expectedTypes(1));
	});

	it("regression: windows a document pasted after deleting everything", () => {
		const { input, isPlain, lineTypes, expectedTypes } = mountWindowed(LRC_LINES);
		input("");
		input(LRC_LINES);
		expect(isPlain(150)).toBe(true);
		expect(lineTypes(1)).toEqual(expectedTypes(1));
	});

	it("measures again after an edit large enough to pull unstyled text into view", () => {
		const { input, textarea, lineTypes, expectedTypes } = mountWindowed(LRC_LINES);
		const value = textarea.value;
		input(value.slice(0, value.indexOf("[00:03.00]")) + value.slice(value.indexOf("[00:00.00]line 60")));
		for (const line of [0, 3, 4, 5]) expect(lineTypes(line)).toEqual(expectedTypes(line));
	});

	it("edits a far plain row in place without styling it", () => {
		const { layer, isPlain, input, textarea } = mountWindowed(LRC_LINES);
		const node = layer.children[150].children[0];
		input(textarea.value.replace("line 150", "line 150 edited"));
		expect(isPlain(150)).toBe(true);
		expect(layer.children[150].children[0]).toBe(node);
		expect(layer.textContent).toBe(layerText(textarea.value));
	});

	it("keeps its window while hidden and measures again when shown", () => {
		const { isPlain, textarea, doc, lineTypes, expectedTypes, layer } = mountWindowed(LRC_LINES);
		const resize = () => {
			for (const observer of doc.defaultView.observers) if (observer.connected) observer.callback();
			doc.defaultView.flushFrames();
		};
		doc.layerHeight = 0;
		resize();
		expect(isPlain(150)).toBe(true);
		textarea.value = `${LRC_LINES}\n`;
		const editor = attachEditor(textarea as unknown as HTMLTextAreaElement);
		editor.refresh();
		doc.defaultView.flushFrames();
		expect(isPlain(150)).toBe(true);
		doc.layerHeight = 30;
		textarea.scrollTop = 1000;
		layer.scrollTop = 1000;
		resize();
		for (const line of [100, 101, 102]) expect(lineTypes(line)).toEqual(expectedTypes(line));
		expect(isPlain(150)).toBe(true);
	});

	describe("invariants", () => {
		it("keeps the text exact and the visible rows coloured like a full render through random edits and scrolls", () => {
			let seed = 7;
			const random = () => {
				seed = (seed * 1103515245 + 12345) % 2147483648;
				return seed / 2147483648;
			};
			const SNIPPETS = ["x", "\n", "\n\n", "[00:01.00]", "<00:02.00>", "v1:", "[ti:", "]"];
			const { textarea, layer, input, scrollTo, lineTypes, expectedTypes } = mountWindowed(LRC_LINES, 4);
			for (let step = 0; step < 150; step++) {
				const value = textarea.value;
				const at = Math.floor(random() * (value.length + 1));
				const roll = random();
				if (roll < 0.45) input(value.slice(0, at) + SNIPPETS[Math.floor(random() * SNIPPETS.length)] + value.slice(at));
				else if (roll < 0.8) input(value.slice(0, at) + value.slice(at + Math.floor(random() * 120)));
				else if (roll < 0.83) input(LRC_LINES);
				else scrollTo(Math.floor(random() * layer.children.length) * 10);
				expect(layer.textContent).toBe(layerText(textarea.value));
				const first = Math.floor(layer.scrollTop / 10);
				for (let line = first; line < Math.min(layer.children.length, first + 4); line++)
					expect(lineTypes(line)).toEqual(expectedTypes(line));
			}
		});
	});
});

// -- Style window on one wrapped line --------------------------

const LONG_ONE_LINE = ONE_LINE.replace(
	"<body>",
	`<body>${'<p begin="00:05.000" end="00:06.000"><span begin="00:05.000" end="00:05.500">la</span><span ttm:role="x-bg">ooh</span></p>'.repeat(120)}`,
);
const ROWS = 3;
const PER_ROW = 40;

describe("attachEditor style window on one wrapped line", () => {
	const visibleChars = (layer: FakeNode) => {
		const first = Math.floor(layer.scrollTop / 10) * PER_ROW;
		return [first, first + ROWS * PER_ROW];
	};

	it("styles every visible character and leaves text far outside the window plain, wherever it scrolls", () => {
		const { layer, scrollTo, doc, charTypes, expectedCharTypes } = mountWindowed(LONG_ONE_LINE, ROWS, PER_ROW);
		const rows = Math.ceil(LONG_ONE_LINE.length / PER_ROW);
		for (const row of [0, 40, 41, Math.floor(rows / 2), 120, rows - ROWS, 7]) {
			scrollTo(row * 10);
			doc.defaultView.flushFrames();
			const got = charTypes(0);
			const want = expectedCharTypes(0);
			const [from, to] = visibleChars(layer);
			for (let at = from; at < Math.min(to, want.length); at++) expect(got[at]).toBe(want[at]);
			const margin = 3 * ROWS * PER_ROW;
			for (let at = 0; at < got.length; at++) if (at < from - margin || at >= to + margin) expect(got[at]).toBe("text");
		}
	});

	it("regression: keeps the visible characters styled through many small deletions", () => {
		const { layer, input, textarea, charTypes, expectedCharTypes } = mountWindowed(LONG_ONE_LINE, ROWS, PER_ROW);
		for (let step = 0; step < 300; step++) {
			const value = textarea.value;
			input(value.slice(0, 60) + value.slice(61));
			const got = charTypes(0);
			const want = expectedCharTypes(0);
			const [from, to] = visibleChars(layer);
			for (let k = from; k < Math.min(to, want.length); k++) expect(got[k]).toBe(want[k]);
		}
	});
});
