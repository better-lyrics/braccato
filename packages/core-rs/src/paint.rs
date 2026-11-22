//! What every line looks like at a given moment, as quads.
//!
//! Everything here is a pure function of the lyric time, the wall clock and a line's phase, so a
//! frame can be drawn for any moment without replaying what came before. That is also what makes a
//! seek land in the right pose with no catching up.
//!
//! A word is drawn as one quad per piece (a letter, or the whole word), which mixes its inactive and
//! lit colours across a ramp that is the sweep's edge. Under it, while the word is held, one quad
//! draws its glow: a drop shadow of the lit text whose radius shrinks to nothing, as the DOM renderer
//! drew it before the halos were split out.

use crate::easing::Easing;
use crate::gpu::Quad;
use crate::layout::{Glyph, LineLayout, Owner, Rect, Rgba, Slot};
use crate::model::SyncType;
use crate::song::{Line, Part};
use crate::theme::{Motion, Theme};

/// Where a line is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum Phase {
    /// Drawn in the inactive colour at rest.
    #[default]
    Idle,
    /// Being sung, or about to be: everything follows the lyric clock.
    Live,
    /// Its time is over: the lit words fade out and the line shrinks back, on the wall clock.
    Exiting { since_ms: f64, lyric_s: f32 },
}

/// The moment being drawn.
#[derive(Clone, Copy, Debug)]
pub struct Moment {
    /// Lyric time, seconds.
    pub lyric: f32,
    /// Wall clock, milliseconds.
    pub now_ms: f64,
    pub sync: SyncType,
}

/// Where a line sits on the canvas this frame.
#[derive(Clone, Copy, Debug)]
pub struct Placement {
    /// The line box's top-left on the canvas, CSS pixels, before scaling.
    pub x: f32,
    pub y: f32,
    pub dpr: f32,
    /// Opacity applied to the whole line.
    pub opacity: f32,
    /// How far the decorations' entry has run, 0 to 1.
    pub entry: f32,
    /// The scale the pointer draws the line toward, and how far, 0 to 1.
    pub hover_scale: (f32, f32),
}

const DECORATION_EASE: Easing = Easing::Bezier(0.25, 1.0, 0.5, 1.0);

/// How long the exit takes, after which the line is idle again.
pub fn exit_ms(theme: &Theme) -> f64 {
    let fade = if theme.animate_fade { theme.fade_out_s } else { 0.001 };
    (fade.max(theme.scale_duration_s) * 1000.0) as f64
}

fn premultiply(color: Rgba, alpha: f32) -> [f32; 4] {
    let a = color[3] * alpha;
    [color[0] * a, color[1] * a, color[2] * a, a]
}

fn mix(a: Rgba, b: Rgba, t: f32) -> Rgba {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]
}

/// A uniform scale and translation about a point, applied to rects.
#[derive(Clone, Copy, Debug)]
struct Affine {
    sx: f32,
    sy: f32,
    tx: f32,
    ty: f32,
}

impl Affine {
    /// `motion` about `centre`, with em lengths resolved against `em`.
    fn about(centre: (f32, f32), motion: Motion, em: f32) -> Affine {
        let (dx, dy) = motion.offset_px(em);
        Affine {
            sx: motion.sx,
            sy: motion.sy,
            tx: centre.0 * (1.0 - motion.sx) + dx,
            ty: centre.1 * (1.0 - motion.sy) + dy,
        }
    }

    fn scale_about(centre: (f32, f32), scale: f32) -> Affine {
        Affine { sx: scale, sy: scale, tx: centre.0 * (1.0 - scale), ty: centre.1 * (1.0 - scale) }
    }

    /// `self` after `inner`.
    fn then(self, inner: Affine) -> Affine {
        Affine {
            sx: self.sx * inner.sx,
            sy: self.sy * inner.sy,
            tx: self.sx * inner.tx + self.tx,
            ty: self.sy * inner.ty + self.ty,
        }
    }

    fn rect(&self, r: Rect) -> Rect {
        Rect { x: r.x * self.sx + self.tx, y: r.y * self.sy + self.ty, w: r.w * self.sx, h: r.h * self.sy }
    }
}

fn centre(r: &Rect) -> (f32, f32) {
    (r.x + r.w / 2.0, r.y + r.h / 2.0)
}

/// The line's scale this moment.
pub fn line_scale(line: &Line, phase: Phase, moment: Moment, theme: &Theme) -> f32 {
    let rest = theme.rest_scale;
    if !theme.animate_line_scale {
        return rest;
    }
    let duration = theme.scale_duration_s.max(0.001);
    match phase {
        Phase::Idle => rest,
        Phase::Live => {
            let t = (moment.lyric - line.start_s) / duration;
            if t < 0.0 {
                rest
            } else {
                rest + (theme.active_scale - rest) * theme.enter_easing.at(t)
            }
        }
        Phase::Exiting { since_ms, .. } => {
            let t = ((moment.now_ms - since_ms) / 1000.0) as f32 / duration;
            theme.active_scale + (rest - theme.active_scale) * theme.exit_easing.at(t)
        }
    }
}

/// How a word looks this moment, before geometry.
#[derive(Clone, Copy, Debug)]
struct WordLook {
    /// Opacity of the lit copy of the word.
    lit: f32,
    /// Where the sweep's start stop is, in word widths. Large when the word is wholly lit.
    edge: f32,
    /// Glow radius as a fraction of its full radius, and its strength; zero for none.
    glow: f32,
    glow_alpha: f32,
}

const ALL_LIT: f32 = 1e6;

fn word_look(part: &Part, phase: Phase, moment: Moment, theme: &Theme, glow_color: Rgba) -> WordLook {
    let none = WordLook { lit: 0.0, edge: ALL_LIT, glow: 0.0, glow_alpha: 0.0 };
    if moment.sync == SyncType::None {
        return none;
    }
    match phase {
        Phase::Idle => none,
        Phase::Exiting { since_ms, lyric_s } => {
            if part.start_s > lyric_s {
                return none;
            }
            let fade = if theme.animate_fade {
                theme.fade_out_easing.at(((moment.now_ms - since_ms) / 1000.0) as f32 / theme.fade_out_s)
            } else {
                1.0
            };
            WordLook { lit: 1.0 - fade, edge: ALL_LIT, glow: 0.0, glow_alpha: 0.0 }
        }
        Phase::Live => {
            let t = moment.lyric - part.start_s;
            if t < 0.0 {
                return none;
            }
            let swept = !part.line_synced && part.duration_s > 0.0;
            let lit = if swept {
                1.0
            } else if theme.animate_fade {
                theme.fade_in_easing.at(t / theme.fade_in_s)
            } else {
                1.0
            };
            let edge = if swept && theme.animate_swipe {
                let d = part.duration_s;
                let lead = theme.settings.swipe_lead_ratio * d;
                let swipe = (theme.settings.swipe_duration_ratio * d).max(1e-4);
                let progress = theme.swipe_easing.at((t + lead) / swipe);
                theme.swipe_start_from + (theme.swipe_start_to - theme.swipe_start_from) * progress
            } else {
                ALL_LIT
            };
            // The glow: one drop shadow on the lit word, shrinking from its full radius.
            let span = if swept {
                (part.duration_s * theme.glow_duration_ratio).max(theme.glow_min_s)
            } else {
                theme.glow_min_s
            };
            let (glow, glow_alpha) =
                if theme.animate_glow && glow_color[3] > 0.0 && (t < span || !theme.glow_rests_invisible) {
                    let shrink = theme.glow_easing.at(t / span);
                    (1.0 - shrink, glow_color[3] * lit)
                } else {
                    (0.0, 0.0)
                };
            WordLook { lit, edge, glow, glow_alpha }
        }
    }
}

/// A keyframed motion: (offset, value, easing to the next), offsets in eased progress.
fn keyframes(frames: &[(f32, Motion, Easing)], progress: f32) -> Motion {
    if progress <= frames[0].0 {
        return frames[0].1;
    }
    for pair in frames.windows(2) {
        let (from, to) = (&pair[0], &pair[1]);
        if progress <= to.0 {
            let span = (to.0 - from.0).max(1e-6);
            return Motion::lerp(from.1, to.1, from.2.at((progress - from.0) / span));
        }
    }
    frames[frames.len() - 1].1
}

/// The word wobble on a group, started by its first word.
fn wobble(first: &Part, group_long: bool, phase: Phase, moment: Moment, theme: &Theme) -> Motion {
    if !theme.animate_wobble || group_long || phase != Phase::Live || moment.sync == SyncType::None {
        return Motion::IDENTITY;
    }
    let t = moment.lyric - first.start_s;
    if t < 0.0 {
        return Motion::IDENTITY;
    }
    let progress = theme.wobble_easing.at(t / theme.wobble_s);
    let settle = theme.wobble_settle_offset.max(theme.wobble_peak_offset);
    keyframes(
        &[
            (0.0, theme.wobble_from, Easing::Linear),
            (theme.wobble_peak_offset, theme.wobble_peak, theme.wobble_peak_easing),
            (settle, theme.wobble_settle, Easing::Linear),
            (1.0, theme.wobble_to, Easing::Linear),
        ],
        progress,
    )
}

/// The letter wave on letter `index` of `count`: each letter rises to its crest as the sweep
/// finishes lighting it, then settles a little below.
fn letter_wave(part: &Part, index: u16, count: u16, phase: Phase, moment: Moment, theme: &Theme) -> Motion {
    if !theme.animate_wobble || !part.lettered || phase != Phase::Live || moment.sync == SyncType::None {
        return Motion::IDENTITY;
    }
    let wave_ms = theme.wave_s * 1000.0;
    let rise_ms = 0.4 * wave_ms;
    let (delay_ms, duration_ms) = if part.line_synced || part.duration_s <= 0.0 {
        (0.0, wave_ms)
    } else {
        let d = part.duration_s * 1000.0;
        let n = count.max(1) as f32;
        let i = index as f32;
        let swipe = theme.settings.swipe_duration_ratio * d;
        let lead = theme.settings.swipe_lead_ratio * d;
        let end_span = (theme.swipe_end_to - theme.swipe_end_from).max(1e-6);
        let start_span = (theme.swipe_start_to - theme.swipe_start_from).max(1e-6);
        let begin = (swipe * ((i / n) - theme.swipe_end_from) / end_span).clamp(0.0, swipe);
        let finish = (swipe * (((i + 1.0) / n) - theme.swipe_start_from) / start_span).clamp(0.0, swipe);
        let touched = begin - lead;
        let lighting = (finish - begin).max(1.0);
        if lighting > rise_ms {
            (touched, lighting / 0.4)
        } else {
            (touched + lighting - rise_ms, wave_ms)
        }
    };
    let local = (moment.lyric - part.start_s) * 1000.0 - delay_ms;
    if local < 0.0 {
        return Motion::IDENTITY;
    }
    let emphasis = if part.long_word { theme.wave_emphasis_scale } else { 1.0 };
    let crest = Motion { sx: emphasis, sy: emphasis, ..theme.wave_crest };
    keyframes(
        &[
            (0.0, Motion::IDENTITY, theme.wave_rise_easing),
            (0.4, crest, theme.wave_fall_easing),
            (1.0, theme.wave_settle, Easing::Linear),
        ],
        local / duration_ms,
    )
}

fn uv_of(slot: &Slot, rect: Rect, dpr: f32) -> [f32; 4] {
    let p = slot.placement;
    [
        rect.x * dpr - p.origin.0 + p.tex.0,
        rect.y * dpr - p.origin.1 + p.tex.1,
        rect.right() * dpr - p.origin.0 + p.tex.0,
        rect.bottom() * dpr - p.origin.1 + p.tex.1,
    ]
}

fn to_canvas(rect: Rect, placement: &Placement) -> [f32; 4] {
    [rect.x + placement.x, rect.y + placement.y, rect.w, rect.h]
}

/// The sweep's ramp across one glyph: 1 behind the edge, 0 ahead of it, soft over the swipe's fade.
fn sweep_ramp(slot: &Slot, glyph: &Glyph, edge: f32, fade: f32, dpr: f32) -> [f32; 4] {
    if edge >= ALL_LIT {
        return [0.0, 0.0, 1.0, 0.0];
    }
    let u_of = |x: f32| x * dpr - slot.placement.origin.0 + slot.placement.tex.0;
    let (x0, x1) = (glyph.sweep.x0, glyph.sweep.x1.max(glyph.sweep.x0 + 1e-3));
    let value = |x: f32| (edge + fade - glyph.sweep.at(x)) / fade;
    let (u0, u1) = (u_of(x0), u_of(x1));
    let k = (value(x1) - value(x0)) / (u1 - u0);
    [k, 0.0, value(x0) - k * u0, 0.0]
}

/// Something drawn blurred: quads from the line's texture, and the blur's standard deviation in CSS
/// pixels. The renderer blurs them on the GPU and draws the result under the line.
pub struct Blur {
    pub quads: Vec<Quad>,
    pub sigma: f32,
}

/// Draws one line into `out`, and what of it glows into `blurs`.
#[allow(clippy::too_many_arguments)]
pub fn paint_line(
    out: &mut Vec<Quad>,
    blurs: &mut Vec<Blur>,
    line: &Line,
    layout: &LineLayout,
    phase: Phase,
    moment: Moment,
    placement: Placement,
    theme: &Theme,
) {
    let scale = line_scale(line, phase, moment, theme);
    let (hover_to, hovered) = placement.hover_scale;
    let scale = scale + (hover_to - scale) * hovered;
    let line_affine = Affine::scale_about((layout.origin_x, layout.height / 2.0), scale);
    let dpr = placement.dpr;
    // Lines at rest are drawn on whole device pixels, so their texels land one to one.
    let mut placement = placement;
    if (scale - 1.0).abs() < 1e-4 {
        placement.x = (placement.x * dpr).round() / dpr;
        placement.y = (placement.y * dpr).round() / dpr;
    }
    let fade = theme.swipe_fade();

    for slot in &layout.slots {
        match slot.owner {
            Owner::Part(index) => {
                let part = &line.parts[index];
                let style = &layout.parts[index];
                let group = &line.groups[part.group];
                let look = word_look(part, phase, moment, theme, style.glow);
                let group_rect = layout.groups.get(part.group).copied().unwrap_or(slot.rect);
                let wobble = wobble(&line.parts[group.parts[0]], group.long, phase, moment, theme);
                let word_affine = line_affine.then(Affine::about(centre(&group_rect), wobble, style.em));

                // Each letter's wave, which the glyphs and the glow under them both follow.
                let letters: Vec<Motion> = slot
                    .glyphs
                    .iter()
                    .map(|glyph| {
                        glyph
                            .letter
                            .map(|i| letter_wave(part, i, style.letters, phase, moment, theme))
                            .unwrap_or(Motion::IDENTITY)
                    })
                    .collect();
                let unlit = premultiply(style.inactive, placement.opacity);
                let lit = premultiply(mix(style.inactive, style.active, look.lit), placement.opacity);
                // The glow: one drop shadow of the lit part of the word, which is the word's own
                // letters, where they are, in the glow colour behind the sweep, blurred.
                let glowing = slot.halo && !slot.color && look.glow_alpha > 0.0 && look.glow > 0.0;
                let mut glow = Blur { quads: Vec::new(), sigma: theme.glow_radius_px * look.glow };
                let glow_color = premultiply(style.glow, look.glow_alpha / style.glow[3].max(1e-6) * placement.opacity);
                for (glyph, letter) in slot.glyphs.iter().zip(&letters) {
                    let affine = word_affine.then(Affine::about(centre(&glyph.rect), *letter, style.em));
                    let quad = Quad {
                        rect: to_canvas(affine.rect(glyph.rect), &placement),
                        uv: uv_of(slot, glyph.rect, dpr),
                        unlit,
                        lit,
                        ramp: sweep_ramp(slot, glyph, look.edge, fade, dpr),
                        wave: [0.0, 0.0, if slot.color { Quad::COLOR } else { Quad::TEXT }, 0.0],
                    };
                    if glowing {
                        glow.quads.push(Quad { unlit: [0.0; 4], lit: glow_color, ..quad });
                    }
                    out.push(quad);
                }
                if glowing {
                    blurs.push(glow);
                }
            }
            Owner::Note => push_note(out, blurs, slot, layout, line, phase, moment, line_affine, &placement, theme),
            // Drawn by `push_note`, with the note it fills.
            Owner::NoteImage => {}
            Owner::Pill | Owner::Translation | Owner::Romanization | Owner::Credits => {
                let color = match slot.owner {
                    Owner::Pill => layout.pill_color,
                    _ => layout.static_color,
                };
                // Decorations fade in and settle from 0.4em above when they first appear.
                let entry = if slot.owner == Owner::Credits { 1.0 } else { DECORATION_EASE.at(placement.entry) };
                let slide = Affine { sx: 1.0, sy: 1.0, tx: 0.0, ty: -0.4 * layout.static_em * (1.0 - entry) };
                let flat = premultiply(color, placement.opacity * entry);
                for glyph in &slot.glyphs {
                    out.push(Quad {
                        rect: to_canvas(line_affine.then(slide).rect(glyph.rect), &placement),
                        uv: uv_of(slot, glyph.rect, dpr),
                        unlit: flat,
                        lit: flat,
                        ramp: [0.0, 0.0, 1.0, 0.0],
                        wave: [0.0, 0.0, if slot.color { Quad::COLOR } else { Quad::TEXT }, 0.0],
                    });
                }
            }
        }
    }
}

/// The instrumental note: the inactive note, and over it the note filling up from the bottom behind
/// a rippling surface that flattens as it rises.
#[allow(clippy::too_many_arguments)]
fn push_note(
    out: &mut Vec<Quad>,
    blurs: &mut Vec<Blur>,
    slot: &Slot,
    layout: &LineLayout,
    line: &Line,
    phase: Phase,
    moment: Moment,
    affine: Affine,
    placement: &Placement,
    theme: &Theme,
) {
    let dpr = placement.dpr;
    let rect = slot.glyphs[0].rect;
    let uv = uv_of(slot, rect, dpr);
    let canvas_rect = to_canvas(affine.rect(rect), placement);
    let base = premultiply(layout.inactive, placement.opacity);
    out.push(Quad {
        rect: canvas_rect,
        uv,
        unlit: base,
        lit: base,
        ramp: [0.0, 0.0, 1.0, 0.0],
        wave: [0.0, 0.0, Quad::TEXT, 0.0],
    });

    // The fill's pose, in view-box units (the note spans y 3 to 21 of 24).
    let span = line.duration_s.max(0.001);
    let t = moment.lyric - line.start_s;
    let (opacity, rise, flat, toward_low) = match phase {
        Phase::Idle => return,
        Phase::Exiting { since_ms, .. } => {
            let fade = if theme.animate_fade && theme.animate_instrumental {
                theme.fade_out_easing.at(((moment.now_ms - since_ms) / 1000.0) as f32 / theme.fade_out_s)
            } else {
                1.0
            };
            (1.0 - fade, 0.0, 1.2, 0.0)
        }
        // Lines go live a little before they start, to be ready; the note fills only from its start.
        Phase::Live if theme.animate_instrumental && t < 0.0 => return,
        Phase::Live if theme.animate_instrumental => {
            let progress = (t / span).clamp(0.0, 1.0);
            let rise = 18.72 + (-0.96 - 18.72) * progress;
            let flat = 1.2 + (0.0001 - 1.2) * Easing::EASE_IN.at(progress);
            let cycle = (t / theme.instrumental_oscillation_s).rem_euclid(1.0);
            let toward_low = 1.0 - (2.0 * Easing::EASE_IN_OUT.at(cycle) - 1.0).abs();
            (1.0, rise, flat, toward_low)
        }
        Phase::Live => {
            let progress = ((t + 2.0) / span).clamp(0.0, 1.0);
            (1.0, -0.96 * progress, 1.2 * (1.0 - Easing::EASE_IN.at(progress)), 0.0)
        }
    };
    if opacity <= 0.0 {
        return;
    }
    // The surface: y = 4 + (wave(x) - 4) * flat + rise, with wave(x) = 3 - a * sin(pi (x + 4) / 8.5).
    let unit = rect.h / 24.0;
    let texels_per_unit = unit * dpr;
    let level = 4.0 - flat + rise;
    let amplitude = 0.5 * (1.0 - 2.0 * toward_low) * flat;
    let freq = std::f32::consts::PI / (8.5 * texels_per_unit);
    // How lit a texel of `slot` is: `slope` per view-box unit below the surface, plus `bias`.
    let surface_ramp = |slot: &Slot, slope: f32, bias: f32| -> ([f32; 4], [f32; 4]) {
        let p = slot.placement;
        // View-box x and y of texel (u, v).
        let ux0 = (-p.tex.0 + p.origin.0) / texels_per_unit - rect.x / unit;
        let vy0 = (-p.tex.1 + p.origin.1) / texels_per_unit - rect.y / unit;
        let phase_shift = std::f32::consts::PI * (ux0 + 4.0) / 8.5;
        ([0.0, slope / texels_per_unit, slope * (vy0 - level) + bias, slope * amplitude], [freq, phase_shift, 0.0, 0.0])
    };
    // The fill's surface is antialiased over one device pixel.
    let (ramp, wave) = surface_ramp(slot, texels_per_unit, 0.0);

    // With image highlights the fill is the image, glow and all, in its own colours.
    if let Some(image) = layout.slots.iter().find(|s| s.owner == Owner::NoteImage) {
        let (ramp, wave) = surface_ramp(image, texels_per_unit, 0.0);
        let outer = image.rect.expand(image.margin, image.margin);
        out.push(Quad {
            rect: to_canvas(affine.rect(outer), placement),
            uv: uv_of(image, outer, dpr),
            unlit: [0.0; 4],
            lit: [0.0, 0.0, 0.0, opacity * placement.opacity],
            ramp,
            wave: [wave[0], wave[1], Quad::COLOR, 0.0],
        });
        return;
    }
    let lit = premultiply(layout.active, opacity * placement.opacity);
    let fill = Quad { rect: canvas_rect, uv, unlit: [0.0; 4], lit, ramp, wave: [wave[0], wave[1], Quad::TEXT, 0.0] };
    // Its glow is the filled part blurred by 5 units, as the DOM renderer's SVG blur was. Until the
    // surface has reached the note there is nothing filled, and nothing glows.
    let lowest_surface = level - amplitude.abs();
    if lowest_surface < NOTE_BOTTOM_UNITS {
        let glow = premultiply(layout.active, 0.6 * opacity * placement.opacity);
        blurs.push(Blur { quads: vec![Quad { lit: glow, ..fill }], sigma: NOTE_GLOW_UNITS * unit });
    }
    out.push(fill);
}

/// The note's lowest point in its 24-unit view box, which the fill rises from.
const NOTE_BOTTOM_UNITS: f32 = 21.0;
/// The fill's glow in the DOM renderer was an SVG blur with a standard deviation of 5 view-box units.
const NOTE_GLOW_UNITS: f32 = 5.0;
