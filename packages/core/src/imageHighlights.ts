// Optional image paint, independent of HDR: a theme supplies the image and its dynamic range.
// The extra layer exists only when requested. Blur surrounds the already-masked paint, so it
// cannot be cut off by the karaoke mask. Both copies are driven by the engine's own animations.
import { registerThemeSetting } from "./themeSettings";
import type { PartData } from "./inject";

export const imageHighlights = registerThemeSetting("blyrics-image-highlights", false, true);

export interface ImageHighlightLayers {
  glow: HTMLElement;
  glowLetters: HTMLElement[];
  /** A separate inline layout host, only for runs that can fragment. */
  highlight?: HTMLElement;
}

export function wrapImageHighlight(highlight: HTMLElement): ImageHighlightLayers | undefined {
  if (!imageHighlights.getBooleanValue()) return;
  const doc = highlight.ownerDocument;
  const paint = doc.createElement("span");
  paint.classList.add("blyrics-image-fill");
  while (highlight.firstChild) paint.appendChild(highlight.firstChild);
  const glow = doc.createElement("span");
  glow.classList.add("blyrics-image-glow");
  glow.setAttribute("aria-hidden", "true");
  glow.appendChild(paint.cloneNode(true));
  highlight.classList.add("blyrics-image-highlight");
  highlight.appendChild(glow);
  highlight.appendChild(paint);
  return { glow, glowLetters: Array.from(glow.querySelectorAll<HTMLElement>(".blyrics--letter")) };
}

/** Keep bidi ordering and inline fragments in the browser's normal text layout. An
 * absolutely positioned copy inside an inline word cannot reproduce those fragments. */
export function alignImageGlowRun(run: HTMLElement, parts: PartData[]): void {
  if (!imageHighlights.getBooleanValue()) return;
  if (
    !run.parentElement?.classList.contains("blyrics-bidi-sensitive") &&
    !run.querySelector(".blyrics-word-group-long")
  )
    return;
  const originals = Array.from(run.querySelectorAll<HTMLElement>(".blyrics-word-highlight"));
  const byHighlight = new Map(parts.map(part => [part.highlightElement, part]));
  const glowRun = run.cloneNode(true) as HTMLElement;
  glowRun.classList.add("blyrics-image-glow-run");
  const copies = glowRun.querySelectorAll<HTMLElement>(".blyrics-word-highlight");
  originals.forEach((original, index) => {
    const part = byHighlight.get(original);
    if (!part?.imageLayers) return;
    const copy = copies[index];
    copy.replaceChildren(part.imageLayers.glow);
    part.imageLayers.highlight = copy;
    // Non-fragmented groups in a mixed run can still wobble. Give their glow the
    // identical group transform, rather than letting it drift from the sharp copy.
    const group = original.parentElement;
    if (group && part.wobbleElements.includes(group) && copy.parentElement)
      part.wobbleElements.push(copy.parentElement);
  });
  run.parentElement!.insertBefore(glowRun, run);
}

/** A single CSS url(), not gradients or an arbitrary list of background layers. */
export function imageURL(value: string): string | null {
  const match = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s'"()]+))\s*\)$/i.exec(value.trim());
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

// SVG <image> follows the browser's normal image drawing path, including gain maps. feImage
// and SVG patterns can rasterize through an SDR intermediate. Keep the original color path
// available until loading succeeds, and whenever a theme's media query supplies no image.
export function refreshInstrumentalImages(container: HTMLElement | null, view: Window): void {
  if (!container || !imageHighlights.getBooleanValue()) return;
  for (const svg of container.querySelectorAll<SVGSVGElement>(".blyrics--instrumental-icon")) {
    const image = svg.querySelector<SVGImageElement>(".blyrics-instrumental-image");
    if (!image) continue;
    const source = imageURL(view.getComputedStyle(svg).getPropertyValue("--blyrics-highlight-image"));
    if (source === image.getAttribute("href")) continue;
    svg.removeAttribute("data-image-ready");
    image.onload = () => {
      if (image.getAttribute("href") === source) svg.setAttribute("data-image-ready", "");
    };
    image.onerror = () => svg.removeAttribute("data-image-ready");
    if (source) image.setAttribute("href", source);
    else image.removeAttribute("href");
  }
}
