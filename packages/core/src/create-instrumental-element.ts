const SVG_NS = "http://www.w3.org/2000/svg";

const INSTRUMENTAL_CLASS = "braccato--instrumental";
const ICON_CLASS = "braccato--instrumental-icon";
const BG_CLASS = "braccato--instrumental-bg";
const FILL_CLASS = "braccato--instrumental-fill";
const WAVE_CLIP_CLASS = "braccato--wave-clip";
const WAVE_RECT_CLASS = "braccato--wave-rect";
const WAVE_PATH_CLASS = "braccato--wave-path";

const NOTE_PATH =
	"M10 21q-1.65 0-2.825-1.175T6 17t1.175-2.825T10 13q.575 0 1.063.138t.937.412V4q0-.425.288-.712T13 3h4q.425 0 .713.288T18 4v2q0 .425-.288.713T17 7h-3v10q0 1.65-1.175 2.825T10 21";

export function createInstrumentalElement(durationMs: number, lineIndex: number): HTMLDivElement {
	const container = document.createElement("div");
	container.classList.add(INSTRUMENTAL_CLASS);
	container.style.setProperty("--braccato-duration", `${durationMs}ms`);

	const svg = document.createElementNS(SVG_NS, "svg");
	svg.classList.add(ICON_CLASS);
	svg.setAttribute("viewBox", "0 0 24 24");

	const defs = document.createElementNS(SVG_NS, "defs");

	const filterId = `braccato-glow-${lineIndex}`;
	const clipId = `braccato-wave-clip-${lineIndex}`;

	const filter = document.createElementNS(SVG_NS, "filter");
	filter.setAttribute("id", filterId);
	filter.setAttribute("x", "-100%");
	filter.setAttribute("y", "-100%");
	filter.setAttribute("width", "300%");
	filter.setAttribute("height", "300%");

	const feGaussianBlur = document.createElementNS(SVG_NS, "feGaussianBlur");
	feGaussianBlur.setAttribute("in", "SourceGraphic");
	feGaussianBlur.setAttribute("stdDeviation", "5");
	feGaussianBlur.setAttribute("result", "blur");
	filter.appendChild(feGaussianBlur);

	const feColorMatrix = document.createElementNS(SVG_NS, "feColorMatrix");
	feColorMatrix.setAttribute("in", "blur");
	feColorMatrix.setAttribute("type", "matrix");
	feColorMatrix.setAttribute("values", "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.6 0");
	feColorMatrix.setAttribute("result", "fadedBlur");
	filter.appendChild(feColorMatrix);

	const feMerge = document.createElementNS(SVG_NS, "feMerge");
	const feMergeNode1 = document.createElementNS(SVG_NS, "feMergeNode");
	feMergeNode1.setAttribute("in", "fadedBlur");
	feMerge.appendChild(feMergeNode1);
	const feMergeNode2 = document.createElementNS(SVG_NS, "feMergeNode");
	feMergeNode2.setAttribute("in", "SourceGraphic");
	feMerge.appendChild(feMergeNode2);
	filter.appendChild(feMerge);

	defs.appendChild(filter);

	const clipPath = document.createElementNS(SVG_NS, "clipPath");
	clipPath.setAttribute("id", clipId);
	clipPath.classList.add(WAVE_CLIP_CLASS);

	const waveRect = document.createElementNS(SVG_NS, "path");
	waveRect.classList.add(WAVE_RECT_CLASS);
	waveRect.setAttribute("d", "M -4 3.9 L 30 3.9 L 30 30 L -4 30 Z");
	clipPath.appendChild(waveRect);

	const wavePath = document.createElementNS(SVG_NS, "path");
	wavePath.classList.add(WAVE_PATH_CLASS);
	wavePath.setAttribute("d", "M -4 3 Q 1 2 5 3 Q 10 4 14 3 Q 18 2 22 3 Q 26 4 30 3 L 30 4 L -4 4 Z");
	clipPath.appendChild(wavePath);

	defs.appendChild(clipPath);
	svg.appendChild(defs);

	const bgPath = document.createElementNS(SVG_NS, "path");
	bgPath.classList.add(BG_CLASS);
	bgPath.setAttribute("d", NOTE_PATH);
	svg.appendChild(bgPath);

	const g = document.createElementNS(SVG_NS, "g");
	g.setAttribute("filter", `url(#${filterId})`);

	const fillPath = document.createElementNS(SVG_NS, "path");
	fillPath.classList.add(FILL_CLASS);
	fillPath.setAttribute("clip-path", `url(#${clipId})`);
	fillPath.setAttribute("d", NOTE_PATH);
	g.appendChild(fillPath);

	svg.appendChild(g);
	container.appendChild(svg);

	return container;
}
