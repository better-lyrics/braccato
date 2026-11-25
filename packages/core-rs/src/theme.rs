//! Everything a theme can change, read once per theme from the page's CSS.
//!
//! A theme is two things, as it was for the DOM renderer: `blyrics-key = value;` settings in the
//! comments of a stylesheet, and `--blyrics-*` custom properties the stylesheet sets. The custom
//! properties are read from the computed style of the layout container, so they cascade the usual
//! way. Colours are not read here: they are resolved per element during layout (see `layout.rs`), so
//! a selector that colours one word differently still works.

use crate::dom;
use crate::easing::Easing;
use crate::layout::{read_color, Rgba};
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

/// A length in px, em and rem lengths resolved against `em_px` and `root_px`.
pub fn length_px(text: &str, em_px: f32, root_px: f32) -> f32 {
    match text.trim().strip_suffix("rem") {
        Some(rem) => rem.trim().parse::<f32>().unwrap_or(0.0) * root_px,
        None => {
            let (em, px) = length(text);
            em * em_px + px
        }
    }
}

/// Seconds from a CSS time ("0.166s", "750ms").
/// The address in a single CSS `url()`, as the DOM renderer accepted it: not gradients or lists.
pub fn css_url(value: &str) -> Option<String> {
    let inner =
        value.trim().strip_prefix("url(").or_else(|| value.trim().strip_prefix("URL("))?.strip_suffix(')')?.trim();
    let unquoted = match inner.as_bytes().first() {
        Some(b'"') => inner.strip_prefix('"')?.strip_suffix('"')?,
        Some(b'\'') => inner.strip_prefix('\'')?.strip_suffix('\'')?,
        _ if inner.contains(|c: char| c.is_whitespace() || "'\"()".contains(c)) => return None,
        _ => inner,
    };
    (!unquoted.is_empty()).then(|| unquoted.to_string())
}

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

/// Which words split into letters for the letter wave (`blyrics-letter-wave = true;`, `false` or
/// `long`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LetterWave {
    Off,
    All,
    /// Only held words, sung past `blyrics-long-word-threshold`.
    Long,
}

/// The `blyrics-key = value;` settings in a theme's comments.
#[derive(Clone, Debug)]
pub struct CommentSettings {
    pub target_scroll_ratio: f32,
    pub early_scroll_consider_s: f32,
    pub lyric_ending_threshold_s: f32,
    pub long_word_threshold_ms: f32,
    pub long_word_wrap_threshold: usize,
    /// Words longer than this many letters are never held words; 0 for no limit.
    pub long_word_max_letters: usize,
    pub letter_wave: LetterWave,
    pub disable_richsync: bool,
    pub line_synced_delay_ms: f32,
    pub hide_credits: bool,
    /// The instrumental note fills with the theme's `--blyrics-highlight-image`.
    pub image_highlights: bool,
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
            long_word_max_letters: 0,
            letter_wave: LetterWave::All,
            disable_richsync: false,
            line_synced_delay_ms: 50.0,
            hide_credits: false,
            image_highlights: false,
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
            "blyrics-long-word-max-letters" => self.long_word_max_letters = float(0.0).max(0.0) as usize,
            "blyrics-letter-wave" => {
                self.letter_wave = if value.eq_ignore_ascii_case("long") {
                    LetterWave::Long
                } else if flag {
                    LetterWave::All
                } else {
                    LetterWave::Off
                }
            }
            "blyrics-disable-richsync" => self.disable_richsync = flag,
            "blyrics-line-synced-animation-delay" => self.line_synced_delay_ms = float(50.0),
            "blyrics-hide-credits" => self.hide_credits = flag,
            "blyrics-image-highlights" => self.image_highlights = flag,
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
    /// The image the instrumental note fills with, when the theme has image highlights on and the
    /// page is not in forced colours, and whether it has loaded (set by the view, which loads it).
    pub highlight_image: Option<String>,
    pub highlight_image_ready: bool,
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
    /// Each syllable wobbles on its own (`--blyrics-word-wobble-scope: syllable`) rather than the
    /// whole word once.
    pub wobble_per_syllable: bool,
    /// How many times the syllable's (or word's) own duration the wobble lasts longer
    /// (`--blyrics-word-wobble-duration-ratio`).
    pub wobble_duration_ratio: f32,

    pub wave_crest: Motion,
    pub wave_settle: Motion,
    pub wave_emphasis_scale: f32,
    pub wave_s: f32,
    pub wave_rise_easing: Easing,
    pub wave_fall_easing: Easing,
    /// How far a held word's outermost letters move out from its centre at their crest
    /// (`--blyrics-letter-wave-spread`).
    pub wave_spread: Motion,
    /// How much brighter a held word's letter glows at its crest (`--blyrics-letter-wave-glow`).
    pub wave_glow: f32,

    pub instrumental_fill_fade_s: f32,
    pub instrumental_oscillation_s: f32,

    pub richsync_offset_s: f32,
    pub line_offset_s: f32,
    pub scroll_offset_s: f32,
    pub scroll_easing: Easing,

    pub credits_opacity: f32,
    pub credits_focused_opacity: f32,

    /// How lines look by their distance from the lines being sung, before them (sung already) and
    /// after them (still to come): an opacity and a blur (standard deviation, CSS pixels) for each
    /// whole line away, starting at 0. Between whole lines the values are interpolated; past the
    /// last, the last holds. Empty when the theme sets none.
    pub line_effects: LineEffects,

    /// What the line under the pointer eases to.
    pub line_hover: LineHover,
    /// The opacity lines other than the sung and hovered ones ease to while the pointer is over the
    /// lyrics or a reader scrolls (`--blyrics-line-opacity-browsing`), over the hover's duration.
    pub line_opacity_browsing: Option<f32>,

    /// How much longer than its own duration a word takes to rise from its rest pose
    /// (`--blyrics-word-rest-transform`, read per word), and the rise's easing.
    pub word_rise_extra_s: f32,
    pub word_rise_easing: Easing,

    /// What the instrumental lines show (`--blyrics-instrumental-icon`), and the pulse it beats with
    /// while the instrumental plays: the scale it swells to (1 for none) and its period.
    pub instrumental_icon: InstrumentalIcon,
    pub instrumental_pulse_scale: f32,
    pub instrumental_pulse_s: f32,

    /// The message shown when there are no lyrics, in place of the host's
    /// (`--blyrics-no-lyrics-text`), and text drawn above it (`--blyrics-no-lyrics-icon`).
    pub no_lyrics_text: Option<String>,
    pub no_lyrics_icon: Option<String>,
}

impl Theme {
    /// Whether the line under the pointer matters: it has a hover look, or it is the line the
    /// browsing opacity leaves alone.
    pub fn tracks_hover(&self) -> bool {
        self.line_hover.is_set() || self.line_opacity_browsing.is_some()
    }
}

/// What an instrumental line shows.
#[derive(Clone, Debug, PartialEq)]
pub enum InstrumentalIcon {
    /// The music note, filling from the bottom.
    Note,
    /// Three dots, lighting one after another in reading order.
    Dots,
    /// Text, such as "♫", filling from the bottom like the note.
    Text(String),
}

impl InstrumentalIcon {
    pub fn parse(value: &str) -> InstrumentalIcon {
        match css_string(value) {
            Some(text) if !text.trim().is_empty() => InstrumentalIcon::Text(text),
            Some(_) => InstrumentalIcon::Note,
            None if value.trim() == "dots" => InstrumentalIcon::Dots,
            None => InstrumentalIcon::Note,
        }
    }
}

/// The text of a quoted CSS string (`"♫"`, `'No lyrics'`), with `\"`-style escapes undone. `None`
/// when the value is not a string.
pub fn css_string(value: &str) -> Option<String> {
    let value = value.trim();
    let quote = value.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let inner = value.strip_prefix(quote)?.strip_suffix(quote)?;
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        // A hex escape (`\266B`) or an escaped character.
        let mut hex = String::new();
        let mut rest = chars.clone();
        while hex.len() < 6 {
            match rest.clone().next() {
                Some(h) if h.is_ascii_hexdigit() => {
                    hex.push(h);
                    rest.next();
                }
                _ => break,
            }
        }
        if hex.is_empty() {
            if let Some(next) = chars.next() {
                out.push(next);
            }
            continue;
        }
        chars = rest;
        if chars.clone().next() == Some(' ') {
            chars.next();
        }
        if let Some(c) = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
            out.push(c);
        }
    }
    Some(out)
}

/// What a theme makes the line under the pointer look like: each value it sets replaces the line's
/// own (its distance opacity and blur, its scale) while the pointer is over it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LineHover {
    pub opacity: Option<f32>,
    /// Blur standard deviation, CSS pixels.
    pub blur_px: Option<f32>,
    pub scale: Option<f32>,
    /// The inactive colour the line's words ease to (`--blyrics-line-hover-color`).
    pub color: Option<Rgba>,
    /// The fill and border colours the line's box eases to (`--blyrics-line-hover-bg-color`,
    /// `--blyrics-line-hover-border-color`).
    pub bg: Option<Rgba>,
    pub border: Option<Rgba>,
    pub duration_s: f32,
    pub easing: Easing,
}

impl LineHover {
    pub fn is_set(&self) -> bool {
        self.opacity.is_some()
            || self.blur_px.is_some()
            || self.scale.is_some()
            || self.color.is_some()
            || self.bg.is_some()
            || self.border.is_some()
    }

    /// Reads the hover variables from their raw values. A blur may be written as `blur(4px)`.
    pub fn parse(opacity: &str, blur: &str, scale: &str, duration_s: f32, easing: Easing, root_font_px: f32) -> Self {
        let number = |value: &str| {
            let value = value.trim();
            let parsed = match value.strip_suffix('%') {
                Some(percent) => percent.trim().parse::<f32>().map(|v| v / 100.0),
                None => value.parse::<f32>(),
            };
            parsed.ok().filter(|v| v.is_finite())
        };
        let blur = blur.trim();
        let blur = blur.strip_prefix("blur(").and_then(|b| b.strip_suffix(')')).unwrap_or(blur);
        let blur_px = if blur == "none" { Some(0.0) } else { parse_list(blur, root_font_px).first().copied() };
        LineHover {
            opacity: number(opacity).map(|v| v.clamp(0.0, 1.0)),
            blur_px: blur_px.map(|v| v.max(0.0)),
            scale: number(scale).filter(|v| *v > 0.0),
            color: None,
            bg: None,
            border: None,
            duration_s,
            easing,
        }
    }
}

/// A theme's distance curves (see `Theme::line_effects`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LineEffects {
    pub opacity_before: Vec<f32>,
    pub opacity_after: Vec<f32>,
    pub blur_before: Vec<f32>,
    pub blur_after: Vec<f32>,
    pub saturate_before: Vec<f32>,
    pub saturate_after: Vec<f32>,
    pub brightness_before: Vec<f32>,
    pub brightness_after: Vec<f32>,
}

/// What the distance curves give one line.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LineLook {
    pub opacity: f32,
    /// Blur standard deviation, CSS pixels.
    pub blur: f32,
    pub saturate: f32,
    pub brightness: f32,
}

impl LineLook {
    pub const PLAIN: LineLook = LineLook { opacity: 1.0, blur: 0.0, saturate: 1.0, brightness: 1.0 };

    /// `self` eased toward plain by `1 - strength`.
    pub fn scaled(self, strength: f32) -> LineLook {
        let toward = |plain: f32, v: f32| plain + (v - plain) * strength;
        LineLook {
            opacity: toward(1.0, self.opacity),
            blur: toward(0.0, self.blur),
            saturate: toward(1.0, self.saturate),
            brightness: toward(1.0, self.brightness),
        }
    }
}

impl LineEffects {
    pub fn is_empty(&self) -> bool {
        [
            &self.opacity_before,
            &self.opacity_after,
            &self.blur_before,
            &self.blur_after,
            &self.saturate_before,
            &self.saturate_after,
            &self.brightness_before,
            &self.brightness_after,
        ]
        .iter()
        .all(|list| list.is_empty())
    }

    /// The look at `distance` lines away, before (negative) or after (positive).
    pub fn at(&self, distance: f32) -> LineLook {
        let before = distance < 0.0;
        let d = distance.abs();
        let at = |b: &[f32], a: &[f32], empty: f32| sample(if before { b } else { a }, d, empty);
        LineLook {
            opacity: at(&self.opacity_before, &self.opacity_after, 1.0),
            blur: at(&self.blur_before, &self.blur_after, 0.0),
            saturate: at(&self.saturate_before, &self.saturate_after, 1.0),
            brightness: at(&self.brightness_before, &self.brightness_after, 1.0),
        }
    }
}

/// `values` at `d`, between whole indices linearly, the last value past the end, `empty` with none.
fn sample(values: &[f32], d: f32, empty: f32) -> f32 {
    let Some(&last) = values.last() else { return empty };
    let i = d.floor() as usize;
    if i + 1 >= values.len() {
        return last;
    }
    let t = d - i as f32;
    values[i] + (values[i + 1] - values[i]) * t
}

/// A number or a percentage, as an opacity: `0.5` or `50%`, clamped to 0 to 1. `None` when unset or
/// unreadable.
pub fn fraction(value: &str) -> Option<f32> {
    let value = value.trim();
    let parsed = match value.strip_suffix('%') {
        Some(percent) => percent.trim().parse::<f32>().map(|v| v / 100.0),
        None => value.parse::<f32>(),
    };
    parsed.ok().filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 1.0))
}

/// One shadow of a `text-shadow` list, lengths in CSS pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct TextShadow {
    /// As the theme wrote it, for the canvas to parse; black when it gave none.
    pub color: String,
    pub x: f32,
    pub y: f32,
    pub blur: f32,
}

impl TextShadow {
    /// How far past the text the shadow can reach, CSS pixels.
    pub fn reach(&self) -> f32 {
        self.x.abs().max(self.y.abs()) + 1.5 * self.blur
    }
}

/// A `text-shadow` value: comma-separated shadows of an optional colour and two or three lengths in
/// px, em or rem. A shadow the renderer cannot read is left out. `none` and the empty value give none.
pub fn parse_text_shadows(value: &str, em_px: f32, root_font_px: f32, current_color: &str) -> Vec<TextShadow> {
    let value = value.trim();
    if value.is_empty() || value == "none" {
        return Vec::new();
    }
    let length = |token: &str| -> Option<f32> {
        let parsed = if let Some(rem) = token.strip_suffix("rem") {
            rem.parse::<f32>().ok().map(|v| v * root_font_px)
        } else if let Some(em) = token.strip_suffix("em") {
            em.parse::<f32>().ok().map(|v| v * em_px)
        } else if let Some(px) = token.strip_suffix("px") {
            px.parse::<f32>().ok()
        } else {
            token.parse::<f32>().ok().filter(|v| *v == 0.0)
        };
        parsed.filter(|v| v.is_finite())
    };
    split_top_level(value, ',')
        .into_iter()
        .filter_map(|shadow| {
            let mut lengths = Vec::new();
            let mut color = None;
            for token in split_top_level(shadow, ' ') {
                match length(token) {
                    Some(v) => lengths.push(v),
                    None if color.is_none() && token.eq_ignore_ascii_case("currentcolor") => {
                        color = Some(current_color.to_string())
                    }
                    None if color.is_none() => color = Some(token.to_string()),
                    None => return None,
                }
            }
            if !(2..=3).contains(&lengths.len()) {
                return None;
            }
            Some(TextShadow {
                color: color.unwrap_or_else(|| current_color.to_string()),
                x: lengths[0],
                y: lengths[1],
                blur: lengths.get(2).copied().unwrap_or(0.0).max(0.0),
            })
        })
        .collect()
}

/// `text` cut at `separator` (or any whitespace, for a space) outside parentheses, pieces trimmed
/// and empty ones dropped.
fn split_top_level(text: &str, separator: char) -> Vec<&str> {
    let mut pieces = Vec::new();
    let (mut depth, mut start) = (0i32, 0usize);
    for (i, c) in text.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            c if depth == 0 && (c == separator || (separator == ' ' && c.is_whitespace())) => {
                pieces.push(&text[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    pieces.push(&text[start..]);
    pieces.into_iter().map(str::trim).filter(|p| !p.is_empty()).collect()
}

/// A list of numbers or lengths, as `1 0.88 0.72` or `0 1.125px 2.5px`, separated by spaces or
/// commas. Lengths are px or rem; anything else ends the list where it is.
pub fn parse_list(value: &str, root_font_px: f32) -> Vec<f32> {
    let mut out = Vec::new();
    for token in value.split(|c: char| c.is_whitespace() || c == ',').filter(|t| !t.is_empty()) {
        let parsed = if let Some(rem) = token.strip_suffix("rem") {
            rem.parse::<f32>().map(|v| v * root_font_px)
        } else if let Some(px) = token.strip_suffix("px") {
            px.parse::<f32>()
        } else {
            token.parse::<f32>()
        };
        match parsed {
            Ok(v) if v.is_finite() => out.push(v),
            _ => break,
        }
    }
    out
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

        let reduced_motion = dom::win_of(container)
            .match_media("(prefers-reduced-motion: reduce)")
            .ok()
            .flatten()
            .map(|query| query.matches())
            .unwrap_or(false);

        let target_override = raw("--blyrics-target-scroll-pos-ratio").parse::<f32>().ok().filter(|v| v.is_finite());
        let glow_to = raw("--blyrics-highlight-glow-radius-to");
        let glow_rests_invisible = glow_to.is_empty() || length_px("--blyrics-highlight-glow-radius-to", 0.0) == 0.0;

        let forced_colors = dom::win_of(container)
            .match_media("(forced-colors: active)")
            .ok()
            .flatten()
            .is_some_and(|query| query.matches());
        let highlight_image =
            if settings.image_highlights && !forced_colors { css_url(&raw("--blyrics-highlight-image")) } else { None };

        Theme {
            highlight_image,
            highlight_image_ready: false,
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
            wobble_per_syllable: raw("--blyrics-word-wobble-scope") == "syllable",
            wobble_duration_ratio: num("--blyrics-word-wobble-duration-ratio", 0.0).max(0.0),

            wave_crest: motion("--blyrics-letter-wave-transform", "translateY(-0.05em)"),
            wave_settle: motion("--blyrics-letter-wave-settle", "translateY(-0.02em)"),
            wave_emphasis_scale: num("--blyrics-letter-wave-emphasis-scale", 1.11),
            wave_s: secs("--blyrics-letter-wave-duration", 0.9),
            wave_rise_easing: ease("--blyrics-letter-wave-rise-easing", Easing::EASE_IN_OUT),
            wave_fall_easing: ease("--blyrics-letter-wave-fall-easing", Easing::EASE_OUT),
            wave_spread: {
                let spread = raw("--blyrics-letter-wave-spread");
                Motion::parse(&format!("translateX({})", if spread.is_empty() { "0" } else { &spread }))
            },
            wave_glow: num("--blyrics-letter-wave-glow", 0.0).max(0.0),

            instrumental_fill_fade_s: secs("--blyrics-instrumental-fill-fade-duration", 0.15),
            instrumental_oscillation_s: secs("--blyrics-instrumental-wave-oscillation-duration", 1.25),

            richsync_offset_s: parse_seconds(&raw("--blyrics-richsync-timing-offset")).unwrap_or(0.150),
            line_offset_s: parse_seconds(&raw("--blyrics-timing-offset")).unwrap_or(0.115),
            scroll_offset_s: parse_seconds(&raw("--blyrics-scroll-timing-offset")).unwrap_or(0.5),
            scroll_easing: ease("--blyrics-lyric-scroll-timing-function", Easing::Bezier(0.86, 0.0, 0.2, 1.0)),

            credits_opacity: num("--blyrics-credits-opacity", 0.2),
            credits_focused_opacity: num("--blyrics-credits-focused-opacity", 0.85),
            line_effects: {
                // `--blyrics-line-opacity`, `-blur`, `-saturate` and `-brightness` hold for both
                // sides; a `-before` or `-after` variant replaces one side.
                let list = |name: &str| parse_list(&raw(name), root_font_px);
                let side = |both: &str, one: &str| {
                    let own = list(one);
                    if own.is_empty() {
                        list(both)
                    } else {
                        own
                    }
                };
                LineEffects {
                    opacity_before: side("--blyrics-line-opacity", "--blyrics-line-opacity-before"),
                    opacity_after: side("--blyrics-line-opacity", "--blyrics-line-opacity-after"),
                    blur_before: side("--blyrics-line-blur", "--blyrics-line-blur-before"),
                    blur_after: side("--blyrics-line-blur", "--blyrics-line-blur-after"),
                    saturate_before: side("--blyrics-line-saturate", "--blyrics-line-saturate-before"),
                    saturate_after: side("--blyrics-line-saturate", "--blyrics-line-saturate-after"),
                    brightness_before: side("--blyrics-line-brightness", "--blyrics-line-brightness-before"),
                    brightness_after: side("--blyrics-line-brightness", "--blyrics-line-brightness-after"),
                }
            },
            line_hover: LineHover {
                color: read_color(&dom::doc_of(container), &raw("--blyrics-line-hover-color")),
                bg: read_color(&dom::doc_of(container), &raw("--blyrics-line-hover-bg-color")),
                border: read_color(&dom::doc_of(container), &raw("--blyrics-line-hover-border-color")),
                ..LineHover::parse(
                    &raw("--blyrics-line-hover-opacity"),
                    &raw("--blyrics-line-hover-blur"),
                    &raw("--blyrics-line-hover-scale"),
                    secs("--blyrics-line-hover-duration", 0.2),
                    ease("--blyrics-line-hover-easing", Easing::EASE),
                    root_font_px,
                )
            },
            line_opacity_browsing: fraction(&raw("--blyrics-line-opacity-browsing")),
            word_rise_extra_s: parse_seconds(&raw("--blyrics-word-rise-extra-duration")).unwrap_or(0.2).max(0.0),
            word_rise_easing: ease("--blyrics-word-rise-easing", Easing::EASE),
            instrumental_icon: InstrumentalIcon::parse(&raw("--blyrics-instrumental-icon")),
            instrumental_pulse_scale: num("--blyrics-instrumental-pulse-scale", 1.0).max(0.0),
            instrumental_pulse_s: secs("--blyrics-instrumental-pulse-duration", 1.5),
            no_lyrics_text: css_string(&raw("--blyrics-no-lyrics-text")),
            no_lyrics_icon: css_string(&raw("--blyrics-no-lyrics-icon")).filter(|t| !t.trim().is_empty()),
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
    fn distance_curves_interpolate_and_hold_their_last_value() {
        assert_eq!(parse_list("1 0.88, 0.72 0.52", 16.0), vec![1.0, 0.88, 0.72, 0.52]);
        assert_eq!(parse_list("0 1.125px 0.25rem", 16.0), vec![0.0, 1.125, 4.0]);
        assert!(parse_list("", 16.0).is_empty());
        let effects =
            LineEffects { opacity_after: vec![1.0, 0.5, 0.0], blur_after: vec![0.0, 2.0], ..Default::default() };
        let pair = |look: LineLook| (look.opacity, look.blur);
        assert_eq!(pair(effects.at(0.0)), (1.0, 0.0));
        assert_eq!(pair(effects.at(0.5)), (0.75, 1.0));
        assert_eq!(pair(effects.at(5.0)), (0.0, 2.0));
        // Nothing set for lines before: untouched.
        assert_eq!(effects.at(-3.0), LineLook::PLAIN);
        let filters =
            LineEffects { saturate_before: vec![1.0, 0.8], brightness_after: vec![1.0, 1.2], ..Default::default() };
        assert_eq!(filters.at(-2.0).saturate, 0.8);
        assert_eq!(filters.at(2.0).saturate, 1.0);
        assert!((filters.at(0.5).brightness - 1.1).abs() < 1e-6);
        // A reader scrolling eases every value back to plain.
        assert_eq!(effects.at(5.0).scaled(0.0), LineLook::PLAIN);
    }

    #[test]
    fn strings_and_icons() {
        assert_eq!(css_string("\"No lyrics found\""), Some("No lyrics found".into()));
        assert_eq!(css_string("'it\\'s'"), Some("it's".into()));
        assert_eq!(css_string("\"\\266B\""), Some("♫".into()));
        assert_eq!(css_string("\"\\266B  x\""), Some("♫ x".into()));
        assert_eq!(css_string("none"), None);
        assert_eq!(InstrumentalIcon::parse("\"♫\""), InstrumentalIcon::Text("♫".into()));
        assert_eq!(InstrumentalIcon::parse("dots"), InstrumentalIcon::Dots);
        assert_eq!(InstrumentalIcon::parse(""), InstrumentalIcon::Note);
        assert_eq!(InstrumentalIcon::parse("note"), InstrumentalIcon::Note);
    }

    #[test]
    fn text_shadows_read_like_css() {
        let shadows =
            parse_text_shadows("0 .3rem .5rem rgba(0, 0, 0, .15), hsl(0, 0%, 0%, .5) 1px 2px", 20.0, 16.0, "black");
        assert_eq!(
            shadows,
            vec![
                TextShadow { color: "rgba(0, 0, 0, .15)".into(), x: 0.0, y: 4.8, blur: 8.0 },
                TextShadow { color: "hsl(0, 0%, 0%, .5)".into(), x: 1.0, y: 2.0, blur: 0.0 },
            ]
        );
        // No colour, or currentColor, is the text's own.
        assert_eq!(
            parse_text_shadows("0 0 0.5em, currentColor 1px 1px", 20.0, 16.0, "white"),
            vec![
                TextShadow { color: "white".into(), x: 0.0, y: 0.0, blur: 10.0 },
                TextShadow { color: "white".into(), x: 1.0, y: 1.0, blur: 0.0 },
            ]
        );
        // What it cannot read is left out, and the rest kept.
        assert_eq!(parse_text_shadows("0 0 2vw red, 0 1px red", 20.0, 16.0, "black").len(), 1);
        assert!(parse_text_shadows("none", 20.0, 16.0, "black").is_empty());
        assert!(parse_text_shadows("", 20.0, 16.0, "black").is_empty());
    }

    #[test]
    fn hover_reads_what_the_theme_sets_and_nothing_else() {
        let hover = LineHover::parse("1", "blur(0)", "1.04", 0.2, Easing::EASE, 16.0);
        assert_eq!((hover.opacity, hover.blur_px, hover.scale), (Some(1.0), Some(0.0), Some(1.04)));
        let hover = LineHover::parse("80%", "0.25rem", "", 0.2, Easing::EASE, 16.0);
        assert_eq!((hover.opacity, hover.blur_px, hover.scale), (Some(0.8), Some(4.0), None));
        assert!(!LineHover::parse("", "", "", 0.2, Easing::EASE, 16.0).is_set());
        assert_eq!(LineHover::parse("", "none", "", 0.2, Easing::EASE, 16.0).blur_px, Some(0.0));
    }

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
        assert_eq!(s.letter_wave, LetterWave::Off);
        let s = CommentSettings::parse("/* blyrics-letter-wave = long; blyrics-long-word-max-letters = 8; */");
        assert_eq!((s.letter_wave, s.long_word_max_letters), (LetterWave::Long, 8));
    }

    #[test]
    fn seconds() {
        assert_eq!(parse_seconds("750ms"), Some(0.75));
        assert_eq!(parse_seconds("0.166s"), Some(0.166));
    }
}
