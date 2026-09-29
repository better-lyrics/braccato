import { imageHighlights } from "./imageHighlights";

export const INSTRUMENTAL_WAVE_PATH_HIGH = "M -4 3 Q 1 2 5 3 Q 10 4 14 3 Q 18 2 22 3 Q 26 4 30 3 L 30 4 L -4 4 Z";
export const INSTRUMENTAL_WAVE_PATH_LOW = "M -4 3 Q 1 4 5 3 Q 10 2 14 3 Q 18 4 22 3 Q 26 2 30 3 L 30 4 L -4 4 Z";

let nextInstrumentalId = 0;

/**
 * Creates an HTML element representing an instrumental break in the lyrics.
 *
 * @param doc - Document the SVG nodes are created in
 * @param container - Element to place instrumental parts into
 * @param durationMs - Duration of the instrumental break in milliseconds
 * @returns HTMLDivElement representing the instrumental break
 */
export function createInstrumentalElement(
  doc: Document,
  container: HTMLDivElement,
  durationMs: number
): HTMLDivElement {
  container.classList.add("blyrics--instrumental");
  container.style.setProperty("--blyrics-duration", `${durationMs}ms`);

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(svgNS, "svg");
  svg.classList.add("blyrics--instrumental-icon");
  svg.setAttribute("viewBox", "0 0 24 24");

  const defs = doc.createElementNS(svgNS, "defs");

  // Unique per document, not per view: two renderers sharing a document would otherwise resolve
  // each other's url(#id) references.
  const idSuffix = nextInstrumentalId++;
  const filterId = `blyrics-glow-${idSuffix}`;
  const clipId = `blyrics-wave-clip-${idSuffix}`;

  const filter = doc.createElementNS(svgNS, "filter");
  filter.setAttribute("id", filterId);
  filter.setAttribute("x", "-100%");
  filter.setAttribute("y", "-100%");
  filter.setAttribute("width", "300%");
  filter.setAttribute("height", "300%");

  const feGaussianBlur = doc.createElementNS(svgNS, "feGaussianBlur");
  feGaussianBlur.setAttribute("in", "SourceGraphic");
  feGaussianBlur.setAttribute("stdDeviation", "5");
  feGaussianBlur.setAttribute("result", "blur");
  filter.appendChild(feGaussianBlur);

  const feColorMatrix = doc.createElementNS(svgNS, "feColorMatrix");
  feColorMatrix.setAttribute("in", "blur");
  feColorMatrix.setAttribute("type", "matrix");
  feColorMatrix.setAttribute("values", "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.6 0");
  feColorMatrix.setAttribute("result", "fadedBlur");
  filter.appendChild(feColorMatrix);

  const feMerge = doc.createElementNS(svgNS, "feMerge");
  const feMergeNode1 = doc.createElementNS(svgNS, "feMergeNode");
  feMergeNode1.setAttribute("in", "fadedBlur");
  feMerge.appendChild(feMergeNode1);
  const feMergeNode2 = doc.createElementNS(svgNS, "feMergeNode");
  feMergeNode2.setAttribute("in", "SourceGraphic");
  feMerge.appendChild(feMergeNode2);
  filter.appendChild(feMerge);

  defs.appendChild(filter);

  const clipPath = doc.createElementNS(svgNS, "clipPath");
  clipPath.setAttribute("id", clipId);
  clipPath.classList.add("blyrics--wave-clip");

  //  Create the Static Block (The deep fill)
  // This sits at y=4 (the lowest point of the wave) and extends to bottom
  const waveRect = doc.createElementNS(svgNS, "path");
  waveRect.classList.add("blyrics--wave-rect");
  waveRect.setAttribute("d", "M -4 3.9 L 30 3.9 L 30 30 L -4 30 Z");
  clipPath.appendChild(waveRect);

  // Create the Wavy Top
  // This only contains the surface water. It closes at y=4.
  const wavePath = doc.createElementNS(svgNS, "path");
  wavePath.classList.add("blyrics--wave-path");
  wavePath.setAttribute("d", INSTRUMENTAL_WAVE_PATH_HIGH);
  clipPath.appendChild(wavePath);

  defs.appendChild(clipPath);
  svg.appendChild(defs);

  const bgPath = doc.createElementNS(svgNS, "path");
  bgPath.classList.add("blyrics--instrumental-bg");
  bgPath.setAttribute(
    "d",
    "M10 21q-1.65 0-2.825-1.175T6 17t1.175-2.825T10 13q.575 0 1.063.138t.937.412V4q0-.425.288-.712T13 3h4q.425 0 .713.288T18 4v2q0 .425-.288.713T17 7h-3v10q0 1.65-1.175 2.825T10 21"
  );
  svg.appendChild(bgPath);

  const g = doc.createElementNS(svgNS, "g");
  g.setAttribute("filter", `url(#${filterId})`);

  const fillPath = doc.createElementNS(svgNS, "path");
  fillPath.classList.add("blyrics--instrumental-fill");
  fillPath.setAttribute("clip-path", `url(#${clipId})`);
  fillPath.setAttribute(
    "d",
    "M10 21q-1.65 0-2.825-1.175T6 17t1.175-2.825T10 13q.575 0 1.063.138t.937.412V4q0-.425.288-.712T13 3h4q.425 0 .713.288T18 4v2q0 .425-.288.713T17 7h-3v10q0 1.65-1.175 2.825T10 21"
  );
  if (imageHighlights.getBooleanValue()) {
    // Fade the common group so both the image and the SDR fallback follow the original
    // instrumental animation. The wave and silhouette clips are inside the glow filter.
    fillPath.classList.remove("blyrics--instrumental-fill");
    fillPath.classList.add("blyrics-instrumental-color");
    const fill = doc.createElementNS(svgNS, "g");
    fill.classList.add("blyrics--instrumental-fill");
    fill.appendChild(fillPath);
    const shapeId = `${clipId}-image-shape`;
    const shape = doc.createElementNS(svgNS, "clipPath");
    shape.setAttribute("id", shapeId);
    const shapePath = doc.createElementNS(svgNS, "path");
    shapePath.setAttribute("d", fillPath.getAttribute("d")!);
    shape.appendChild(shapePath);
    defs.appendChild(shape);
    const silhouette = doc.createElementNS(svgNS, "g");
    silhouette.setAttribute("clip-path", `url(#${shapeId})`);
    const wave = doc.createElementNS(svgNS, "g");
    wave.setAttribute("clip-path", `url(#${clipId})`);
    const image = doc.createElementNS(svgNS, "image");
    image.classList.add("blyrics-instrumental-image");
    image.setAttribute("x", "0");
    image.setAttribute("y", "0");
    image.setAttribute("width", "24");
    image.setAttribute("height", "24");
    image.setAttribute("preserveAspectRatio", "none");
    wave.appendChild(image);
    silhouette.appendChild(wave);
    fill.appendChild(silhouette);
    g.appendChild(fill);
    // Blur RGB directly instead of recoloring the halo with an SDR flood/shadow.
    filter.setAttribute("color-interpolation-filters", "sRGB");
    feGaussianBlur.setAttribute("stdDeviation", "1");
    filter.removeChild(feColorMatrix);
    feMergeNode1.setAttribute("in", "blur");
  } else {
    g.appendChild(fillPath);
  }

  svg.appendChild(g);
  container.appendChild(svg);

  return container;
}
