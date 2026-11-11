// Optional image paint for the instrumental note, independent of HDR: a theme supplies the image and
// its dynamic range.
import { registerThemeSetting } from "./themeSettings";

export const imageHighlights = registerThemeSetting("blyrics-image-highlights", false, true);

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
