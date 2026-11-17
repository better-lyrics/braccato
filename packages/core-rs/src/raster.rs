//! Draws a line's slots into a 2D canvas once, for upload as the line's texture.
//!
//! The browser's own text engine does the drawing, so shaping, fallback fonts and hinting match the
//! page. The three colour channels hold three images of the same text, added together with the
//! `lighter` composite so they do not disturb each other:
//!
//! - red: the text itself,
//! - green: the text blurred to the glow's full radius,
//! - blue: the text blurred to `TIGHT_HALO_FRACTION` of it.
//!
//! The shader blends between them to draw a glow of any radius in between, which is how the glow
//! shrinks from its full size to nothing without redrawing anything.

use crate::dom;
use crate::gpu::TIGHT_HALO_FRACTION;
use crate::layout::{Ink, LineLayout, Placement, Rect, TextRun};
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{CanvasRenderingContext2d, HtmlCanvasElement, Path2d};

/// The note's outline in its 24-unit view box (Material Symbols "music_note").
const NOTE_PATH: &str = "M10 21q-1.65 0-2.825-1.175T6 17t1.175-2.825T10 13q.575 0 1.063.138t.937.412V4q0-.425.288-.712T13 3h4q.425 0 .713.288T18 4v2q0 .425-.288.713T17 7h-3v10q0 1.65-1.175 2.825T10 21";

/// The fill's glow in the DOM renderer was an SVG blur with a standard deviation of 5 view-box units.
const NOTE_GLOW_UNITS: f32 = 5.0;

/// Where a canvas has no `filter`, the shadow blur that comes closest to a Gaussian of a given
/// standard deviation, as measured against Chrome's `drop-shadow()`.
const SHADOW_BLUR_PER_SIGMA: f64 = 1.75;

/// Shadows are drawn from a copy of the shape this far off-canvas, so only the blur lands.
const SHADOW_THROW: f64 = 20000.0;

const MAX_TEXTURE_WIDTH: f32 = 4096.0;
const GAP: f32 = 2.0;

pub struct Rasterizer {
    canvas: HtmlCanvasElement,
    context: CanvasRenderingContext2d,
    note: Option<Path2d>,
    /// Whether the context has `filter` (not before Safari 18).
    has_filter: bool,
}

impl Rasterizer {
    pub fn new() -> Rasterizer {
        let canvas: HtmlCanvasElement = dom::document().create_element("canvas").unwrap().unchecked_into();
        let context: CanvasRenderingContext2d = canvas.get_context("2d").unwrap().unwrap().unchecked_into();
        let has_filter = js_sys::Reflect::has(context.as_ref(), &JsValue::from_str("filter")).unwrap_or(false);
        Rasterizer { canvas, context, note: Path2d::new_with_path_string(NOTE_PATH).ok(), has_filter }
    }

    /// Packs and draws every slot of `layout`, recording where each landed. Returns the canvas to
    /// upload, or `None` when the line has nothing to draw.
    pub fn draw_line(&mut self, layout: &mut LineLayout, dpr: f32, glow_radius_px: f32) -> Option<&HtmlCanvasElement> {
        if layout.slots.is_empty() {
            return None;
        }
        let (width, height) = pack(layout, dpr);
        self.canvas.set_width(width as u32);
        self.canvas.set_height(height as u32);
        let ctx = &self.context;
        ctx.set_global_composite_operation("lighter").ok();
        ctx.set_text_align("left");
        ctx.set_text_baseline("alphabetic");

        for slot in &layout.slots {
            let Placement { tex, origin } = slot.placement;
            let region = Rect {
                x: tex.0,
                y: tex.1,
                w: ((slot.rect.right() + slot.margin) * dpr).ceil() - origin.0,
                h: ((slot.rect.bottom() + slot.margin) * dpr).ceil() - origin.1,
            };
            ctx.save();
            ctx.begin_path();
            ctx.rect(region.x as f64, region.y as f64, region.w as f64, region.h as f64);
            ctx.clip();
            // Line coordinates to texture pixels.
            let (dx, dy) = ((tex.0 - origin.0) as f64, (tex.1 - origin.1) as f64);
            ctx.set_transform(dpr as f64, 0.0, 0.0, dpr as f64, dx, dy).ok();
            match &slot.ink {
                Ink::Text(runs) if slot.color => {
                    // Emoji keep their colours: drawn plainly, white where the font leaves it to us.
                    ctx.set_global_composite_operation("source-over").ok();
                    self.text_layer(runs, "#ffffff", None);
                    ctx.set_global_composite_operation("lighter").ok();
                }
                Ink::Text(runs) => {
                    self.text_layer(runs, "#ff0000", None);
                    if slot.halo {
                        // The glow was a CSS `drop-shadow()`, whose length is the blur's standard
                        // deviation.
                        self.text_layer(runs, "#00ff00", Some(glow_radius_px * dpr));
                        self.text_layer(runs, "#0000ff", Some(glow_radius_px * TIGHT_HALO_FRACTION * dpr));
                    }
                }
                Ink::Note => self.note(slot.rect, dpr),
                Ink::Pill { radius } => self.pill(slot.rect, *radius),
            }
            ctx.restore();
        }
        Some(&self.canvas)
    }

    /// From here on, draw only a blur of each shape, in `channel`, with standard deviation `sigma`
    /// texture pixels. Returns how far left, in drawing units, shapes must be drawn.
    ///
    /// Where the canvas has `filter`, the shape is drawn in place through `blur()`, which is the same
    /// Gaussian as the `drop-shadow()` the glow was in CSS. Otherwise the shape is drawn off the
    /// canvas and only its shadow lands, thrown back by the shadow offset.
    fn start_blur(&self, channel: &str, sigma: f32) -> f64 {
        let ctx = &self.context;
        if self.has_filter {
            // Filter lengths ignore the transform, so this is in texture pixels.
            ctx.set_filter(&format!("blur({sigma}px)"));
            ctx.set_fill_style_str(channel);
            return 0.0;
        }
        // Shadow offsets ignore the transform too.
        let scale = ctx.get_transform().map(|m| m.a()).unwrap_or(1.0);
        ctx.set_shadow_color(channel);
        ctx.set_shadow_blur(sigma as f64 * SHADOW_BLUR_PER_SIGMA);
        ctx.set_shadow_offset_x(SHADOW_THROW * scale);
        ctx.set_fill_style_str("#000000");
        SHADOW_THROW
    }

    fn end_blur(&self) {
        let ctx = &self.context;
        ctx.set_filter("none");
        ctx.set_shadow_color("transparent");
        ctx.set_shadow_blur(0.0);
        ctx.set_shadow_offset_x(0.0);
    }

    /// Draws `runs` into one channel: as solid text, or as only its blur with standard deviation
    /// `blur` texture pixels.
    fn text_layer(&self, runs: &[TextRun], channel: &str, blur: Option<f32>) {
        let ctx = &self.context;
        let throw = match blur {
            Some(sigma) => self.start_blur(channel, sigma),
            None => {
                ctx.set_fill_style_str(channel);
                0.0
            }
        };
        for run in runs {
            ctx.set_font(&run.font);
            set_optional(ctx, "direction", if run.rtl { "rtl" } else { "ltr" });
            set_optional(ctx, "letterSpacing", &run.letter_spacing);
            set_optional(ctx, "lang", if run.lang.is_empty() { "inherit" } else { &run.lang });
            let clipped = run.clip.is_some() && blur.is_none();
            if let (Some(clip), true) = (run.clip, clipped) {
                ctx.save();
                ctx.begin_path();
                ctx.rect(clip.x as f64, clip.y as f64 - clip.h as f64, clip.w as f64, clip.h as f64 * 3.0);
                ctx.clip();
            }
            let _ = ctx.fill_text(&run.text, run.x as f64 - throw, run.baseline as f64);
            if clipped {
                ctx.restore();
            }
        }
        if blur.is_some() {
            self.end_blur();
        }
    }

    fn note(&self, square: Rect, dpr: f32) {
        let Some(path) = &self.note else { return };
        let ctx = &self.context;
        let unit = square.h / 24.0;
        ctx.save();
        ctx.translate(square.x as f64, square.y as f64).ok();
        ctx.scale(unit as f64, unit as f64).ok();
        ctx.set_fill_style_str("#ff0000");
        ctx.fill_with_path_2d(path);
        let throw = self.start_blur("#00ff00", NOTE_GLOW_UNITS * unit * dpr);
        ctx.translate(-throw, 0.0).ok();
        ctx.fill_with_path_2d(path);
        self.end_blur();
        ctx.restore();
    }

    /// The romanization's background and border, as coverage the shader tints: the border is
    /// opaque and the fill a third of it, matching 5% and 10% white over the line.
    fn pill(&self, rect: Rect, radius: f32) {
        let ctx = &self.context;
        let radius = radius.min(rect.h / 2.0) as f64;
        ctx.begin_path();
        round_rect(ctx, rect.x as f64, rect.y as f64, rect.w as f64, rect.h as f64, radius);
        ctx.set_fill_style_str("rgb(255 0 0 / 0.345)");
        ctx.fill();
        ctx.begin_path();
        round_rect(
            ctx,
            rect.x as f64 + 0.5,
            rect.y as f64 + 0.5,
            rect.w as f64 - 1.0,
            rect.h as f64 - 1.0,
            (radius - 0.5).max(0.0),
        );
        ctx.set_stroke_style_str("rgb(255 0 0 / 0.655)");
        ctx.set_line_width(1.0);
        ctx.stroke();
    }
}

impl Default for Rasterizer {
    fn default() -> Self {
        Rasterizer::new()
    }
}

fn round_rect(ctx: &CanvasRenderingContext2d, x: f64, y: f64, w: f64, h: f64, r: f64) {
    ctx.move_to(x + r, y);
    ctx.arc_to(x + w, y, x + w, y + h, r).ok();
    ctx.arc_to(x + w, y + h, x, y + h, r).ok();
    ctx.arc_to(x, y + h, x, y, r).ok();
    ctx.arc_to(x, y, x + w, y, r).ok();
    ctx.close_path();
}

/// Context properties not every engine has (`letterSpacing`, `lang`): set when present.
fn set_optional(ctx: &CanvasRenderingContext2d, key: &str, value: &str) {
    let target: &JsValue = ctx.as_ref();
    if js_sys::Reflect::has(target, &JsValue::from_str(key)).unwrap_or(false) {
        dom::set(target, key, &JsValue::from_str(value));
    }
}

/// Shelf-packs the slots of a line, rows left to right. Each slot's origin is a whole device pixel
/// in line space so that, drawn at rest, every texel lands on one device pixel.
fn pack(layout: &mut LineLayout, dpr: f32) -> (f32, f32) {
    let mut sizes: Vec<(f32, f32, f32, f32)> = Vec::with_capacity(layout.slots.len());
    for slot in &layout.slots {
        let ox = ((slot.rect.x - slot.margin) * dpr).floor();
        let oy = ((slot.rect.y - slot.margin) * dpr).floor();
        let w = ((slot.rect.right() + slot.margin) * dpr).ceil() - ox;
        let h = ((slot.rect.bottom() + slot.margin) * dpr).ceil() - oy;
        sizes.push((ox, oy, w, h));
    }
    let widest = sizes.iter().map(|s| s.2).fold(0.0, f32::max);
    let shelf_width = MAX_TEXTURE_WIDTH.min(widest.max(sizes.iter().map(|s| s.2 + GAP).sum::<f32>())).max(widest);
    let (mut x, mut y, mut shelf_height, mut used_width) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    for (slot, (ox, oy, w, h)) in layout.slots.iter_mut().zip(sizes) {
        if x > 0.0 && x + w > shelf_width {
            x = 0.0;
            y += shelf_height + GAP;
            shelf_height = 0.0;
        }
        slot.placement = Placement { tex: (x, y), origin: (ox, oy) };
        x += w + GAP;
        used_width = used_width.max(x);
        shelf_height = shelf_height.max(h);
    }
    (used_width.max(1.0), (y + shelf_height).max(1.0))
}
