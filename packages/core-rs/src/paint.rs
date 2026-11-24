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
use crate::layout::{Glyph, Ink, LineLayout, Owner, PartStyle, Rect, Rgba, Slot};
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
    /// The inactive colour the pointer draws the line's words toward, and how far, 0 to 1.
    pub hover_color: Option<(Rgba, f32)>,
    /// The line's `saturate()` and `brightness()`, 1 for none.
    pub saturate: f32,
    pub brightness: f32,
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

/// The word wobble on a word or syllable sung from `start_s` for `duration_s`.
fn wobble(start_s: f32, duration_s: f32, group_long: bool, phase: Phase, moment: Moment, theme: &Theme) -> Motion {
    if !theme.animate_wobble || group_long || phase != Phase::Live || moment.sync == SyncType::None {
        return Motion::IDENTITY;
    }
    let t = moment.lyric - start_s;
    if t < 0.0 {
        return Motion::IDENTITY;
    }
    let length = theme.wobble_s + theme.wobble_duration_ratio * duration_s.max(0.0);
    let progress = theme.wobble_easing.at(t / length);
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
/// finishes lighting it, then settles a little below. `outward` is where the letter sits from the
/// word's centre, -1 for its leftmost letter to 1 for its rightmost, which the spread moves it along. Also
/// returns how near its crest the letter is, 0 to 1, which its glow peak follows.
fn letter_wave(
    part: &Part,
    index: u16,
    count: u16,
    outward: f32,
    phase: Phase,
    moment: Moment,
    theme: &Theme,
) -> (Motion, f32) {
    if !theme.animate_wobble || !part.lettered || phase != Phase::Live || moment.sync == SyncType::None {
        return (Motion::IDENTITY, 0.0);
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
        return (Motion::IDENTITY, 0.0);
    }
    // Only held words swell at the crest, whatever scale the crest transform has.
    let emphasis = if part.long_word { theme.wave_emphasis_scale } else { 1.0 };
    let mut crest = Motion { sx: emphasis, sy: emphasis, ..theme.wave_crest };
    if part.long_word {
        crest.tx_em += theme.wave_spread.tx_em * outward;
        crest.tx_px += theme.wave_spread.tx_px * outward;
    }
    let progress = local / duration_ms;
    let motion = keyframes(
        &[
            (0.0, Motion::IDENTITY, theme.wave_rise_easing),
            (0.4, crest, theme.wave_fall_easing),
            (1.0, theme.wave_settle, Easing::Linear),
        ],
        progress,
    );
    let near = if !part.long_word || theme.wave_glow == 0.0 {
        0.0
    } else if progress < 0.4 {
        theme.wave_rise_easing.at(progress / 0.4)
    } else {
        1.0 - theme.wave_fall_easing.at((progress - 0.4) / 0.6)
    };
    (motion, near)
}

/// Whether a part is timed word by word, which the rest pose and the past opacity need.
fn word_timed(part: &Part, moment: Moment) -> bool {
    moment.sync == SyncType::Richsync && !part.line_synced && part.duration_s > 0.0
}

/// How far a word has risen out of its rest pose at lyric time `lyric`, in its line being sung.
fn rise(part: &Part, lyric: f32, theme: &Theme) -> f32 {
    let t = lyric - part.start_s;
    if t < 0.0 {
        return 0.0;
    }
    theme.word_rise_easing.at(t / (part.duration_s + theme.word_rise_extra_s).max(1e-3))
}

/// The word's rest pose (`--blyrics-word-rest-transform`), as far as it holds this moment: whole
/// until the sung line reaches the word, gone once it has risen, and back as the line ends.
fn rest_pose(part: &Part, style: &PartStyle, phase: Phase, moment: Moment, theme: &Theme) -> Motion {
    if style.rest == Motion::IDENTITY || theme.reduced_motion || !word_timed(part, moment) {
        return Motion::IDENTITY;
    }
    let risen = match phase {
        Phase::Idle => 0.0,
        Phase::Live => rise(part, moment.lyric, theme),
        Phase::Exiting { since_ms, lyric_s } => rise(part, lyric_s, theme) * (1.0 - exit_fade(since_ms, moment, theme)),
    };
    Motion::lerp(style.rest, Motion::IDENTITY, risen)
}

/// How far a word has faded to its past opacity at lyric time `lyric`, in its line being sung.
fn past(part: &Part, lyric: f32, theme: &Theme) -> f32 {
    let t = lyric - part.start_s - part.duration_s;
    if t <= 0.0 {
        return 0.0;
    }
    if theme.animate_fade {
        theme.fade_out_easing.at(t / theme.fade_out_s)
    } else {
        1.0
    }
}

/// The opacity a word is drawn at for having been sung (`--blyrics-word-past-opacity`): 1 until
/// its time is over, easing to the past opacity, and back to 1 as the line ends.
fn past_opacity(part: &Part, style: &PartStyle, phase: Phase, moment: Moment, theme: &Theme) -> f32 {
    if style.past_opacity == 1.0 || !word_timed(part, moment) {
        return 1.0;
    }
    let faded = match phase {
        Phase::Idle => 0.0,
        Phase::Live => past(part, moment.lyric, theme),
        Phase::Exiting { since_ms, lyric_s } => past(part, lyric_s, theme) * (1.0 - exit_fade(since_ms, moment, theme)),
    };
    1.0 + (style.past_opacity - 1.0) * faded
}

/// How far a line's exit fade has run.
fn exit_fade(since_ms: f64, moment: Moment, theme: &Theme) -> f32 {
    if theme.animate_fade {
        theme.fade_out_easing.at(((moment.now_ms - since_ms) / 1000.0) as f32 / theme.fade_out_s)
    } else {
        1.0
    }
}

/// `color` through the line's `saturate()` and `brightness()`, as CSS filters apply them.
fn filtered(color: Rgba, placement: &Placement) -> Rgba {
    let (s, b) = (placement.saturate, placement.brightness);
    if s == 1.0 && b == 1.0 {
        return color;
    }
    let [r, g, bl, a] = color;
    let channel = |v: f32| (v * b).clamp(0.0, 1.0);
    [
        channel((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * bl),
        channel((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * bl),
        channel((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * bl),
        a,
    ]
}

/// The shadows of a text slot, in their own colours, under where its text is drawn.
fn push_shadow(under: &mut Vec<Quad>, slot: &Slot, affine: Affine, alpha: f32, placement: &Placement) {
    if alpha <= 0.0 {
        return;
    }
    let outer = slot.rect.expand(slot.margin, slot.margin);
    under.push(Quad {
        rect: to_canvas(affine.rect(outer), placement),
        uv: uv_of(slot, outer, placement.dpr),
        unlit: [0.0, 0.0, 0.0, alpha],
        lit: [0.0, 0.0, 0.0, alpha],
        ramp: [0.0, 0.0, 1.0, 0.0],
        wave: [0.0, 0.0, Quad::COLOR, 0.0],
    });
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

/// Draws one line into `out`, its text-shadows into `under` (drawn before its glows), and what of
/// it glows into `blurs`.
#[allow(clippy::too_many_arguments)]
pub fn paint_line(
    out: &mut Vec<Quad>,
    under: &mut Vec<Quad>,
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
        let shadow = matches!(slot.ink, Ink::Shadow(..));
        match slot.owner {
            Owner::Part(index) => {
                let part = &line.parts[index];
                let style = &layout.parts[index];
                let group = &line.groups[part.group];
                let group_rect = layout.groups.get(part.group).copied().unwrap_or(slot.rect);
                let (wobble, wobble_centre) = if theme.wobble_per_syllable {
                    (wobble(part.start_s, part.duration_s, group.long, phase, moment, theme), centre(&slot.rect))
                } else {
                    let first = &line.parts[group.parts[0]];
                    let last = &line.parts[group.parts[group.parts.len() - 1]];
                    let duration = last.end_s() - first.start_s;
                    (wobble(first.start_s, duration, group.long, phase, moment, theme), centre(&group_rect))
                };
                let rest = rest_pose(part, style, phase, moment, theme);
                let word_affine = line_affine.then(Affine::about(wobble_centre, wobble, style.em)).then(Affine::about(
                    centre(&group_rect),
                    rest,
                    style.em,
                ));
                let opacity = placement.opacity * past_opacity(part, style, phase, moment, theme);
                if shadow {
                    push_shadow(under, slot, word_affine, opacity, &placement);
                    continue;
                }
                let look = word_look(part, phase, moment, theme, style.glow);

                // Each letter's wave, which the glyphs and the glow under them both follow.
                let letters: Vec<(Motion, f32)> = slot
                    .glyphs
                    .iter()
                    .map(|glyph| {
                        // From the word's centre to where the outermost letter's centre would be.
                        let reach = ((group_rect.w - glyph.rect.w) / 2.0).max(1e-3);
                        let outward = ((centre(&glyph.rect).0 - centre(&group_rect).0) / reach).clamp(-1.0, 1.0);
                        glyph
                            .letter
                            .map(|i| letter_wave(part, i, style.letters, outward, phase, moment, theme))
                            .unwrap_or((Motion::IDENTITY, 0.0))
                    })
                    .collect();
                let inactive = match placement.hover_color {
                    Some((color, share)) if share > 0.0 => mix(style.inactive, color, share),
                    _ => style.inactive,
                };
                let (inactive, active) = (filtered(inactive, &placement), filtered(style.active, &placement));
                let unlit = premultiply(inactive, opacity);
                let lit = premultiply(mix(inactive, active, look.lit), opacity);
                // The glow: one drop shadow of the lit part of the word, which is the word's own
                // letters, where they are, in the glow colour behind the sweep, blurred.
                let glowing = slot.halo && !slot.color && look.glow_alpha > 0.0 && look.glow > 0.0;
                let mut glow = Blur { quads: Vec::new(), sigma: theme.glow_radius_px * look.glow };
                let glow_color =
                    premultiply(filtered(style.glow, &placement), look.glow_alpha / style.glow[3].max(1e-6) * opacity);
                let peak = if part.long_word { theme.wave_glow } else { 0.0 };
                for (glyph, (letter, near)) in slot.glyphs.iter().zip(&letters) {
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
                        let boost = (1.0 + peak * near).min(1.0 / glow_color[3].max(1e-6));
                        let lit = glow_color.map(|c| c * boost);
                        glow.quads.push(Quad { unlit: [0.0; 4], lit, ..quad });
                    }
                    out.push(quad);
                }
                if glowing {
                    blurs.push(glow);
                }
            }
            Owner::Note => {
                let pulse = Affine::scale_about(centre(&slot.rect), pulse(line, phase, moment, theme));
                let affine = line_affine.then(pulse);
                if slot.ink == Ink::Dots {
                    push_dots(out, slot, layout, line, phase, moment, affine, &placement, theme);
                } else {
                    push_note(out, blurs, slot, layout, line, phase, moment, affine, &placement, theme);
                }
            }
            // Drawn by `push_note`, with the note it fills.
            Owner::NoteImage => {}
            Owner::Pill | Owner::Translation | Owner::Romanization | Owner::Credits | Owner::Icon => {
                let color = match slot.owner {
                    Owner::Pill => layout.pill_color,
                    _ => layout.static_color,
                };
                // Decorations fade in and settle from 0.4em above when they first appear.
                let entry = if matches!(slot.owner, Owner::Credits | Owner::Icon) {
                    1.0
                } else {
                    DECORATION_EASE.at(placement.entry)
                };
                let slide = Affine { sx: 1.0, sy: 1.0, tx: 0.0, ty: -0.4 * layout.static_em * (1.0 - entry) };
                if shadow {
                    push_shadow(under, slot, line_affine.then(slide), placement.opacity * entry, &placement);
                    continue;
                }
                let flat = premultiply(filtered(color, &placement), placement.opacity * entry);
                // The romanization's box goes under everything, its text's shadow included.
                let target = if slot.owner == Owner::Pill { &mut *under } else { &mut *out };
                for glyph in &slot.glyphs {
                    target.push(Quad {
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
    let base = premultiply(filtered(layout.inactive, placement), placement.opacity);
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
    let lit = premultiply(filtered(layout.active, placement), opacity * placement.opacity);
    let fill = Quad { rect: canvas_rect, uv, unlit: [0.0; 4], lit, ramp, wave: [wave[0], wave[1], Quad::TEXT, 0.0] };
    // Its glow is the filled part blurred by 5 units, as the DOM renderer's SVG blur was. Until the
    // surface has reached the note there is nothing filled, and nothing glows.
    let lowest_surface = level - amplitude.abs();
    if lowest_surface < NOTE_BOTTOM_UNITS {
        let glow = premultiply(filtered(layout.active, placement), 0.6 * opacity * placement.opacity);
        blurs.push(Blur { quads: vec![Quad { lit: glow, ..fill }], sigma: NOTE_GLOW_UNITS * unit });
    }
    out.push(fill);
}

/// The scale the instrumental icon beats to (`--blyrics-instrumental-pulse-scale`), swelling and
/// settling once a period while the instrumental plays, and back to 1 as it ends.
fn pulse(line: &Line, phase: Phase, moment: Moment, theme: &Theme) -> f32 {
    let to = theme.instrumental_pulse_scale;
    if to == 1.0 || theme.reduced_motion || !theme.animate_instrumental {
        return 1.0;
    }
    let at = |lyric: f32| {
        let t = lyric - line.start_s;
        if t < 0.0 {
            return 1.0;
        }
        let swell = 0.5 - 0.5 * (std::f32::consts::TAU * t / theme.instrumental_pulse_s).cos();
        1.0 + (to - 1.0) * swell
    };
    match phase {
        Phase::Idle => 1.0,
        Phase::Live => at(moment.lyric),
        Phase::Exiting { since_ms, lyric_s } => 1.0 + (at(lyric_s) - 1.0) * (1.0 - exit_fade(since_ms, moment, theme)),
    }
}

/// The instrumental as three dots: inactive, and over them the lit colour sweeping across in
/// reading order over the instrumental, a dot's width soft.
#[allow(clippy::too_many_arguments)]
fn push_dots(
    out: &mut Vec<Quad>,
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
    let rect = slot.rect;
    let uv = uv_of(slot, rect, dpr);
    let canvas_rect = to_canvas(affine.rect(rect), placement);
    let base = premultiply(filtered(layout.inactive, placement), placement.opacity);
    let quad = Quad {
        rect: canvas_rect,
        uv,
        unlit: base,
        lit: base,
        ramp: [0.0, 0.0, 1.0, 0.0],
        wave: [0.0, 0.0, Quad::TEXT, 0.0],
    };
    out.push(quad);
    let (opacity, progress) = match phase {
        Phase::Idle => return,
        Phase::Exiting { since_ms, .. } => (1.0 - exit_fade(since_ms, moment, theme), 1.0),
        Phase::Live => {
            let t = moment.lyric - line.start_s;
            if t < 0.0 {
                return;
            }
            let progress =
                if theme.animate_instrumental { (t / line.duration_s.max(0.001)).clamp(0.0, 1.0) } else { 1.0 };
            (1.0, progress)
        }
    };
    if opacity <= 0.0 || progress <= 0.0 {
        return;
    }
    // How lit a texel is, as a ramp in the line's texels: 1 behind the edge, 0 a dot past it.
    let soft = rect.h.max(1e-3);
    let to_x = (slot.placement.tex.0 - slot.placement.origin.0) / dpr;
    let ramp = if line.rtl {
        let edge = rect.right() - progress * (rect.w + soft);
        [1.0 / (dpr * soft), 0.0, (-edge - to_x) / soft, 0.0]
    } else {
        let edge = rect.x + progress * (rect.w + soft);
        [-1.0 / (dpr * soft), 0.0, (edge + to_x) / soft, 0.0]
    };
    let lit = premultiply(filtered(layout.active, placement), opacity * placement.opacity);
    out.push(Quad { unlit: [0.0; 4], lit, ramp, ..quad });
}

/// The note's lowest point in its 24-unit view box, which the fill rises from.
const NOTE_BOTTOM_UNITS: f32 = 21.0;
/// The fill's glow in the DOM renderer was an SVG blur with a standard deviation of 5 view-box units.
const NOTE_GLOW_UNITS: f32 = 5.0;

#[cfg(test)]
mod tests {
    use super::*;

    fn placement(saturate: f32, brightness: f32) -> Placement {
        Placement {
            x: 0.0,
            y: 0.0,
            dpr: 1.0,
            opacity: 1.0,
            entry: 1.0,
            hover_scale: (1.0, 0.0),
            hover_color: None,
            saturate,
            brightness,
        }
    }

    #[test]
    fn line_filters_work_as_css_filters() {
        let red = [1.0, 0.0, 0.0, 0.5];
        assert_eq!(filtered(red, &placement(1.0, 1.0)), red);
        // saturate(0) leaves the luminance, as grey; the alpha is untouched.
        let grey = filtered(red, &placement(0.0, 1.0));
        assert!(grey[..3].iter().all(|c| (c - 0.213).abs() < 1e-6));
        assert_eq!(grey[3], 0.5);
        // brightness() scales the channels, clamped.
        assert_eq!(filtered([0.4, 0.8, 0.2, 1.0], &placement(1.0, 1.5)), [0.6, 1.0, 0.3, 1.0]);
    }
}
