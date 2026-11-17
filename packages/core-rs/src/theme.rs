//! Everything a theme can change, read once per theme from the page's CSS.
//!
//! A theme is two things, as it was for the DOM renderer: `/* blyrics-key = value; */` settings in
//! the comments of a stylesheet, and `--blyrics-*` custom properties the stylesheet sets. The custom
//! properties are read from the computed style of the layout container, so they cascade the usual
//! way. Colours are not read here: they are resolved per element during layout (see `layout.rs`), so
//! a selector that colours one word differently still works.

use crate::dom;
use crate::easing::Easing;
use web_sys::Element;

/// A 2D transform made of translations and scales only, which is all the word and letter keyframes
/// use. Translations are kept in both em and px so they can be resolved against each word's size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Motion {
    pub tx_em: f32,
    pub ty_em: f32,
    pub tx_px: f32,
    pub ty_px: f32,
    pub sx: f32,
    pub sy: f32,
}

impl Motion {
    pub const IDENTITY: Motion = Motion { tx_em: 0.0, ty_em: 0.0, tx_px: 0.0, ty_px: 0.0, sx: 1.0, sy: 1.0 };

    pub fn lerp(a: Motion, b: Motion, t: f32) -> Motion {
        let mix = |x: f32, y: f32| x + (y - x) * t;
        Motion {
            tx_em: mix(a.tx_em, b.tx_em),
            ty_em: mix(a.ty_em, b.ty_em),
            tx_px: mix(a.tx_px, b.tx_px),
            ty_px: mix(a.ty_px, b.ty_px),
            sx: mix(a.sx, b.sx),
            sy: mix(a.sy, b.sy),
        }
    }

    /// Composes `self` after `inner` (both about the same origin).
    pub fn then(self, inner: Motion) -> Motion {
        Motion {
            tx_em: self.tx_em + inner.tx_em * self.sx,
            ty_em: self.ty_em + inner.ty_em * self.sy,
            tx_px: self.tx_px + inner.tx_px * self.sx,
            ty_px: self.ty_px + inner.ty_px * self.sy,
            sx: self.sx * inner.sx,
            sy: self.sy * inner.sy,
        }
    }

    pub fn offset_px(&self, em: f32) -> (f32, f32) {
        (self.tx_em * em + self.tx_px, self.ty_em * em + self.ty_px)
    }

    /// Reads a CSS transform list of translate and scale functions, the way it composes: each
    /// function applies inside the ones before it. Anything else (rotations, matrices) is ignored.
    pub fn parse(text: &str) -> Motion {
        let mut motion = Motion::IDENTITY;
        let mut rest = text.trim();
        while let Some(open) = rest.find('(') {
            let name = rest[..open].trim();
            let Some(close) = rest[open..].find(')') else { break };
            let args: Vec<&str> = rest[open + 1..open + close].split(',').map(str::trim).collect();
            rest = &rest[open + close + 1..];
            let step = match name {
                "translateX" => translation(args.first(), None),
                "translateY" => translation(None, args.first()),
                "translate" => translation(args.first(), args.get(1)),
                "scaleX" => scale(number(args.first(), 1.0), 1.0),
                "scaleY" => scale(1.0, number(args.first(), 1.0)),
                "scale" => {
                    let x = number(args.first(), 1.0);
                    scale(x, number(args.get(1), x))
                }
                _ => Motion::IDENTITY,
            };
            motion = motion.then(step);
        }
        motion
    }
}

fn number(arg: Option<&&str>, fallback: f32) -> f32 {
    arg.and_then(|a| a.trim().parse().ok()).unwrap_or(fallback)
}

fn scale(sx: f32, sy: f32) -> Motion {
    Motion { sx, sy, ..Motion::IDENTITY }
}

fn translation(x: Option<&&str>, y: Option<&&str>) -> Motion {
    let mut motion = Motion::IDENTITY;
    if let Some(x) = x {
        let (em, px) = length(x);
        motion.tx_em = em;
        motion.tx_px = px;
    }
    if let Some(y) = y {
        let (em, px) = length(y);
        motion.ty_em = em;
        motion.ty_px = px;
    }
    motion
}

/// A length as (em, px). Rem is folded into px at 16px, which only themes that use rem in a
/// transform would notice.
fn length(text: &str) -> (f32, f32) {
    let text = text.trim();
    if let Some(value) = text.strip_suffix("rem") {
        return (0.0, value.parse::<f32>().unwrap_or(0.0) * 16.0);
    }
    if let Some(value) = text.strip_suffix("em") {
        return (value.parse().unwrap_or(0.0), 0.0);
    }
    if let Some(value) = text.strip_suffix("px") {
        return (0.0, value.parse().unwrap_or(0.0));
    }
    (0.0, text.parse().unwrap_or(0.0))
}

/// Seconds from a CSS time ("0.166s", "750ms").
pub fn parse_seconds(text: &str) -> Option<f32> {
    let text = text.trim();
    if let Some(ms) = text.strip_suffix("ms") {
        return ms.trim().parse::<f32>().ok().map(|v| v / 1000.0);
    }
    if let Some(s) = text.strip_suffix('s') {
        return s.trim().parse().ok();
    }
    None
}

/// The `/* blyrics-key = value; */` settings in a theme's comments.
#[derive(Clone, Debug)]
pub struct CommentSettings {
    pub target_scroll_ratio: f32,
    pub early_scroll_consider_s: f32,
    pub lyric_ending_threshold_s: f32,
    pub long_word_threshold_ms: f32,
    pub long_word_wrap_threshold: usize,
    pub letter_wave: bool,
    pub disable_richsync: bool,
    pub line_synced_delay_ms: f32,
    pub hide_credits: bool,
    pub swipe_lead_ratio: f32,
    pub swipe_duration_ratio: f32,
    pub passive_scroll_enabled: bool,
    pub passive_seconds_per_line: f32,
    pub passive_bottom_pause_s: f32,
    pub passive_reset_s: f32,
    pub passive_top_pause_s: f32,
}

impl Default for CommentSettings {
    fn default() -> Self {
        CommentSettings {
            target_scroll_ratio: 0.37,
            early_scroll_consider_s: 0.54,
            lyric_ending_threshold_s: 0.5,
            long_word_threshold_ms: 1500.0,
            long_word_wrap_threshold: 10,
            letter_wave: true,
            disable_richsync: false,
            line_synced_delay_ms: 50.0,
            hide_credits: false,
            swipe_lead_ratio: 0.1,
            swipe_duration_ratio: 1.6,
            passive_scroll_enabled: true,
            passive_seconds_per_line: 3.5,
            passive_bottom_pause_s: 1.5,
            passive_reset_s: 0.6,
            passive_top_pause_s: 0.8,
        }
    }
}

impl CommentSettings {
    pub fn parse(css: &str) -> CommentSettings {
        let mut settings = CommentSettings::default();
        let mut rest = css;
        while let Some(start) = rest.find("/*") {
            let Some(end) = rest[start..].find("*/") else { break };
            let comment = &rest[start + 2..start + end];
            rest = &rest[start + end + 2..];
            for statement in comment.split(';') {
                let Some((key, value)) = statement.split_once('=') else { continue };
                settings.apply(key.trim(), value.trim());
            }
        }
        settings
    }

    fn apply(&mut self, key: &str, value: &str) {
        let float = |fallback: f32| value.parse::<f32>().ok().filter(|v| v.is_finite()).unwrap_or(fallback);
        let flag = value.eq_ignore_ascii_case("true");
        match key {
            "blyrics-target-scroll-pos-ratio" => self.target_scroll_ratio = float(0.37).clamp(0.0, 1.0),
            "blyrics-early-scroll-consider-s" => self.early_scroll_consider_s = float(0.54),
            "blyrics-lyric-ending-threshold-s" => self.lyric_ending_threshold_s = float(0.5),
            "blyrics-long-word-threshold" => self.long_word_threshold_ms = float(1500.0),
            "blyrics-long-word-wrap-threshold" => self.long_word_wrap_threshold = float(10.0).max(1.0) as usize,
            "blyrics-letter-wave" => self.letter_wave = flag,
            "blyrics-disable-richsync" => self.disable_richsync = flag,
            "blyrics-line-synced-animation-delay" => self.line_synced_delay_ms = float(50.0),
            "blyrics-hide-credits" => self.hide_credits = flag,
            "blyrics-swipe-lead-ratio" => self.swipe_lead_ratio = float(0.1),
            "blyrics-swipe-duration-ratio" => self.swipe_duration_ratio = float(1.6),
            "blyrics-passive-scroll-enabled" => self.passive_scroll_enabled = flag,
            "blyrics-passive-scroll-seconds-per-line" => self.passive_seconds_per_line = float(3.5),
            "blyrics-passive-scroll-bottom-pause-s" => self.passive_bottom_pause_s = float(1.5),
            "blyrics-passive-scroll-reset-duration-s" => self.passive_reset_s = float(0.6),
            "blyrics-passive-scroll-top-pause-s" => self.passive_top_pause_s = float(0.8),
            _ => {}
        }
    }
}

/// The animation knobs, read from custom properties on the layout container.
#[derive(Clone, Debug)]
pub struct Theme {
    pub settings: CommentSettings,
    /// Per-view override of the target scroll ratio.
    pub target_scroll_ratio: f32,

    pub animate_line_scale: bool,
    pub animate_wobble: bool,
    pub animate_swipe: bool,
    pub animate_glow: bool,
    pub animate_fade: bool,
    pub animate_scroll: bool,
    pub animate_instrumental: bool,
    pub animate_decoration_entry: bool,
    pub reduced_motion: bool,

    pub rest_scale: f32,
    pub active_scale: f32,
    pub scale_duration_s: f32,
    pub enter_easing: Easing,
    pub exit_easing: Easing,

    pub fade_in_s: f32,
    pub fade_in_easing: Easing,
    pub fade_out_s: f32,
    pub fade_out_easing: Easing,

    pub swipe_start_from: f32,
    pub swipe_start_to: f32,
    pub swipe_end_from: f32,
    pub swipe_end_to: f32,
    pub swipe_easing: Easing,

    /// Glow radius at the start of a word, in CSS px.
    pub glow_radius_px: f32,
    /// Whether the glow is gone once it has shrunk (`--blyrics-highlight-glow-radius-to` is 0).
    pub glow_rests_invisible: bool,
    pub glow_duration_ratio: f32,
    pub glow_min_s: f32,
    pub glow_easing: Easing,

    pub wobble_s: f32,
    pub wobble_from: Motion,
    pub wobble_peak: Motion,
    pub wobble_settle: Motion,
    pub wobble_to: Motion,
    pub wobble_peak_offset: f32,
    pub wobble_settle_offset: f32,
    pub wobble_easing: Easing,
    pub wobble_peak_easing: Easing,

    pub wave_crest: Motion,
    pub wave_settle: Motion,
    pub wave_emphasis_scale: f32,
    pub wave_s: f32,
    pub wave_rise_easing: Easing,
    pub wave_fall_easing: Easing,

    pub instrumental_fill_fade_s: f32,
    pub instrumental_oscillation_s: f32,

    pub richsync_offset_s: f32,
    pub line_offset_s: f32,
    pub scroll_offset_s: f32,
    pub scroll_easing: Easing,

    pub credits_opacity: f32,
    pub credits_focused_opacity: f32,
}

impl Theme {
    /// Reads every knob off `container`'s computed style.
    pub fn read(container: &Element, settings: CommentSettings, root_font_px: f32) -> Theme {
        let style = dom::computed(container);
        let raw = |name: &str| style.get_property_value(name).unwrap_or_default().trim().to_string();
        let flag = |name: &str| {
            let value = raw(name);
            match value.as_str() {
                "" => true,
                "0" | "false" | "off" | "none" => false,
                other => other.parse::<f32>().map(|n| n > 0.0).unwrap_or(true),
            }
        };
        let num =
            |name: &str, fallback: f32| raw(name).parse::<f32>().ok().filter(|v| v.is_finite()).unwrap_or(fallback);
        let secs = |name: &str, fallback: f32| parse_seconds(&raw(name)).map(|s| s.max(0.001)).unwrap_or(fallback);
        let ease = |name: &str, fallback: Easing| {
            let value = raw(name);
            if value.is_empty() {
                fallback
            } else {
                Easing::parse(&value)
            }
        };
        let motion = |name: &str, fallback: &str| {
            let value = raw(name);
            Motion::parse(if value.is_empty() { fallback } else { &value })
        };
        let length_px = |name: &str, fallback: f32| {
            let value = raw(name);
            if let Some(rem) = value.strip_suffix("rem") {
                return rem.parse::<f32>().map(|v| v * root_font_px).unwrap_or(fallback);
            }
            if let Some(px) = value.strip_suffix("px") {
                return px.parse().unwrap_or(fallback);
            }
            value.parse().unwrap_or(fallback)
        };

        let reduced_motion = dom::window()
            .match_media("(prefers-reduced-motion: reduce)")
            .ok()
            .flatten()
            .map(|query| query.matches())
            .unwrap_or(false);

        let target_override = raw("--blyrics-target-scroll-pos-ratio").parse::<f32>().ok().filter(|v| v.is_finite());
        let glow_to = raw("--blyrics-highlight-glow-radius-to");
        let glow_rests_invisible = glow_to.is_empty() || length_px("--blyrics-highlight-glow-radius-to", 0.0) == 0.0;

        Theme {
            target_scroll_ratio: target_override.map(|v| v.clamp(0.0, 1.0)).unwrap_or(settings.target_scroll_ratio),
            animate_line_scale: flag("--blyrics-animate-line-scale"),
            animate_wobble: flag("--blyrics-animate-word-wobble"),
            animate_swipe: flag("--blyrics-animate-highlight-swipe"),
            animate_glow: flag("--blyrics-animate-highlight-glow"),
            animate_fade: flag("--blyrics-animate-highlight-fade"),
            animate_scroll: flag("--blyrics-animate-scroll"),
            animate_instrumental: flag("--blyrics-animate-instrumental"),
            animate_decoration_entry: raw("--blyrics-animate-decoration-entry") != "0",
            reduced_motion,

            rest_scale: num("--blyrics-scale", 0.95),
            active_scale: num("--blyrics-active-scale", 1.0),
            scale_duration_s: secs("--blyrics-scale-transition-duration", 0.166),
            enter_easing: ease("--blyrics-line-enter-easing", Easing::EASE),
            exit_easing: ease("--blyrics-line-exit-easing", Easing::EASE),

            fade_in_s: secs("--blyrics-lyric-highlight-fade-in-duration", 0.33),
            fade_in_easing: ease("--blyrics-lyric-highlight-fade-in-easing", Easing::EASE),
            fade_out_s: secs("--blyrics-lyric-highlight-fade-out-duration", 0.5),
            fade_out_easing: ease("--blyrics-lyric-highlight-fade-out-easing", Easing::EASE),

            swipe_start_from: num("--blyrics-highlight-swipe-start-from", -0.2),
            swipe_start_to: num("--blyrics-highlight-swipe-start-to", 1.4),
            swipe_end_from: num("--blyrics-highlight-swipe-end-from", -0.1),
            swipe_end_to: num("--blyrics-highlight-swipe-end-to", 1.5),
            swipe_easing: ease("--blyrics-highlight-swipe-easing", Easing::Linear),

            glow_radius_px: length_px("--blyrics-highlight-glow-radius-from", 0.8 * root_font_px),
            glow_rests_invisible,
            glow_duration_ratio: num("--blyrics-highlight-glow-duration-ratio", 1.2),
            glow_min_s: secs("--blyrics-highlight-glow-min-duration", 1.2),
            glow_easing: ease("--blyrics-highlight-glow-easing", Easing::EASE),

            wobble_s: secs("--blyrics-wobble-duration", 1.0),
            wobble_from: motion("--blyrics-word-wobble-transform-from", "scaleX(1)"),
            wobble_peak: motion("--blyrics-word-wobble-transform-peak", "translateX(0.05em) scaleX(1.025)"),
            wobble_settle: motion("--blyrics-word-wobble-transform-settle", "translateX(0) scaleX(1)"),
            wobble_to: motion("--blyrics-word-wobble-transform-to", "scaleX(1)"),
            wobble_peak_offset: num("--blyrics-word-wobble-peak-offset", 0.125).clamp(0.0, 1.0),
            wobble_settle_offset: num("--blyrics-word-wobble-settle-offset", 0.75).clamp(0.0, 1.0),
            wobble_easing: ease("--blyrics-word-wobble-easing", Easing::EASE),
            wobble_peak_easing: ease("--blyrics-word-wobble-peak-easing", Easing::EASE_IN_OUT),

            wave_crest: motion("--blyrics-letter-wave-transform", "translateY(-0.05em)"),
            wave_settle: motion("--blyrics-letter-wave-settle", "translateY(-0.02em)"),
            wave_emphasis_scale: num("--blyrics-letter-wave-emphasis-scale", 1.11),
            wave_s: secs("--blyrics-letter-wave-duration", 0.9),
            wave_rise_easing: ease("--blyrics-letter-wave-rise-easing", Easing::EASE_IN_OUT),
            wave_fall_easing: ease("--blyrics-letter-wave-fall-easing", Easing::EASE_OUT),

            instrumental_fill_fade_s: secs("--blyrics-instrumental-fill-fade-duration", 0.15),
            instrumental_oscillation_s: secs("--blyrics-instrumental-wave-oscillation-duration", 1.25),

            richsync_offset_s: parse_seconds(&raw("--blyrics-richsync-timing-offset")).unwrap_or(0.150),
            line_offset_s: parse_seconds(&raw("--blyrics-timing-offset")).unwrap_or(0.115),
            scroll_offset_s: parse_seconds(&raw("--blyrics-scroll-timing-offset")).unwrap_or(0.5),
            scroll_easing: ease("--blyrics-lyric-scroll-timing-function", Easing::Bezier(0.86, 0.0, 0.2, 1.0)),

            credits_opacity: num("--blyrics-credits-opacity", 0.2),
            credits_focused_opacity: num("--blyrics-credits-focused-opacity", 0.85),
            settings,
        }
    }

    /// The soft edge of the sweep, in word widths.
    pub fn swipe_fade(&self) -> f32 {
        (self.swipe_end_to - self.swipe_start_to).max(1e-3)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transforms_compose_in_order() {
        let m = Motion::parse("translateX(0.05em) scaleX(1.025)");
        assert!((m.tx_em - 0.05).abs() < 1e-6);
        assert!((m.sx - 1.025).abs() < 1e-6);
        let lift = Motion::parse("translateY(-0.0375em)");
        assert!((lift.ty_em + 0.0375).abs() < 1e-6);
    }

    #[test]
    fn comment_settings() {
        let s = CommentSettings::parse(
            "/* blyrics-target-scroll-pos-ratio = 0.42; */ .x{} /* blyrics-letter-wave = false; */",
        );
        assert!((s.target_scroll_ratio - 0.42).abs() < 1e-6);
        assert!(!s.letter_wave);
    }

    #[test]
    fn seconds() {
        assert_eq!(parse_seconds("750ms"), Some(0.75));
        assert_eq!(parse_seconds("0.166s"), Some(0.166));
    }
}
