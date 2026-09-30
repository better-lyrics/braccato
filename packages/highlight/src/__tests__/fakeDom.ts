type Listener = () => void;

export interface FakeNode {
	nodeName: string;
	className: string;
	textContent: string;
	children: FakeNode[];
	parent: FakeNode | null;
	ownerDocument: FakeDocument;
	value: string;
	scrollTop: number;
	scrollLeft: number;
	computed: Record<string, string>;
	listeners: Map<string, Set<Listener>>;
	classList: { add(name: string): void; remove(name: string): void; contains(name: string): boolean };
	style: { setProperty(prop: string, value: string): void; getPropertyValue(prop: string): string };
	replaceChildren(...nodes: FakeNode[]): void;
	append(...nodes: FakeNode[]): void;
	before(...nodes: FakeNode[]): void;
	remove(): void;
	setAttribute(name: string, value: string): void;
	getAttribute(name: string): string | null;
	removeAttribute(name: string): void;
	addEventListener(type: string, listener: Listener): void;
	removeEventListener(type: string, listener: Listener): void;
	dispatch(type: string): void;
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
}

export interface FakeDocument {
	defaultView: FakeWindow;
	createElement(tag: string): FakeNode;
	createTextNode(text: string): FakeNode;
	createDocumentFragment(): FakeNode;
}

export function createFakeDocument(): FakeDocument {
	const observers: FakeResizeObserver[] = [];
	const view: FakeWindow = {
		observers,
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
	};
	function detach(child: FakeNode): void {
		if (!child.parent) return;
		const siblings = child.parent.children;
		siblings.splice(siblings.indexOf(child), 1);
		child.parent = null;
	}
	function node(nodeName: string, text: string): FakeNode {
		const attributes = new Map<string, string>();
		const style = new Map<string, string>();
		const classes = () => n.className.split(/\s+/).filter(Boolean);
		const n: FakeNode = {
			nodeName,
			className: "",
			textContent: text,
			children: [],
			parent: null,
			ownerDocument: doc,
			value: "",
			scrollTop: 0,
			scrollLeft: 0,
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
				n.textContent = n.children.map((c) => c.textContent).join("");
			},
			append(...nodes) {
				for (const node of nodes) {
					const incoming = node.nodeName === "#document-fragment" ? node.children.splice(0) : [node];
					for (const child of incoming) {
						detach(child);
						child.parent = n;
						n.children.push(child);
					}
				}
			},
			before(...nodes) {
				const parent = n.parent;
				if (!parent) return;
				for (const child of nodes) {
					detach(child);
					child.parent = parent;
					parent.children.splice(parent.children.indexOf(n), 0, child);
				}
			},
			remove() {
				detach(n);
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
