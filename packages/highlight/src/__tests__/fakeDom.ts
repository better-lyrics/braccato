export interface FakeNode {
	nodeName: string;
	className: string;
	textContent: string;
	children: FakeNode[];
	ownerDocument: FakeDocument;
	replaceChildren(...nodes: FakeNode[]): void;
}

export interface FakeDocument {
	createElement(tag: string): FakeNode;
	createTextNode(text: string): FakeNode;
}

export function createFakeDocument(): FakeDocument {
	const doc: FakeDocument = {
		createElement: (tag) => node(tag.toUpperCase(), ""),
		createTextNode: (text) => node("#text", text),
	};
	function node(nodeName: string, text: string): FakeNode {
		const n: FakeNode = {
			nodeName,
			className: "",
			textContent: text,
			children: [],
			ownerDocument: doc,
			replaceChildren(...nodes) {
				n.children = nodes;
				n.textContent = nodes.map((c) => c.textContent).join("");
			},
		};
		return n;
	}
	return doc;
}
