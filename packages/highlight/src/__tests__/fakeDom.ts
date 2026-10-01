type Listener = () => void;

export interface FakeNode {
	nodeName: string;
	className: string;
	textContent: string;
	children: FakeNode[];
	readonly firstChild: FakeNode | null;
	parent: FakeNode | null;
	readonly parentNode: FakeNode | null;
	ownerDocument: FakeDocument;
	value: string;
	scrollTop: number;
	scrollLeft: number;
	clientHeight: number;
	clientTop: number;
	getBoundingClientRect(): FakeRect;
	computed: Record<string, string>;
	listeners: Map<string, Set<Listener>>;
	classList: { add(name: string): void; remove(name: string): void; contains(name: string): boolean };
	style: { setProperty(prop: string, value: string): void; getPropertyValue(prop: string): string };
	replaceChildren(...nodes: FakeNode[]): void;
	append(...nodes: FakeNode[]): void;
	before(...nodes: FakeNode[]): void;
	insertBefore(node: FakeNode, reference: FakeNode | null): FakeNode;
	remove(): void;
	data: string;
	setAttribute(name: string, value: string): void;
	getAttribute(name: string): string | null;
	removeAttribute(name: string): void;
	addEventListener(type: string, listener: Listener): void;
	removeEventListener(type: string, listener: Listener): void;
	dispatch(type: string): void;
}

export interface FakeRect {
	top: number;
	bottom: number;
	left: number;
	right: number;
	width: number;
	height: number;
}

export interface FakeRange {
	setStart(node: FakeNode, offset: number): void;
	setEnd(node: FakeNode, offset: number): void;
	selectNode(node: FakeNode): void;
	getBoundingClientRect(): FakeRect;
}

export interface FakeResizeObserver {
	observed: FakeNode[];
	connected: boolean;
	callback: Listener;
}

export interface FakeWindow {
	observers: FakeResizeObserver[];
	getComputedStyle(el: FakeNode): { getPropertyValue(prop: string): string };
	ResizeObserver: new (callback: Listener) => { observe(el: FakeNode): void; disconnect(): void };
	requestAnimationFrame(callback: Listener): number;
	cancelAnimationFrame(id: number): void;
	setTimeout(callback: Listener, delay: number): number;
	clearTimeout(id: number): void;
	/** Runs every pending animation frame and timer. */
	flushFrames(): void;
}

export interface FakeDocument {
	defaultView: FakeWindow;
	createElement(tag: string): FakeNode;
	createTextNode(text: string): FakeNode;
	createDocumentFragment(): FakeNode;
	createRange(): FakeRange;
	/** Opt-in layout: every bh-line is one row of this height, so rows map to lines. */
	rowHeight: number;
	/** The clientHeight every bh-layer reports unless a test sets its own. */
	layerHeight: number;
}

export function createFakeDocument(): FakeDocument {
	const observers: FakeResizeObserver[] = [];
	const frames = new Map<number, Listener>();
	let frameId = 0;
	const view: FakeWindow = {
		observers,
		requestAnimationFrame(callback) {
			frames.set(++frameId, callback);
			return frameId;
		},
		cancelAnimationFrame(id) {
			frames.delete(id);
		},
		setTimeout(callback) {
			frames.set(++frameId, callback);
			return frameId;
		},
		clearTimeout(id) {
			frames.delete(id);
		},
		flushFrames() {
			for (let round = 0; frames.size > 0; round++) {
				if (round === 100) throw new Error("frames keep scheduling frames");
				const pending = [...frames.values()];
				frames.clear();
				for (const callback of pending) callback();
			}
		},
		getComputedStyle: (el) => ({ getPropertyValue: (prop) => el.computed[prop] ?? "" }),
		ResizeObserver: class {
			private record: FakeResizeObserver;
			constructor(callback: Listener) {
				this.record = { observed: [], connected: true, callback };
				observers.push(this.record);
			}
			observe(el: FakeNode) {
				this.record.observed.push(el);
			}
			disconnect() {
				this.record.connected = false;
			}
		},
	};
	const doc: FakeDocument = {
		defaultView: view,
		createElement: (tag) => node(tag.toUpperCase(), ""),
		createTextNode: (text) => node("#text", text),
		createDocumentFragment: () => node("#document-fragment", ""),
		createRange: () => {
			let start: FakeNode | null = null;
			return {
				setStart: (node) => {
					start = node;
				},
				setEnd: () => {},
				selectNode: (node) => {
					start = node;
				},
				getBoundingClientRect: () => (start ? start.getBoundingClientRect() : rect(0, 0)),
			};
		},
		rowHeight: 0,
		layerHeight: 0,
	};
	const rect = (top: number, height: number): FakeRect => ({
		top,
		bottom: top + height,
		left: 0,
		right: 100,
		width: 100,
		height,
	});
	function layout(n: FakeNode): FakeRect {
		if (!doc.rowHeight) return rect(0, 0);
		if (n.classList.contains("bh-layer")) return rect(0, n.clientHeight);
		let line: FakeNode | null = n;
		while (line && !line.classList.contains("bh-line")) line = line.parent;
		if (!line?.parent) return rect(0, 0);
		const row = line.parent.children.indexOf(line);
		return rect(row * doc.rowHeight - line.parent.scrollTop, doc.rowHeight);
	}
	function detach(child: FakeNode): void {
		if (!child.parent) return;
		const siblings = child.parent.children;
		const index = siblings.indexOf(child);
		if (index >= 0) siblings.splice(index, 1);
		child.parent = null;
	}
	function expand(nodes: FakeNode[]): FakeNode[] {
		return nodes.flatMap((node) => (node.nodeName === "#document-fragment" ? node.children.splice(0) : [node]));
	}
	function node(nodeName: string, text: string): FakeNode {
		let data = text;
		let height: number | undefined;
		const attributes = new Map<string, string>();
		const style = new Map<string, string>();
		const classes = () => n.className.split(/\s+/).filter(Boolean);
		const n: FakeNode = {
			nodeName,
			className: "",
			get textContent() {
				return nodeName === "#text" ? data : n.children.map((c) => c.textContent).join("");
			},
			set textContent(value: string) {
				if (nodeName === "#text") data = value;
				else n.replaceChildren(...(value ? [doc.createTextNode(value)] : []));
			},
			children: [],
			get firstChild() {
				return n.children[0] ?? null;
			},
			parent: null,
			get parentNode() {
				return n.parent;
			},
			ownerDocument: doc,
			value: "",
			scrollTop: 0,
			scrollLeft: 0,
			get clientHeight() {
				return height ?? (n.classList.contains("bh-layer") ? doc.layerHeight : 0);
			},
			set clientHeight(value: number) {
				height = value;
			},
			clientTop: 0,
			getBoundingClientRect: () => layout(n),
			computed: {},
			listeners: new Map(),
			classList: {
				add: (name) => {
					if (!classes().includes(name)) n.className = [...classes(), name].join(" ");
				},
				remove: (name) => {
					n.className = classes()
						.filter((c) => c !== name)
						.join(" ");
				},
				contains: (name) => classes().includes(name),
			},
			style: {
				setProperty: (prop, value) => style.set(prop, value),
				getPropertyValue: (prop) => style.get(prop) ?? "",
			},
			replaceChildren(...nodes) {
				for (const child of n.children) child.parent = null;
				n.children = [];
				n.append(...nodes);
			},
			append(...nodes) {
				for (const child of expand(nodes)) {
					detach(child);
					child.parent = n;
					n.children.push(child);
				}
			},
			insertBefore(child, reference) {
				if (reference === null) n.append(child);
				else reference.before(child);
				return child;
			},
			before(...nodes) {
				const parent = n.parent;
				if (!parent) return;
				for (const child of expand(nodes)) {
					detach(child);
					child.parent = parent;
					parent.children.splice(parent.children.indexOf(n), 0, child);
				}
			},
			remove() {
				detach(n);
			},
			get data() {
				return nodeName === "#text" ? data : "";
			},
			set data(value: string) {
				if (nodeName !== "#text") throw new Error("data needs a text node");
				data = value;
			},
			setAttribute: (name, value) => attributes.set(name, value),
			getAttribute: (name) => attributes.get(name) ?? null,
			removeAttribute: (name) => attributes.delete(name),
			addEventListener(type, listener) {
				const set = n.listeners.get(type) ?? new Set();
				set.add(listener);
				n.listeners.set(type, set);
			},
			removeEventListener(type, listener) {
				n.listeners.get(type)?.delete(listener);
			},
			dispatch(type) {
				for (const listener of n.listeners.get(type) ?? []) listener();
			},
		};
		return n;
	}
	return doc;
}
