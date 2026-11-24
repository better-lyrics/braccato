//! Draws a line's slots into a 2D canvas once, for upload as the line's texture.
//!
//! The browser's own text engine does the drawing, so shaping, fallback fonts and hinting match the
//! page. Text is drawn as coverage in the red channel, which the shader tints; glyphs with colours of
//! their own (emoji) are drawn as they are. Nothing is blurred here: glows and blurred lines are
//! blurred on the GPU from the same texture (see `gpu.rs`), at whatever radius they have that frame.

use crate::dom;
use crate::layout::{Ink, LineLayout, Placement, Rect, TextRun};
use crate::theme::TextShadow;
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{CanvasRenderingContext2d, HtmlCanvasElement, Path2d};

/// The note's outline in its 24-unit view box (Material Symbols "music_note").
const NOTE_PATH: &str = "M10 21q-1.65 0-2.825-1.175T6 17t1.175-2.825T10 13q.575 0 1.063.138t.937.412V4q0-.425.288-.712T13 3h4q.425 0 .713.288T18 4v2q0 .425-.288.713T17 7h-3v10q0 1.65-1.175 2.825T10 21";

const MAX_TEXTURE_WIDTH: f32 = 4096.0;
/// How far left of a shadow its text is drawn, in CSS pixels: past any slot's clip.
const SHADOW_AWAY_PX: f32 = 100_000.0;
const GAP: f32 = 2.0;

pub struct Rasterizer {
    canvas: HtmlCanvasElement,
    context: CanvasRenderingContext2d,
    note: Option<Path2d>,
    /// Whether the context has `filter` (not before Safari 18).
    has_filter: bool,
    /// Images the view has loaded, by address, for image highlights.
    pub images: std::collections::HashMap<String, web_sys::HtmlImageElement>,
}

impl Rasterizer {
    /// Draws with a canvas of `doc`, whose fonts it resolves text against.
    pub fn new(doc: &web_sys::Document) -> Rasterizer {
        let canvas: HtmlCanvasElement = doc.create_element("canvas").unwrap().unchecked_into();
        let context: CanvasRenderingContext2d = canvas.get_context("2d").unwrap().unwrap().unchecked_into();
        let has_filter = js_sys::Reflect::has(context.as_ref(), &JsValue::from_str("filter")).unwrap_or(false);
        Rasterizer {
            canvas,
            context,
            note: Path2d::new_with_path_string(NOTE_PATH).ok(),
            has_filter,
            images: Default::default(),
        }
    }

    /// Packs and draws every slot of `layout`, recording where each landed. Returns the canvas to
    /// upload, or `None` when the line has nothing to draw.
    pub fn draw_line(&mut self, layout: &mut LineLayout, dpr: f32) -> Option<&HtmlCanvasElement> {
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
                    self.text_layer(runs, "#ffffff");
                    ctx.set_global_composite_operation("lighter").ok();
                }
                Ink::Text(runs) => self.text_layer(runs, "#ff0000"),
                Ink::Note => self.note(slot.rect),
                Ink::NoteText(text, font) => self.note_text(slot.rect, text, font),
                Ink::Dots => self.dots(slot.rect),
                Ink::NoteImage(url) => {
                    ctx.set_global_composite_operation("source-over").ok();
                    self.note_image(slot.rect, dpr, url);
                    ctx.set_global_composite_operation("lighter").ok();
                }
                Ink::Pill { radius, solid } => self.pill(slot.rect, *radius, *solid),
                Ink::Shadow(runs, shadows) => {
                    ctx.set_global_composite_operation("source-over").ok();
                    self.shadows(runs, shadows, dpr);
                    ctx.set_global_composite_operation("lighter").ok();
                }
            }
            ctx.restore();
        }
        Some(&self.canvas)
    }

    /// Draws `runs` as coverage in `channel`.
    fn text_layer(&self, runs: &[TextRun], channel: &str) {
        let ctx = &self.context;
        ctx.set_fill_style_str(channel);
        for run in runs {
            ctx.set_font(&run.font);
            set_optional(ctx, "direction", if run.rtl { "rtl" } else { "ltr" });
            set_optional(ctx, "letterSpacing", &run.letter_spacing);
            set_optional(ctx, "lang", if run.lang.is_empty() { "inherit" } else { &run.lang });
            if let Some(clip) = run.clip {
                ctx.save();
                ctx.begin_path();
                ctx.rect(clip.x as f64, clip.y as f64 - clip.h as f64, clip.w as f64, clip.h as f64 * 3.0);
                ctx.clip();
            }
            let _ = ctx.fill_text(&run.text, run.x as f64, run.baseline as f64);
            if run.clip.is_some() {
                ctx.restore();
            }
        }
    }

    /// The runs' shadows in their own colours, without the runs: the text is drawn far to the left,
    /// outside the slot's clip, and its shadow offset back to where the text is. The last shadow is
    /// drawn first, so the first is on top, as in CSS. Shadow lengths are in texture pixels: the
    /// context's transform does not scale them.
    fn shadows(&self, runs: &[TextRun], shadows: &[TextShadow], dpr: f32) {
        let ctx = &self.context;
        let away = SHADOW_AWAY_PX as f64;
        ctx.set_fill_style_str("#000");
        for shadow in shadows.iter().rev() {
            ctx.set_shadow_color("transparent");
            ctx.set_shadow_color(&shadow.color);
            ctx.set_shadow_offset_x(shadow.x as f64 * dpr as f64 + away * dpr as f64);
            ctx.set_shadow_offset_y(shadow.y as f64 * dpr as f64);
            ctx.set_shadow_blur(shadow.blur as f64 * dpr as f64);
            for run in runs {
                ctx.set_font(&run.font);
                set_optional(ctx, "direction", if run.rtl { "rtl" } else { "ltr" });
                set_optional(ctx, "letterSpacing", &run.letter_spacing);
                set_optional(ctx, "lang", if run.lang.is_empty() { "inherit" } else { &run.lang });
                if let Some(clip) = run.clip {
                    // A joined run is cut to its word; the shadow of that cut spreads past it.
                    let reach = shadow.reach();
                    ctx.save();
                    ctx.begin_path();
                    ctx.rect(
                        (clip.x - reach) as f64,
                        (clip.y - clip.h - reach) as f64,
                        (clip.w + 2.0 * reach) as f64,
                        (clip.h * 3.0 + 2.0 * reach) as f64,
                    );
                    ctx.clip();
                }
                let _ = ctx.fill_text(&run.text, run.x as f64 - away, run.baseline as f64);
                if run.clip.is_some() {
                    ctx.restore();
                }
            }
        }
        ctx.set_shadow_color("transparent");
        ctx.set_shadow_blur(0.0);
        ctx.set_shadow_offset_x(0.0);
        ctx.set_shadow_offset_y(0.0);
    }

    /// The theme's text in the note's square, as coverage, centred on it.
    fn note_text(&self, square: Rect, text: &str, font: &str) {
        let ctx = &self.context;
        ctx.set_font(font);
        set_optional(ctx, "letterSpacing", "0px");
        ctx.set_text_align("center");
        ctx.set_text_baseline("middle");
        ctx.set_fill_style_str("#ff0000");
        let _ = ctx.fill_text(text, (square.x + square.w / 2.0) as f64, (square.y + square.h / 2.0) as f64);
        ctx.set_text_align("left");
        ctx.set_text_baseline("alphabetic");
    }

    /// Three dots across `rect`, each as tall as it, as coverage.
    fn dots(&self, rect: Rect) {
        let ctx = &self.context;
        let d = rect.h;
        let gap = (rect.w - 3.0 * d) / 2.0;
        ctx.set_fill_style_str("#ff0000");
        for i in 0..3 {
            ctx.begin_path();
            let cx = rect.x + d / 2.0 + i as f32 * (d + gap);
            let _ = ctx.arc((cx) as f64, (rect.y + d / 2.0) as f64, (d / 2.0) as f64, 0.0, std::f64::consts::TAU);
            ctx.fill();
        }
    }

    fn note(&self, square: Rect) {
        let Some(path) = &self.note else { return };
        let ctx = &self.context;
        let unit = square.h / 24.0;
        ctx.save();
        ctx.translate(square.x as f64, square.y as f64).ok();
        ctx.scale(unit as f64, unit as f64).ok();
        ctx.set_fill_style_str("#ff0000");
        ctx.fill_with_path_2d(path);
        ctx.restore();
    }

    /// The note's image fill: the image stretched over the note's 24-unit view box and cut to its
    /// silhouette, over a one-unit blur of itself, which is the glow the DOM renderer gave it (the
    /// image's own colours blurred, not a tint). The shader cuts both to the rising fill.
    fn note_image(&self, square: Rect, dpr: f32, url: &str) {
        let (Some(path), Some(image)) = (&self.note, self.images.get(url)) else { return };
        // Cut to the silhouette on a canvas of its own first, so the blur spreads past the cut.
        let side = (square.h * dpr).ceil().max(1.0);
        let doc = dom::doc_of(&self.canvas);
        let scratch: HtmlCanvasElement = doc.create_element("canvas").unwrap().unchecked_into();
        scratch.set_width(side as u32);
        scratch.set_height(side as u32);
        let Some(sctx) = scratch.get_context("2d").ok().flatten() else { return };
        let sctx: CanvasRenderingContext2d = sctx.unchecked_into();
        sctx.scale((side / 24.0) as f64, (side / 24.0) as f64).ok();
        sctx.clip_with_path_2d(path);
        let _ = sctx.draw_image_with_html_image_element_and_dw_and_dh(image, 0.0, 0.0, 24.0, 24.0);

        let ctx = &self.context;
        let (x, y, w, h) = (square.x as f64, square.y as f64, square.w as f64, square.h as f64);
        if self.has_filter {
            // Filter lengths are in texture pixels; the glow is one view-box unit.
            ctx.set_filter(&format!("blur({}px)", square.h / 24.0 * dpr));
            let _ = ctx.draw_image_with_html_canvas_element_and_dw_and_dh(&scratch, x, y, w, h);
            ctx.set_filter("none");
        }
        let _ = ctx.draw_image_with_html_canvas_element_and_dw_and_dh(&scratch, x, y, w, h);
    }

    /// The romanization's background, as coverage the shader tints. A `solid` one is filled in
    /// the theme's colour. The default has a border, and a fill a third of it, matching 5% and 10%
    /// white over the line.
    fn pill(&self, rect: Rect, radius: f32, solid: bool) {
        let ctx = &self.context;
        let radius = radius.min(rect.h / 2.0) as f64;
        ctx.begin_path();
        round_rect(ctx, rect.x as f64, rect.y as f64, rect.w as f64, rect.h as f64, radius);
        ctx.set_fill_style_str(if solid { "rgb(255 0 0)" } else { "rgb(255 0 0 / 0.345)" });
        ctx.fill();
        if solid {
            return;
        }
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
