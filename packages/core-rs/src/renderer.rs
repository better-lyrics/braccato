//! The view: owns the element's DOM, the canvas and every piece of state, and draws a frame.
//!
//! A frame reads the clock, moves each line through its phases, lets autoscroll decide whether to
//! scroll, rasterizes any line that has come into view, and draws. When nothing is playing or
//! moving, no frames are requested at all, so an idle view costs nothing.

use crate::clock::Clock;
use crate::dom::{self, element, set_style};
use crate::gpu::{BlurRegion, Gpu, LineTexture, Quad};
use crate::layout::{self, LayoutDom, LineDom, LineLayout, Measured, Owner, Rect};
use crate::model::{Lyric, LyricPart, LyricsOptions, SyncType};
use crate::paint::{self, Moment, Phase, Placement};
use crate::profile::{self, Profile};
use crate::raster::Rasterizer;
use crate::scroll::{self, AutoScroll, Curve, ScrollLine, ScrollParams, Viewport};
use crate::song::{self, Decorations, Hung, Song};
use crate::stage::{self, Role};
use crate::style;
use crate::theme::LineLook;
use crate::theme::{CommentSettings, Theme};
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Document, Element, HtmlCanvasElement, HtmlElement, HtmlMediaElement, Window};

/// A blur narrower than this many device pixels is not worth blurring: drawn as it is.
const MIN_BLUR_PX: f32 = 1.0;

/// Something drawn blurred this frame: quads already placed on the line pages, the blur's standard
/// deviation in CSS pixels, and which canvas quad is its composite.
struct BlurJob {
    quads: Vec<Quad>,
    sigma: f32,
    composite: usize,
}

/// The atlas scale for a blur of `sigma_px` device pixels: as coarse as keeps at least 1.5 texels
/// per sigma, by powers of two so it lands on mip levels.
fn coarseness(sigma_px: f32) -> f32 {
    2f32.powi((sigma_px.max(0.5) / 1.5).log2().floor().max(0.0) as i32)
}

/// The Gaussian to apply at scale `ds`: averaging down and filtering back up already widen the blur
/// by about ds^2 / 4 in variance, which comes out of it.
fn blur_sigma(sigma_px: f32, ds: f32) -> f32 {
    if ds > 1.0 {
        (sigma_px * sigma_px - ds * ds / 4.0).max(sigma_px * sigma_px / 4.0).sqrt()
    } else {
        sigma_px
    }
}

/// How often the element's place in the scroll element is read again (see `frame_with`).
const HOST_RECHECK_MS: f64 = 250.0;
/// Scrolls this soon after the lines were built or measured are the page settling (a scroll position
/// clamped to new content), not a reader.
const SETTLING_SCROLL_MS: f64 = 600.0;
/// And until this many frames have started since: a scroll event waits for the next frame, which a
/// hidden or covered window may not draw for seconds.
const SETTLING_SCROLL_FRAMES: u8 = 2;
/// A user scroll stops autoscroll for this long, synced and unsynced.
const USER_SCROLL_PAUSE_MS: f64 = 25_000.0;
const USER_SCROLL_PAUSE_UNSYNCED_MS: f64 = 5_000.0;
/// Lines are built this far ahead of their time while playing.
const PREPARE_S: f32 = 2.0;
/// Lines this many viewports away are rasterized ahead, and dropped beyond the second number.
const PREFETCH_VIEWPORTS: f32 = 1.0;
const EVICT_VIEWPORTS: f32 = 3.0;
/// At most this many lines are rasterized ahead of need in one frame.
const PREFETCH_PER_FRAME: usize = 2;
const DECORATION_ENTRY_MS: f64 = 350.0;
/// How long lines take to slide to where a swap or a new decoration moved them.
const SETTLE_MS: f64 = 350.0;

/// What a line carries from frame to frame.
#[derive(Default)]
struct LineState {
    phase: Phase,
    /// Scroll glides still running on the line, added together.
    curves: Vec<Curve>,
    texture: Option<LineTexture>,
    /// When the line's translation or romanization appeared, which their entry runs from.
    decorated_ms: f64,
    /// How far the line has eased toward the theme's hover look, 0 to 1.
    hover: Tween,
    /// How far the line has eased to the theme's browsing opacity, 0 to 1: toward 1 while the
    /// pointer is over the lyrics or a reader scrolls, unless the line is being sung.
    browse: Tween,
}

/// A value easing from `from` to `to` since `since_ms`.
#[derive(Clone, Copy, Debug, Default)]
struct Tween {
    from: f32,
    to: f32,
    since_ms: f64,
}

impl LineState {
    /// How far from its box the line is drawn, by the glides running on it.
    fn glide_offset(&self, now_ms: f64) -> f32 {
        self.curves.iter().map(|curve| curve.value(now_ms)).sum()
    }
}

impl Tween {
    fn at(&self, now_ms: f64, duration_s: f32, easing: crate::easing::Easing) -> f32 {
        if self.from == self.to {
            return self.to;
        }
        let t = ((now_ms - self.since_ms) / (duration_s.max(0.001) as f64 * 1000.0)).clamp(0.0, 1.0) as f32;
        // Settled once done, as a finished CSS transition is, whatever the curve's last value.
        if t >= 1.0 {
            return self.to;
        }
        self.from + (self.to - self.from) * easing.at(t)
    }

    fn moving(&self, now_ms: f64, duration_s: f32) -> bool {
        self.from != self.to && now_ms < self.since_ms + duration_s as f64 * 1000.0
    }

    /// Heads for `to` from wherever it is now.
    fn aim(&mut self, to: f32, now_ms: f64, duration_s: f32, easing: crate::easing::Easing) {
        if self.to == to {
            return;
        }
        let from = self.at(now_ms, duration_s, easing);
        *self = Tween { from, to, since_ms: now_ms };
    }
}

/// What the lines looked like before a rebuild, so the measurement after it can keep the textures
/// of lines that did not change and slide the ones that moved.
struct Prior {
    /// The layout each line had, by its new index; `None` for a line that is new.
    layouts: Vec<Option<LineLayout>>,
    credits: Option<LineLayout>,
    /// The scroll position the layouts were seen at.
    scroll_top: f32,
    /// Whether lines that moved slide to their new places, holding the one being followed still.
    settle: bool,
}

/// An element of the host's that the renderer moves along with what it draws (see `find_riders`).
struct Rider {
    element: HtmlElement,
    /// Inside the credits, rather than after the lines.
    in_credits: bool,
    /// The offset and opacity it was last given.
    last: (f32, f32),
}

impl Rider {
    fn new(element: Element, in_credits: bool) -> Rider {
        Rider { element: element.unchecked_into(), in_credits, last: (f32::NAN, f32::NAN) }
    }
}

/// Where the lines being sung are, as a range of line indices that moves smoothly from one set to
/// the next, so a theme's distance effects follow the scroll rather than jump.
#[derive(Clone, Copy, Debug, Default)]
struct Focus {
    from: (f32, f32),
    to: (f32, f32),
    start_ms: f64,
    /// Zero until the first lines are followed.
    duration_ms: f64,
}

impl Focus {
    fn at(&self, now_ms: f64, easing: crate::easing::Easing) -> (f32, f32) {
        // Settled once done, as the scroll it follows is.
        if !self.moving(now_ms) {
            return self.to;
        }
        let t = easing.at((((now_ms - self.start_ms) / self.duration_ms) as f32).clamp(0.0, 1.0));
        (self.from.0 + (self.to.0 - self.from.0) * t, self.from.1 + (self.to.1 - self.from.1) * t)
    }

    fn moving(&self, now_ms: f64) -> bool {
        self.duration_ms > 0.0 && now_ms < self.start_ms + self.duration_ms
    }
}

/// How long the distance effects take to follow the sung lines to their next place: the scroll's own
/// glide, which they move with.
const FOCUS_MS: f64 = 750.0;
/// How long the distance effects take to ease out while a reader scrolls, and back.
const EFFECTS_FADE_MS: f64 = 300.0;

/// A start time a host wrote onto a built line or part (`LineData.time`), which outlives a rebuild
/// of the same lyrics.
#[derive(Clone, Copy, Debug)]
struct TimeOverride {
    line: usize,
    part: Option<usize>,
    start_s: f32,
}

/// Offsets and options a host passes with the clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct TickOptions {
    pub lyric_offset_s: f64,
    pub global_offset_s: f64,
    /// Subtracted for richsync and for line-synced lyrics respectively, on top of the two above.
    pub richsync_trim_s: f64,
    pub line_trim_s: f64,
    pub rate: f64,
    pub smooth_scroll: bool,
    /// Unsynced lyrics drift down the page while the song plays.
    pub passive_scroll: bool,
}

pub enum Event {
    LyricsLoaded {
        line_count: usize,
        sync: SyncType,
    },
    LineClick {
        time_s: f64,
    },
    ScrollState {
        user_scrolling: bool,
    },
    /// The box around the sung lines on the stage, in container coordinates: x, y, width, height.
    StageLayout {
        area: Option<[f32; 4]>,
    },
}

pub struct View {
    pub host: HtmlElement,
    /// The document and window the host is in, which need not be the ones this module loaded in.
    pub doc: Document,
    pub win: Window,
    /// `performance.now()` in that window.
    pub now: dom::Now,
    pub canvas: HtmlCanvasElement,
    pub container: HtmlElement,
    gpu: Gpu,
    raster: Rasterizer,

    lyrics: Vec<Lyric>,
    /// Decorations hung on each line by the host, by line.
    hung: Vec<Hung>,
    time_overrides: Vec<TimeOverride>,
    options: LyricsOptions,
    settings: CommentSettings,
    /// The last stylesheet `set_theme` was given.
    theme_css: Option<String>,
    pub decorations: Decorations,
    theme: Theme,

    song: Option<Song>,
    dom: Option<LayoutDom>,
    measured: Option<Measured>,
    lines: Vec<LineState>,
    credits_texture: Option<LineTexture>,
    credits_focus: (bool, f64),
    /// Scroll glides running on the credits, which move with the lines.
    credits_curves: Vec<Curve>,
    /// The host elements the renderer moves with the credits, and where it last put them.
    riders: Vec<Rider>,
    /// Until when scroll events are taken for the page settling rather than a reader.
    settling_until: f64,
    /// Frames still to start before they stop being taken for it.
    settling_frames: u8,
    /// Whether the view watches its scroll element for readers itself. A host that reports scrolls
    /// (`noteUserScroll`) turns this off, as the DOM renderer left it to the host.
    pub own_scroll_detection: bool,
    prior: Option<Prior>,
    /// Image-highlight addresses already asked for, loaded or not.
    images_asked: std::collections::HashSet<String>,
    /// A rebuild of the lyrics on hand queued for the next frame, and whether it slides what moved.
    pending_refresh: Option<bool>,
    /// Bumped whenever the line elements change, so a host holding them knows to read them again.
    pub generation: u32,
    /// The roles the stage last marked on its elements.
    stage_roles: Vec<Role>,

    clock: Clock,
    pub media: Option<HtmlMediaElement>,
    manual_time: f64,
    manual_playing: bool,
    /// When `manual_time` was read off the player, as `Date.now()`; negative when it was not.
    /// While playing, the time is carried forward from then.
    manual_event_ms: f64,
    pub tick_options: TickOptions,
    /// The host says nothing of the view is on the screen (another tab, an ad), so no frames.
    pub hidden: bool,
    /// Where the pointer is over the lines, in client coordinates. The line under it is found each
    /// frame (`pointed_line`): lines glide and scroll beneath a pointer that rests.
    pointer: Option<(f32, f32)>,
    /// The time of the frame on the canvas, which a click is judged by.
    drawn_ms: f64,
    /// Whether any of the lines' container is on the page: false while the page hides the panel
    /// it is in (another tab of it showing, the player minimized), whatever the host says.
    pub on_page: bool,
    started: bool,
    last_lyric: f32,
    /// Another song was put up and has not been scrolled to yet: its first layout puts the scroll
    /// where it starts, at once, wherever the old song had it.
    fresh_song: bool,

    pub scroller: Option<Element>,
    /// The scroller's `scrollTop`, as last read. Reading it can make the browser lay the page out,
    /// so it is read again only after a scroll event, a write, or a change to the lines.
    scroll_cache: std::cell::Cell<Option<f32>>,
    autoscroll: AutoScroll,
    user_paused_until: f64,
    host_top_in_scroll: f32,
    /// When `host_top_in_scroll` was last read.
    host_checked_ms: f64,
    viewport: Viewport,
    canvas_size: (f32, f32),
    bleed_left: f32,
    /// Seconds of playback the passive scroll has accumulated, and the frame it last advanced on.
    passive: (f64, Option<f64>),

    dpr: f32,
    /// The window's device pixel ratio may no longer be `dpr` (see `Shared::watch_pixel_ratio`).
    pub pixel_ratio_changed: bool,
    /// When the ratio was last read anyway, in case no event says it changed.
    pixel_ratio_checked_ms: f64,
    needs_build: bool,
    needs_layout: bool,
    just_built: bool,
    /// The canvas's quads this frame, in the order they are drawn.
    quads: Vec<Quad>,
    /// What is drawn blurred this frame (see `gpu.rs`), and scratch space for a line's paint.
    blur_jobs: Vec<BlurJob>,
    line_quads: Vec<Quad>,
    line_under: Vec<Quad>,
    line_blurs: Vec<paint::Blur>,
    pub events: Vec<Event>,
    pub stats: Stats,
    pub profile: Profile,

    /// The theme's distance effects: where the sung lines are, and how strongly the effects apply
    /// (1, easing to 0 while a reader scrolls): (from, to, since).
    focus: Focus,
    effects: (f32, f32, f64),

    /// The stage layout: only the lines being sung, at the bottom of the element.
    pub stage: bool,
    stage_motion: Vec<stage::Motion>,
    stage_area: Option<[f32; 4]>,
}

/// What a frame costs, for profiling.
#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub frames: u64,
    /// Exponential average of the milliseconds a frame spends in the renderer.
    pub cpu_ms: f64,
    /// The slowest frame since the stats were last read.
    pub max_cpu_ms: f64,
    pub quads: usize,
    /// Lines whose texture is on the GPU, and the bytes the line pages take.
    pub resident: usize,
    pub texture_bytes: usize,
}

impl View {
    pub fn new(host: HtmlElement) -> Result<View, String> {
        let doc = dom::doc_of(&host);
        let win = dom::win_of(&host);
        install_stylesheet(&doc);
        host.class_list().add_1("brs-host").ok();
        let canvas: HtmlCanvasElement = element(&doc, "canvas", "brs-canvas").unchecked_into();
        set_style(&canvas, "height", "0px");
        let _ = canvas.set_attribute("aria-hidden", "true");
        let container = element(&doc, "div", "blyrics-container brs-layout");
        host.append_child(&canvas).map_err(|_| "append canvas")?;
        host.append_child(&container).map_err(|_| "append container")?;
        let gpu = Gpu::new(&canvas)?;
        let settings = CommentSettings::default();
        let theme = Theme::read(&container, settings.clone(), root_font_px(&doc));
        Ok(View {
            host,
            raster: Rasterizer::new(&doc),
            doc,
            now: dom::Now::of(&win),
            win,
            canvas,
            container,
            gpu,
            lyrics: Vec::new(),
            hung: Vec::new(),
            time_overrides: Vec::new(),
            options: LyricsOptions::default(),
            settings,
            theme_css: None,
            decorations: Decorations { translations: true, romanizations: true },
            theme,
            song: None,
            dom: None,
            measured: None,
            lines: Vec::new(),
            credits_texture: None,
            credits_focus: (false, 0.0),
            credits_curves: Vec::new(),
            riders: Vec::new(),
            settling_until: 0.0,
            settling_frames: 0,
            own_scroll_detection: true,
            prior: None,
            images_asked: Default::default(),
            pending_refresh: None,
            generation: 0,
            stage_roles: Vec::new(),
            clock: Clock::default(),
            media: None,
            manual_time: 0.0,
            manual_playing: false,
            manual_event_ms: -1.0,
            tick_options: TickOptions { rate: 1.0, smooth_scroll: true, ..Default::default() },
            hidden: false,
            pointer: None,
            drawn_ms: 0.0,
            on_page: true,
            started: false,
            last_lyric: 0.0,
            fresh_song: false,
            scroller: None,
            scroll_cache: Default::default(),
            autoscroll: AutoScroll::default(),
            user_paused_until: 0.0,
            host_top_in_scroll: 0.0,
            host_checked_ms: 0.0,
            viewport: Viewport::default(),
            canvas_size: (0.0, 0.0),
            bleed_left: 0.0,
            passive: (0.0, None),
            dpr: 1.0,
            pixel_ratio_changed: false,
            pixel_ratio_checked_ms: 0.0,
            needs_build: false,
            needs_layout: false,
            just_built: false,
            quads: Vec::new(),
            blur_jobs: Vec::new(),
            line_quads: Vec::new(),
            line_under: Vec::new(),
            line_blurs: Vec::new(),
            events: Vec::new(),
            stats: Stats::default(),
            profile: Profile::default(),
            focus: Focus::default(),
            effects: (1.0, 1.0, 0.0),
            stage: false,
            stage_motion: Vec::new(),
            stage_area: None,
        })
    }

    // -- Inputs --------------------------------------------

    /// A new song, built at once so its elements exist when this returns. Lyrics given with the
    /// `song_key` of the song on screen are swapped into it instead (see `swap`). Answers whether
    /// they are another song, so a caller whose last snapshot was the old song's can forget it
    /// (`reset_clock`). A time set by hand stays: `<braccato-lyrics>` sets it before its lyrics.
    pub fn set_lyrics(&mut self, lyrics: Vec<Lyric>, options: LyricsOptions) -> bool {
        let same_song = options.song_key.is_some() && options.song_key == self.options.song_key;
        if same_song && self.song.is_some() && !options.no_lyrics && !self.options.no_lyrics {
            self.swap(lyrics, options);
            return false;
        }
        if !same_song {
            self.last_lyric = 0.0;
            self.passive = (0.0, None);
            self.fresh_song = true;
        }
        self.hung = vec![Hung::default(); lyrics.len()];
        self.time_overrides.clear();
        self.lyrics = lyrics;
        self.options = options;
        self.autoscroll.reset();
        if self.user_paused_until > 0.0 {
            self.user_paused_until = 0.0;
            self.container.class_list().remove_1("blyrics-user-scrolling").ok();
            self.events.push(Event::ScrollState { user_scrolling: false });
        }
        self.started = false;
        self.clock.reset();
        self.build(false);
        !same_song
    }

    /// Lyrics for the song already on screen: lines the two share keep their elements, state and
    /// textures; a changed line is rebuilt in its old element and takes over its state; the line
    /// being followed, or the one a reader scrolled to, holds still while the rest slide to where
    /// they now are. A reader who scrolled away stays scrolled away.
    fn swap(&mut self, lyrics: Vec<Lyric>, options: LyricsOptions) {
        // Matched as given, without what the host hung on them: a translation is not part of what
        // makes two lines the same line.
        let bare = |lyrics: &[Lyric], options: &LyricsOptions| {
            song::build_song(lyrics, &[], options, &self.settings, self.decorations).lines
        };
        let origins = song::match_lines(&bare(&self.lyrics, &self.options), &bare(&lyrics, &options));
        // What was hung on a line goes with it.
        self.hung = origins.iter().map(|o| o.and_then(|o| self.hung.get(o).cloned()).unwrap_or_default()).collect();
        self.time_overrides.clear();
        self.lyrics = lyrics;
        self.options = options;
        let song = self.build_song();
        self.apply_song(song, &origins, true);
        self.layout();
    }

    /// Rebuilds the song on hand (after a host hung a decoration, changed the language or a line's
    /// time) and refills only the lines that came out different.
    fn refresh(&mut self, settle: bool) {
        if self.song.is_none() {
            return;
        }
        let mut song = self.build_song();
        self.apply_time_overrides(&mut song);
        let origins: Vec<Option<usize>> = (0..song.lines.len()).map(Some).collect();
        self.apply_song(song, &origins, settle);
    }

    /// Puts `song` on screen in place of the one there, given where each new line came from.
    fn apply_song(&mut self, song: Song, origins: &[Option<usize>], settle: bool) {
        self.settle_scrolls();
        let now = self.now.ms();
        let (Some(old_song), Some(old_dom)) = (self.song.take(), self.dom.take()) else { return };
        let scroll_top = self.scroll_top();
        let old_measured = self.measured.take();
        let mut old_states: Vec<Option<LineState>> = std::mem::take(&mut self.lines).into_iter().map(Some).collect();
        let mut old_lines: Vec<Option<LineDom>> = old_dom.lines.into_iter().map(Some).collect();
        for line in old_lines.iter().flatten() {
            line.element.remove();
        }
        let container = old_dom.container;
        let first_foreign = {
            let mut node = container.first_child();
            while let Some(n) = &node {
                if old_dom.credits.as_ref().is_some_and(|c| c.is_same_node(Some(n))) {
                    node = n.next_sibling();
                } else {
                    break;
                }
            }
            node
        };

        let mut lines = Vec::with_capacity(song.lines.len());
        let mut states = Vec::with_capacity(song.lines.len());
        let mut prior = Vec::with_capacity(song.lines.len());
        for (index, (line, origin)) in song.lines.iter().zip(origins).enumerate() {
            let old = origin.and_then(|o| Some((o, old_lines.get_mut(o)?.take()?, old_states.get_mut(o)?.take()?)));
            let (line_dom, state, layout) = match old {
                Some((o, line_dom, mut state)) => {
                    let before = &old_song.lines[o];
                    let line_dom = if before == line {
                        line_dom
                    } else {
                        let decorated = |l: &song::Line| (l.translation.clone(), l.romanization.clone(), l.rows.len());
                        if decorated(before) != decorated(line) {
                            state.decorated_ms = now;
                        }
                        layout::fill_line(&self.doc, line_dom.element, line, index, &self.theme)
                    };
                    dom::set_attr(&line_dom.element, "data-line-number", &index.to_string());
                    (line_dom, state, old_measured.as_ref().and_then(|m| m.lines.get(o).cloned()))
                }
                None => {
                    let fresh = layout::fill_line(&self.doc, element(&self.doc, "div", ""), line, index, &self.theme);
                    (fresh, LineState { decorated_ms: now, ..Default::default() }, None)
                }
            };
            let _ = container.insert_before(&line_dom.element, first_foreign.as_ref());
            lines.push(line_dom);
            states.push(state);
            prior.push(layout);
        }
        for state in old_states.into_iter().flatten() {
            if let Some(texture) = state.texture {
                self.gpu.release(texture);
            }
        }

        let same_credits = old_song.credits == song.credits;
        let credits = if same_credits {
            old_dom.credits
        } else {
            if let Some(old) = &old_dom.credits {
                old.remove();
            }
            if let Some(texture) = self.credits_texture.take() {
                self.gpu.release(texture);
            }
            layout::build_credits(&self.doc, &container, &song)
        };
        if let Some(credits) = &credits {
            let _ = container.insert_before(credits, first_foreign.as_ref());
        }

        self.autoscroll.remap(|old| origins.iter().position(|o| *o == Some(old)));
        if !self.stage_motion.is_empty() {
            let mut motions: Vec<stage::Motion> = origins
                .iter()
                .map(|o| {
                    o.and_then(|o| self.stage_motion.get(o).copied()).unwrap_or(stage::Motion::at_rest(0.0, false))
                })
                .collect();
            if let Some(credits_motion) = self.stage_motion.last().copied().filter(|_| song.credits.is_some()) {
                motions.push(credits_motion);
            }
            self.stage_motion = motions;
            self.stage_roles.clear();
        }
        layout::mark_container(&container, &song);
        let dom_ = LayoutDom { container, lines, credits };
        self.mark_stage(&song, &dom_);
        self.prior = Some(Prior {
            layouts: prior,
            credits: old_measured.and_then(|m| m.credits).filter(|_| same_credits),
            scroll_top,
            settle,
        });
        self.lines = states;
        self.song = Some(song);
        self.dom = Some(dom_);
        self.generation = self.generation.wrapping_add(1);
        self.needs_layout = true;
        self.just_built = true;
    }

    fn apply_time_overrides(&self, song: &mut Song) {
        for o in &self.time_overrides {
            let Some(line) = song.lines.get_mut(o.line) else { continue };
            match o.part {
                None => line.start_s = o.start_s,
                Some(part) => {
                    if let Some(part) = line.parts.get_mut(part) {
                        part.start_s = o.start_s;
                    }
                }
            }
        }
    }

    // -- What a host can do to the song on screen --------------------------------------------

    /// Hangs a translation on line `index`, or takes it off with `None`. Applied on the next frame,
    /// with every other decoration hung before it, sliding the lines it moves.
    pub fn hang_translation(&mut self, index: usize, translation: Option<(String, String)>) -> bool {
        let Some(hung) = self.hung.get_mut(index) else { return false };
        let had = hung.translation.is_some();
        if hung.translation != translation {
            hung.translation = translation;
            self.pending_refresh = Some(true);
        }
        had
    }

    /// Hangs a romanization on line `index`, timed if `parts` is given, or takes it off with `None`.
    pub fn hang_romanization(&mut self, index: usize, romanization: Option<(String, Option<Vec<LyricPart>>)>) -> bool {
        let Some(hung) = self.hung.get_mut(index) else { return false };
        let had = hung.romanization.is_some();
        if hung.romanization != romanization {
            hung.romanization = romanization;
            self.pending_refresh = Some(true);
        }
        had
    }

    /// A late-detected language for the lyrics, which only changes the lines it applies to.
    pub fn set_language(&mut self, language: Option<String>) {
        if self.options.language != language {
            self.options.language = language;
            self.pending_refresh = Some(self.pending_refresh.unwrap_or(false));
        }
    }

    /// Moves line `index`'s start, or with `part` one of its parts', in seconds.
    pub fn set_start(&mut self, index: usize, part: Option<usize>, start_s: f32) {
        let Some(line) = self.song.as_mut().and_then(|s| s.lines.get_mut(index)) else { return };
        match part {
            None => line.start_s = start_s,
            Some(p) => match line.parts.get_mut(p) {
                Some(part) => part.start_s = start_s,
                None => return,
            },
        }
        self.time_overrides.retain(|o| (o.line, o.part) != (index, part));
        self.time_overrides.push(TimeOverride { line: index, part, start_s });
    }

    /// Line `index`'s start and duration, or with `part` one of its parts', in seconds.
    pub fn timing(&self, index: usize, part: Option<usize>) -> Option<(f32, f32)> {
        let line = self.song.as_ref()?.lines.get(index)?;
        match part {
            None => Some((line.start_s, line.duration_s)),
            Some(p) => line.parts.get(p).map(|p| (p.start_s, p.duration_s)),
        }
    }

    /// The element of every line, and of every part in it.
    pub fn line_elements(&self) -> Vec<(HtmlElement, Vec<HtmlElement>)> {
        self.dom
            .as_ref()
            .map(|d| d.lines.iter().map(|l| (l.element.clone(), l.words.clone())).collect())
            .unwrap_or_default()
    }

    pub fn line_index(&self, element: &Element) -> Option<usize> {
        self.dom.as_ref()?.lines.iter().position(|l| l.element.is_same_node(Some(element)))
    }

    pub fn has_song(&self) -> bool {
        self.song.is_some()
    }

    pub fn sync_type(&self) -> Option<SyncType> {
        self.song.as_ref().map(|s| s.sync)
    }

    /// Takes the lines off the screen, keeping the container and what the host put in it. Answers
    /// whether there were any.
    pub fn clear_on_screen(&mut self) -> bool {
        self.settle_scrolls();
        let had = self.dom.as_ref().is_some_and(|d| !d.lines.is_empty() || d.credits.is_some());
        if let Some(dom_) = self.dom.take() {
            for line in &dom_.lines {
                line.element.remove();
            }
            if let Some(credits) = &dom_.credits {
                credits.remove();
            }
        }
        self.drop_song();
        had
    }

    /// Drops the song and the container, which `set_lyrics` builds again.
    pub fn clear(&mut self) {
        self.dom = None;
        self.drop_song();
        while let Some(child) = self.container.first_child() {
            let _ = self.container.remove_child(&child);
        }
        self.container.remove();
    }

    fn drop_song(&mut self) {
        self.release_textures();
        self.song = None;
        self.measured = None;
        self.prior = None;
        self.lines.clear();
        self.lyrics.clear();
        self.hung.clear();
        self.time_overrides.clear();
        self.riders.clear();
        self.stage_motion.clear();
        self.stage_roles.clear();
        self.options.song_key = None;
        self.generation = self.generation.wrapping_add(1);
        self.gpu.begin();
        self.gpu.draw_canvas(&[]);
        self.gpu.end();
    }

    /// Moves the view into `host`: the canvas and the container go with it.
    pub fn set_host(&mut self, host: HtmlElement) {
        if !self.host.is_same_node(Some(&host)) {
            self.host.class_list().remove_1("brs-host").ok();
            host.class_list().add_1("brs-host").ok();
            self.host = host;
        }
        if !self.host.is_same_node(self.canvas.parent_node().as_ref()) {
            let _ = self.host.append_child(&self.canvas);
        }
        if !self.host.is_same_node(self.container.parent_node().as_ref()) {
            let _ = self.host.append_child(&self.container);
        }
        self.needs_layout = true;
    }

    pub fn set_theme(&mut self, css: &str) {
        if self.theme_css.as_deref() == Some(css) {
            return;
        }
        self.theme_css = Some(css.to_string());
        let doc = self.doc.clone();
        let style_el = doc.get_element_by_id("blyrics-custom-style").unwrap_or_else(|| {
            let el = element(&doc, "style", "");
            el.set_id("blyrics-custom-style");
            if let Some(head) = doc.head() {
                let _ = head.append_child(&el);
            }
            el.into()
        });
        style_el.set_text_content(Some(css));
        self.settings = CommentSettings::parse(css);
        self.needs_build = true;
    }

    pub fn set_time(&mut self, seconds: f64, playing: bool) {
        self.manual_time = seconds;
        self.manual_playing = playing;
        self.manual_event_ms = -1.0;
    }

    /// A player snapshot: the time it showed, whether it was playing, and when it was read, as
    /// `Date.now()`, so frames between snapshots carry it forward. Returns whether it can change what
    /// is drawn: a host ticks many times a second, and each frame asked for redraws the whole view.
    pub fn set_snapshot(&mut self, seconds: f64, playing: bool, event_ms: f64) -> bool {
        let flipped = playing != self.manual_playing;
        let changed = flipped || seconds != self.manual_time;
        self.manual_time = seconds;
        self.manual_playing = playing;
        self.manual_event_ms = event_ms;
        let Some(song) = &self.song else { return false };
        if self.stage {
            return true;
        }
        if song.no_lyrics {
            // The message is drawn the same at any time.
            return false;
        }
        if song.sync == SyncType::None {
            // Only the passive drift follows the player, and only whether it plays.
            return flipped;
        }
        // Playing, the frames run on their own; paused, only a move shows.
        changed
    }

    /// Forgets the player's time, as a new song should, as 1.x's `resetPlaybackClock` did.
    pub fn reset_clock(&mut self) {
        self.clock.reset();
        self.manual_time = 0.0;
        self.manual_playing = false;
        self.manual_event_ms = -1.0;
    }

    pub fn set_profiling(&mut self, on: bool) -> bool {
        self.profile.set(if on { self.win.performance() } else { None });
        self.gpu.set_profiling(on)
    }

    /// The frames profiled since the last call, and the GPU times of those timed.
    pub fn take_profile(&mut self) -> (Vec<f32>, Vec<f32>) {
        (self.profile.take(), self.gpu.take_gpu_samples())
    }

    pub fn gpu_ms(&self) -> Option<f64> {
        self.gpu.gpu_ms()
    }

    pub fn invalidate_layout(&mut self) {
        self.needs_layout = true;
    }

    /// The page showed or hid the lines' container. Shown again, the lines are measured and the
    /// scroll set from scratch, since anything may have changed meanwhile.
    pub fn set_on_page(&mut self, on_page: bool) {
        if on_page && !self.on_page {
            self.needs_layout = true;
            self.autoscroll.force = true;
        }
        self.on_page = on_page;
        if !on_page {
            self.pointer = None;
        }
    }

    /// The song from the lyrics on hand, with the theme's no-lyrics message and icon in place of
    /// the host's message.
    fn build_song(&self) -> Song {
        let message = self.theme.no_lyrics_text.as_ref().filter(|_| self.options.no_lyrics);
        let replaced: Vec<Lyric>;
        let lyrics = match message {
            Some(text) => {
                replaced = self
                    .lyrics
                    .iter()
                    .take(1)
                    .map(|l| Lyric { words: text.clone(), parts: None, ..l.clone() })
                    .collect();
                &replaced
            }
            None => &self.lyrics,
        };
        let mut song = song::build_song(lyrics, &self.hung, &self.options, &self.settings, self.decorations);
        if song.no_lyrics {
            if let Some(first) = song.lines.first_mut() {
                first.icon = self.theme.no_lyrics_icon.clone();
            }
        }
        song
    }

    fn read_theme(&mut self) {
        self.theme = Theme::read(&self.container, self.settings.clone(), root_font_px(&self.doc));
        if let Some(url) = &self.theme.highlight_image {
            self.theme.highlight_image_ready = self.raster.images.contains_key(url);
        }
    }

    /// An image the theme wants that has not been loaded or asked for yet; asking marks it asked.
    pub fn take_wanted_image(&mut self) -> Option<String> {
        let url = self.theme.highlight_image.clone()?;
        if self.raster.images.contains_key(&url) || !self.images_asked.insert(url.clone()) {
            return None;
        }
        Some(url)
    }

    /// An image finished loading: lines are measured and drawn again with it.
    pub fn image_loaded(&mut self, url: String, image: web_sys::HtmlImageElement) {
        self.raster.images.insert(url, image);
        self.needs_layout = true;
    }

    /// Measures again on the next frame, and with `settle` slides the lines that moved from where
    /// they are now, holding the one in view still: for after something the host put in the
    /// container changed size.
    pub fn relayout(&mut self, settle: bool) {
        if settle && self.prior.is_none() {
            if let Some(measured) = &self.measured {
                self.prior = Some(Prior {
                    layouts: measured.lines.iter().cloned().map(Some).collect(),
                    credits: measured.credits.clone(),
                    scroll_top: self.scroll_top(),
                    settle: true,
                });
            }
        }
        self.needs_layout = true;
    }

    /// The elements whose size, if it changes, means the layout must be measured again: the
    /// container and every line. Fonts finishing late, a system fallback face or a page rule can each
    /// move text inside a line without changing anything else.
    pub fn observed_elements(&self) -> Vec<Element> {
        let mut elements: Vec<Element> = vec![self.container.clone().into()];
        if let Some(dom_) = &self.dom {
            elements.extend(dom_.lines.iter().map(|line| line.element.clone().into()));
        }
        elements
    }

    pub fn take_built(&mut self) -> bool {
        std::mem::take(&mut self.just_built)
    }

    pub fn rebuild(&mut self) {
        self.needs_build = true;
    }

    pub fn resume_autoscroll(&mut self) {
        if self.user_paused_until > 0.0 {
            self.user_paused_until = 0.0;
            self.autoscroll.force = true;
            self.container.class_list().remove_1("blyrics-user-scrolling").ok();
            self.events.push(Event::ScrollState { user_scrolling: false });
        }
    }

    fn scroll_top(&self) -> f32 {
        if let Some(top) = self.scroll_cache.get() {
            return top;
        }
        let top = match &self.scroller {
            Some(el) => el.scroll_top() as f32,
            None => self.win.scroll_y().unwrap_or(0.0) as f32,
        };
        self.scroll_cache.set(Some(top));
        top
    }

    /// Where the canvas's top is in the lyrics, for a scroll position: it sticks to the view's top,
    /// within the lyrics.
    fn canvas_top_at(&self, scroll_top: f32) -> f32 {
        let content = self.measured.as_ref().map(|m| m.content_height).unwrap_or(0.0);
        (scroll_top - self.host_top_in_scroll).clamp(0.0, (content - self.canvas_size.1).max(0.0))
    }

    /// The scroller scrolled, or may have: the next `scroll_top` reads it.
    pub fn scroll_changed(&self) {
        self.scroll_cache.set(None);
    }

    fn write_scroll_top(&mut self, value: f32) {
        if self.hidden || !self.on_page {
            return;
        }
        match &self.scroller {
            Some(el) => el.set_scroll_top(value.round() as i32),
            None => self.win.scroll_to_with_x_and_y(self.win.scroll_x().unwrap_or(0.0), value.round() as f64),
        }
        // Read back: the browser may have clamped it.
        self.scroll_changed();
        self.autoscroll.last_written = Some(self.scroll_top());
    }

    /// The page is about to move under the scroll element (lines built, measured, taken away), so
    /// scrolls for a moment are its doing.
    fn settle_scrolls(&mut self) {
        self.settling_until = self.now.ms() + SETTLING_SCROLL_MS;
        self.settling_frames = SETTLING_SCROLL_FRAMES;
    }

    /// A scroll event: if it is not the one autoscroll just caused, nor the page settling after the
    /// lines changed, a reader is scrolling.
    pub fn on_scroll(&mut self, now_ms: f64) {
        // A host's listener can run before the view's own, which is what marks the position stale.
        self.scroll_changed();
        let top = self.scroll_top();
        let ours = self.autoscroll.last_written.is_some_and(|w| (w - top).abs() <= 1.0);
        let settling = now_ms < self.settling_until || self.settling_frames > 0;
        if ours || settling || self.song.as_ref().is_none_or(|s| s.no_lyrics) {
            return;
        }
        let unsynced = self.song.as_ref().is_some_and(|s| s.sync == SyncType::None);
        let pause = if unsynced { USER_SCROLL_PAUSE_UNSYNCED_MS } else { USER_SCROLL_PAUSE_MS };
        self.user_paused_until = now_ms + pause;
        self.autoscroll.last_written = None;
        self.container.class_list().add_1("blyrics-user-scrolling").ok();
        // On every scroll, as the DOM renderer told it: a host may have hidden its resume button
        // since the pause began.
        self.events.push(Event::ScrollState { user_scrolling: true });
    }

    /// The pointer moved to `client`, or off the lines. Returns whether that changes the hovered
    /// line, and so wants a frame.
    pub fn set_pointer(&mut self, client: Option<(f32, f32)>) -> bool {
        let entered = self.pointer.is_some() != client.is_some();
        self.pointer = client;
        let Some(song) = &self.song else { return false };
        (entered && self.theme.line_opacity_browsing.is_some())
            || self.pointed_line(song, self.now.ms()) != self.lines.iter().position(|state| state.hover.to == 1.0)
    }

    /// Whether the line under the pointer matters: the theme has a hover look (a shadow of the
    /// hovered line's among them), or the browsing opacity leaves that line alone.
    fn tracks_hover(&self) -> bool {
        self.theme.tracks_hover() || self.measured.as_ref().is_some_and(|m| m.hover_shadows)
    }

    /// The line drawn under the pointer, if the theme has a hover look.
    fn pointed_line(&self, song: &Song, now_ms: f64) -> Option<usize> {
        if self.stage || song.no_lyrics || !self.tracks_hover() {
            return None;
        }
        self.line_at(self.pointer?, now_ms)
    }

    /// The line drawn at `client`. Not the element there: while a glide runs the lines are drawn
    /// away from their boxes, which are already at its end.
    fn line_at(&self, client: (f32, f32), now_ms: f64) -> Option<usize> {
        let measured = self.measured.as_ref()?;
        let origin = self.container.get_bounding_client_rect();
        let (x, y) = (client.0 - origin.left() as f32, client.1 - origin.top() as f32);
        measured.lines.iter().zip(&self.lines).position(|(layout, state)| {
            let top = layout.top + state.glide_offset(now_ms);
            (top..top + layout.height).contains(&y) && (layout.left..layout.left + layout.width).contains(&x)
        })
    }

    /// The line a click meant: the one drawn where it landed, or its element's when it has no
    /// position (a keyboard, a script) or nothing glides.
    fn clicked_line(&self, target: &Element, client: Option<(f32, f32)>, drawn_ms: f64) -> Option<usize> {
        let of_target =
            || target.closest(".blyrics--line").ok().flatten()?.get_attribute("data-line-number")?.parse().ok();
        let gliding = !self.stage && self.lines.iter().any(|state| !state.curves.is_empty());
        let Some(client) = client.filter(|_| gliding) else { return of_target() };
        if target.closest(".blyrics--line").ok().flatten().is_none() {
            // A glide can draw a line over the container's padding or the credits' text. Anything
            // else there is the host's, and a drag that selected text across lines is no click.
            let ours = target.is_same_node(Some(&self.container))
                || target
                    .matches(".blyrics-credits, .blyrics-credits__text, .blyrics-credits__text *")
                    .unwrap_or(false);
            let selected = self.win.get_selection().ok().flatten().is_some_and(|selection| !selection.is_collapsed());
            if !ours || selected {
                return None;
            }
        }
        self.line_at(client, drawn_ms)
    }

    /// A click on a line: the player time it seeks to, if any.
    pub fn on_click(&mut self, target: &Element, alt: bool, client: Option<(f32, f32)>) -> Option<f64> {
        let song = self.song.as_ref()?;
        if song.sync == SyncType::None || song.no_lyrics {
            return None;
        }
        // What was clicked is what the last frame drew: the glides have moved on since.
        let drawn = self.drawn_ms;
        let index = self.clicked_line(target, client, drawn)?;
        let line = song.lines.get(index)?;
        let mut time = line.start_s as f64;
        if let (true, SyncType::Richsync, Some(client)) = (alt, song.sync, client) {
            let layout = self.measured.as_ref()?.lines.get(index)?;
            let origin = self.container.get_bounding_client_rect();
            let top = layout.top + self.lines.get(index)?.glide_offset(drawn);
            let (px, py) = (client.0 - origin.left() as f32 - layout.left, client.1 - origin.top() as f32 - top);
            let nearest = layout
                .slots
                .iter()
                .filter_map(|slot| match slot.owner {
                    Owner::Part(p) => Some((p, slot.rect)),
                    _ => None,
                })
                .min_by(|a, b| distance(a.1, px, py).total_cmp(&distance(b.1, px, py)));
            if let Some((part, _)) = nearest {
                time = line.parts[part].start_s as f64;
            }
        }
        let player_time = (time - self.lyric_shift(song.sync)).max(0.0);
        if let Some(media) = &self.media {
            media.set_current_time(player_time);
        } else {
            self.manual_time = player_time;
        }
        self.resume_autoscroll();
        self.autoscroll.force = true;
        self.events.push(Event::LineClick { time_s: player_time });
        Some(player_time)
    }

    fn lyric_shift(&self, sync: SyncType) -> f64 {
        let o = &self.tick_options;
        let base = if sync == SyncType::Richsync {
            self.theme.richsync_offset_s as f64 - o.richsync_trim_s
        } else {
            self.theme.line_offset_s as f64 - o.line_trim_s
        };
        base - o.global_offset_s - o.lyric_offset_s
    }

    // -- Building and layout --------------------------------------------

    /// Builds the lines from scratch. `keep_host` keeps what the host added to the container and to
    /// the credits; new lyrics clear it, as the DOM renderer does.
    fn build(&mut self, keep_host: bool) {
        if !keep_host {
            // Another song: its lines may be put where no `pointerleave` was sent from.
            self.pointer = None;
        }
        self.scroll_changed();
        self.needs_build = false;
        self.settle_scrolls();
        self.pending_refresh = None;
        if !self.host.is_same_node(self.container.parent_node().as_ref()) {
            let _ = self.host.append_child(&self.container);
        }
        self.hung.resize(self.lyrics.len(), Hung::default());
        // The theme is read with the container marked for this song (`data-sync`,
        // `data-no-lyrics`), so what a theme scopes by them applies. The no-lyrics message and icon
        // are part of the song, so a no-lyrics song is built again once they are read.
        let mut song = self.build_song();
        layout::mark_container(&self.container, &song);
        self.read_theme();
        if song.no_lyrics {
            song = self.build_song();
        }
        self.apply_time_overrides(&mut song);
        self.release_textures();
        let old_dom = self.dom.take().filter(|_| keep_host);
        let mut host_in_credits = Vec::new();
        if let Some(old) = &old_dom {
            for line in &old.lines {
                line.element.remove();
            }
            if let Some(credits) = &old.credits {
                host_in_credits = layout::host_children(credits);
                credits.remove();
            }
        }
        let dom_ = layout::build_dom(&self.doc, &self.container, &song, &self.theme, old_dom.is_some());
        if let Some(credits) = &dom_.credits {
            for node in host_in_credits {
                let _ = credits.append_child(&node);
            }
        }
        self.mark_stage(&song, &dom_);
        self.stage_motion.clear();
        self.stage_roles.clear();
        self.stage_area = None;
        let now = self.now.ms();
        // A rebuild of the same lyrics keeps how far each line has eased to its hover look and the
        // browsing opacity, so neither the line under the pointer nor a dimmed view flashes.
        let eased: Vec<(Tween, Tween)> =
            if keep_host { self.lines.iter().map(|state| (state.hover, state.browse)).collect() } else { Vec::new() };
        self.lines = (0..song.lines.len())
            .map(|i| {
                let (hover, browse) = eased.get(i).copied().unwrap_or_default();
                LineState { decorated_ms: now, hover, browse, ..Default::default() }
            })
            .collect();
        self.events.push(Event::LyricsLoaded { line_count: song.lines.len(), sync: song.sync });
        self.song = Some(song);
        self.dom = Some(dom_);
        self.measured = None;
        self.prior = None;
        self.riders.clear();
        self.credits_focus = (false, 0.0);
        self.needs_layout = true;
        self.just_built = true;
        self.generation = self.generation.wrapping_add(1);
    }

    /// Stage attributes: the layout on the container, and in a duet which side each singer takes.
    fn mark_stage(&self, song: &Song, dom_: &LayoutDom) {
        let container = &self.container;
        if !self.stage {
            let _ = container.remove_attribute("data-layout");
            let _ = container.remove_attribute("data-stage-duet");
            return;
        }
        let _ = container.set_attribute("data-layout", "stage");
        let second = |agent: Option<&str>| matches!(agent, Some("v2") | Some("v3"));
        let sung: Vec<&song::Line> =
            song.lines.iter().filter(|l| l.has_text() && l.agent.as_deref() != Some("v1000")).collect();
        let duet = sung.iter().any(|l| second(l.agent.as_deref())) && sung.iter().any(|l| !second(l.agent.as_deref()));
        if duet {
            let _ = container.set_attribute("data-stage-duet", "true");
        } else {
            let _ = container.remove_attribute("data-stage-duet");
        }
        for (line, line_dom) in song.lines.iter().zip(&dom_.lines) {
            let side = match (duet, line.agent.as_deref()) {
                (false, _) | (_, Some("v1000")) => "center",
                (true, agent) => {
                    if second(agent) != line.rtl {
                        "right"
                    } else {
                        "left"
                    }
                }
            };
            let _ = line_dom.element.set_attribute("data-stage-side", side);
        }
    }

    fn release_textures(&mut self) {
        for state in &mut self.lines {
            if let Some(texture) = state.texture.take() {
                self.gpu.release(texture);
            }
        }
        if let Some(texture) = self.credits_texture.take() {
            self.gpu.release(texture);
        }
    }

    fn layout(&mut self) {
        self.scroll_changed();
        self.needs_layout = false;
        if self.song.is_none() || self.dom.is_none() {
            return;
        }
        // Lines the page is not rendering measure as nothing at the origin, which every scroll
        // target would then be read off. The measurement waits until they are on the screen.
        if self.container.get_client_rects().length() == 0 {
            self.needs_layout = true;
            return;
        }
        self.settle_scrolls();
        let prior = self.prior.take().unwrap_or_else(|| Prior {
            layouts: self.measured.take().map(|m| m.lines.into_iter().map(Some).collect()).unwrap_or_default(),
            credits: None,
            scroll_top: self.scroll_top(),
            settle: false,
        });
        self.read_theme();
        self.measure_viewport();
        let (Some(song), Some(dom_)) = (&self.song, &self.dom) else { return };
        let mut measured = layout::measure(dom_, song, &self.theme, root_font_px(&self.doc));

        // Room above the first line and below the last so both can reach the target position, handed
        // over as the DOM renderer did: the top only as `--blyrics-padding-top`, for the page's CSS
        // to use or not (core's stylesheet keeps a fixed 2rem, so the first lines start above the
        // target; Better Lyrics uses the variable in fullscreen), and the bottom as
        // `--blyrics-padding-bottom` and inline, where no theme can take it away. The DOM renderer
        // set them on the root; here they go on the host, which the container inherits them from,
        // so two views in one document do not overwrite each other's.
        let padding = |name: &str| dom::px(&dom::computed_value(&self.container, name));
        let old_top = padding("padding-top");
        let _ = self.container.style().remove_property("padding-top");
        if !self.stage {
            let host = self.host.clone();
            let publish = |name: &str, value: f32| set_style(&host, name, &format!("{value}px"));
            let (top, bottom) = if song.no_lyrics || measured.lines.is_empty() {
                (0.0, 0.0)
            } else {
                let vh = self.viewport.height;
                let ratio = self.theme.target_scroll_ratio;
                let top = (vh * ratio - measured.lines[0].height / 2.0).max(0.0);
                publish("--blyrics-padding-top", top);
                // The bottom is sized against whatever top the CSS made of that.
                let actual_top = padding("padding-top");
                let last = measured.credits.as_ref().filter(|c| c.height > 0.0).or(measured.lines.last()).unwrap();
                let old_bottom = padding("padding-bottom");
                let content = measured.content_height - old_bottom - old_top + actual_top;
                let last_centre = last.top - old_top + actual_top + last.height / 2.0;
                let below = vh * (1.0 - ratio);
                // A host's footer after the lyrics (`.blyrics-footer`) counts toward the room below.
                let footer = self
                    .container
                    .query_selector(":scope > .blyrics-footer")
                    .ok()
                    .flatten()
                    .map(|f| f.get_bounding_client_rect().height() as f32)
                    .unwrap_or(0.0);
                let bottom = (last_centre + below - content)
                    .max(vh - content)
                    .max(below - (footer + last.height / 2.0))
                    .max(0.0)
                    .ceil();
                (top, bottom)
            };
            publish("--blyrics-padding-top", top);
            publish("--blyrics-padding-bottom", bottom);
            set_style(&self.container, "padding-bottom", &format!("{bottom}px"));
        }
        let shift = padding("padding-top") - old_top;
        for line in measured.lines.iter_mut().chain(measured.credits.iter_mut()) {
            line.top += shift;
        }
        measured.content_height = self.container.get_bounding_client_rect().height() as f32;
        if self.stage {
            // On the stage a line scales about its centre, or the side its singer stands on.
            for (layout, line_dom) in measured.lines.iter_mut().zip(&dom_.lines) {
                layout.origin_x = match line_dom.element.get_attribute("data-stage-side").as_deref() {
                    Some("left") => 0.0,
                    Some("right") => layout.width,
                    _ => layout.width / 2.0,
                };
            }
        }
        self.measure_viewport();

        // A line that draws the same keeps its texture; one that changed is drawn again.
        for (index, layout) in measured.lines.iter_mut().enumerate() {
            match prior.layouts.get(index).and_then(Option::as_ref) {
                Some(old) if layout.same_ink(old) && self.lines[index].texture.is_some() => {
                    layout.adopt_placements(old)
                }
                _ => {
                    if let Some(texture) = self.lines[index].texture.take() {
                        self.gpu.release(texture);
                    }
                }
            }
        }
        match (measured.credits.as_mut(), prior.credits.as_ref()) {
            (Some(layout), Some(old)) if layout.same_ink(old) && self.credits_texture.is_some() => {
                layout.adopt_placements(old)
            }
            _ => {
                if let Some(texture) = self.credits_texture.take() {
                    self.gpu.release(texture);
                }
            }
        }
        if prior.settle && !self.stage {
            self.settle(&prior, &measured);
        }
        self.riders = self.find_riders();
        self.measured = Some(measured);
        self.autoscroll.force = true;
    }

    /// After a rebuild: scrolls by however far the line in view moved, so it holds still, and
    /// slides every other line from where it was to where it now is.
    fn settle(&mut self, prior: &Prior, measured: &Measured) {
        let now = self.now.ms();
        let following = self.user_paused_until <= now;
        let view_top = prior.scroll_top - self.host_top_in_scroll;
        let had = |i: usize| prior.layouts.get(i).and_then(Option::as_ref);
        let anchor = self
            .autoscroll
            .followed()
            .filter(|&i| following && had(i).is_some())
            .or_else(|| (0..measured.lines.len()).find(|&i| had(i).is_some_and(|l| l.top + l.height > view_top)));
        if let Some(anchor) = anchor {
            let moved = measured.lines[anchor].top - had(anchor).map(|l| l.top).unwrap_or(0.0);
            if moved.abs() >= 0.5 {
                self.write_scroll_top(prior.scroll_top + moved);
            }
        }
        if self.theme.reduced_motion || !self.theme.animate_decoration_entry {
            return;
        }
        let scroll_top = self.scroll_top();
        let slide = |old_top: f32, new_top: f32| -> Option<Curve> {
            let from = (old_top - prior.scroll_top) - (new_top - scroll_top);
            (from.abs() >= 0.5).then_some(Curve {
                from,
                start_ms: now,
                duration_ms: SETTLE_MS,
                easing: DECORATION_EASE,
            })
        };
        for (index, layout) in measured.lines.iter().enumerate() {
            if let Some(curve) = had(index).and_then(|old| slide(old.top, layout.top)) {
                self.lines[index].curves.push(curve);
            }
        }
        if let (Some(new), Some(old)) = (&measured.credits, &prior.credits) {
            if let Some(curve) = slide(old.top, new.top) {
                self.credits_curves.push(curve);
            }
        }
    }

    /// What the host put among the lines, which the renderer moves along with what it draws: things
    /// inside the credits (a source card) go with the credits, and things after the lines in the
    /// container (a footer) glide with the last of them, so they do not jump ahead when autoscroll
    /// does.
    fn find_riders(&self) -> Vec<Rider> {
        let Some(dom_) = &self.dom else { return Vec::new() };
        let mut riders = Vec::new();
        if let Some(credits) = &dom_.credits {
            let children = credits.children();
            riders.extend(
                (0..children.length())
                    .filter_map(|i| children.item(i))
                    .filter(|child| !child.class_list().contains("blyrics-credits__text"))
                    .map(|child| Rider::new(child, true)),
            );
        }
        if !self.stage {
            let children = dom_.container.children();
            riders.extend(
                (0..children.length())
                    .filter_map(|i| children.item(i))
                    .filter(|child| {
                        !child.class_list().contains("blyrics--line")
                            && dom_.credits.as_ref().is_none_or(|c| !c.is_same_node(Some(child)))
                    })
                    .map(|child| Rider::new(child, false)),
            );
        }
        riders
    }

    /// Moves the riders in the credits by `credits_dy` from where the page laid them out, at
    /// `opacity`, and the ones after the lines by `tail_dy`.
    fn place_riders(&mut self, credits_dy: f32, opacity: f32, tail_dy: f32) {
        let mut changed = false;
        for rider in &mut self.riders {
            let (dy, opacity) = if rider.in_credits { (credits_dy, opacity) } else { (tail_dy, 1.0) };
            if (rider.last.0 - dy).abs() < 0.25 && (rider.last.1 - opacity).abs() < 0.002 {
                continue;
            }
            rider.last = (dy, opacity);
            changed |= rider.in_credits;
            if dy.abs() < 0.25 {
                let _ = rider.element.style().remove_property("translate");
            } else {
                set_style(&rider.element, "translate", &format!("0 {dy:.2}px"));
            }
        }
        // The opacity goes on the credits, as the DOM renderer's stage set it: its stylesheet hides
        // whatever the stage has not made visible, riders and all.
        let Some(credits) = self.dom.as_ref().and_then(|d| d.credits.as_ref()) else { return };
        if changed {
            set_style(credits, "--blyrics-stage-opacity", &format!("{opacity:.3}"));
            if opacity > 0.001 {
                dom::set_attr(credits, "data-stage-visible", "");
            } else {
                let _ = credits.remove_attribute("data-stage-visible");
            }
        }
    }

    /// Where the view is: the scroll element's size and the canvas that covers it.
    fn measure_viewport(&mut self) {
        let window = self.win.clone();
        let host_rect = self.host.get_bounding_client_rect();
        let (view_height, view_top, view_left, view_right, scroll_top) = match &self.scroller {
            Some(el) => {
                let rect = el.get_bounding_client_rect();
                let left = rect.left() as f32 + el.client_left() as f32;
                let top = rect.top() as f32 + el.client_top() as f32;
                (el.client_height() as f32, top, left, left + el.client_width() as f32, el.scroll_top() as f32)
            }
            None => {
                let height = window.inner_height().ok().and_then(|v| v.as_f64()).unwrap_or(800.0) as f32;
                let left = (host_rect.left() as f32 - 64.0).max(0.0);
                let right = host_rect.right() as f32 + (host_rect.left() as f32 - left);
                (height, 0.0, left, right, window.scroll_y().unwrap_or(0.0) as f32)
            }
        };
        self.host_top_in_scroll = host_rect.top() as f32 - self.host_translation() - view_top + scroll_top;
        let (inset_top, inset_bottom) = self.scroll_insets(view_height);
        let content = self.container.get_bounding_client_rect().height() as f32;
        self.viewport = Viewport {
            height: view_height,
            inset_top,
            inset_bottom,
            max_scroll: match &self.scroller {
                Some(el) => (el.scroll_height() - el.client_height()) as f32,
                None => self
                    .doc
                    .document_element()
                    .map(|d| (d.scroll_height() as f32 - view_height).max(0.0))
                    .unwrap_or(0.0),
            },
        };
        if self.stage {
            // The stage is the element itself, and the canvas covers it.
            let (width, height) = (self.host.client_width() as f32, self.host.client_height() as f32);
            self.bleed_left = 0.0;
            self.canvas_size = (width, height);
            for (property, value) in [
                ("position", "absolute".to_string()),
                ("top", "0".into()),
                ("left", "0".into()),
                ("margin", "0".into()),
                ("width", format!("{width}px")),
                ("height", format!("{height}px")),
            ] {
                set_style(&self.canvas, property, &value);
            }
            self.set_pixel_ratio(window.device_pixel_ratio() as f32);
            self.gpu.resize(&self.canvas, width, height, self.dpr);
            return;
        }
        for property in ["position", "top", "left", "margin"] {
            let _ = self.canvas.style().remove_property(property);
        }
        // The canvas sits in the host's content box, so it bleeds out from that, not the border box.
        let inset = |name: &str| dom::px(&dom::computed_value(&self.host, name));
        let content_left = host_rect.left() as f32 + self.host.client_left() as f32 + inset("padding-left");
        let content_width = (self.host.client_width() as f32 - inset("padding-left") - inset("padding-right")).max(0.0);
        self.bleed_left = (content_left - view_left).max(0.0);
        let bleed_right = (view_right - content_left - content_width).max(0.0);
        let width = content_width + self.bleed_left + bleed_right;
        let height = view_height.min(content.max(1.0));
        self.canvas_size = (width, height);
        set_style(&self.canvas, "width", &format!("{width}px"));
        set_style(&self.canvas, "height", &format!("{height}px"));
        set_style(&self.canvas, "margin-left", &format!("{}px", -self.bleed_left));
        set_style(&self.canvas, "margin-bottom", &format!("{}px", -height));
        self.set_pixel_ratio(window.device_pixel_ratio() as f32);
        self.gpu.resize(&self.canvas, width, height, self.dpr);
    }

    /// Lines rasterized at another ratio would draw blurred or oversized: they are drawn again.
    fn set_pixel_ratio(&mut self, dpr: f32) {
        if (dpr - self.dpr).abs() > 1e-3 {
            self.dpr = dpr;
            self.release_textures();
        }
    }

    /// How far translations on the host and the elements between it and the scroll element move it.
    /// A page can slide the lyrics in that way (Better Lyrics does, as its loader leaves a new song),
    /// but neither the scroll position nor the canvas's sticky position moves with it: both work on
    /// the page's layout before transforms, so where the host is in the scroller is read without them.
    fn host_translation(&self) -> f32 {
        let mut shift = 0.0;
        let mut node: Option<web_sys::Element> = Some(self.host.clone().into());
        while let Some(element) = node {
            if self.scroller.as_ref().is_some_and(|s| s.is_same_node(Some(&element))) {
                break;
            }
            shift += dom::translated_y(&element);
            node = dom::parent_across_shadow(&element);
        }
        shift
    }

    /// Where the element's top is in the scroll element's content.
    fn host_top_now(&self) -> f32 {
        let host = self.host.get_bounding_client_rect().top() as f32 - self.host_translation();
        match &self.scroller {
            Some(el) => {
                let rect = el.get_bounding_client_rect();
                host - (rect.top() as f32 + el.client_top() as f32) + el.scroll_top() as f32
            }
            None => host + self.win.scroll_y().unwrap_or(0.0) as f32,
        }
    }

    fn scroll_insets(&self, view_height: f32) -> (f32, f32) {
        let Some(el) = &self.scroller else { return (0.0, 0.0) };
        let read = |name: &str| {
            let value = dom::computed_value(el, name);
            if let Some(percent) = value.strip_suffix('%') {
                percent.parse::<f32>().map(|p| p / 100.0 * view_height).unwrap_or(0.0)
            } else {
                dom::px(&value)
            }
        };
        let (top, bottom) = (read("scroll-padding-top"), read("scroll-padding-bottom"));
        if top + bottom >= view_height {
            (0.0, 0.0)
        } else {
            (top, bottom)
        }
    }

    // -- A frame --------------------------------------------

    /// Draws the frame at `now_ms`. Returns whether another frame is wanted.
    pub fn frame(&mut self, now_ms: f64) -> bool {
        // The scroll events this frame's rendering brought have been dispatched by now.
        self.settling_frames = self.settling_frames.saturating_sub(1);
        // Off the screen nothing is drawn or measured, and above all the scroll element is not
        // written: the page may be showing something else in it.
        if self.hidden || !self.on_page {
            return false;
        }
        if self.needs_build {
            // The same lyrics again (a theme, a decoration setting): what the host put in the
            // container stays, as it does in the DOM renderer, which rebuilds nothing for a theme.
            self.build(true);
        }
        if let Some(settle) = self.pending_refresh.take() {
            self.refresh(settle);
        }
        if self.needs_layout {
            self.layout();
        }
        // Zoom and moving to another screen change the device pixel ratio. A media query reports
        // it; a few times a second it is read anyway, as not every change sends the event.
        let recheck = now_ms - self.pixel_ratio_checked_ms >= HOST_RECHECK_MS;
        if std::mem::take(&mut self.pixel_ratio_changed) || recheck {
            self.pixel_ratio_checked_ms = now_ms;
            if (self.win.device_pixel_ratio() as f32 - self.dpr).abs() > 1e-3 {
                self.measure_viewport();
                self.release_textures();
            }
        }
        // A line came out larger than the line pages hold: every line is drawn again into larger ones.
        if self.gpu.needs_page_reset() {
            self.release_textures();
            self.gpu.reset_pages();
        }
        self.profile.lap(profile::Phase::Prepare);
        let Some(song) = self.song.take() else { return false };
        let keep_going = self.frame_with(&song, now_ms);
        self.song = Some(song);
        // Settling is counted in frames, so it needs them: paused, nothing else asks for one.
        keep_going || self.settling_frames > 0
    }

    fn frame_with(&mut self, song: &Song, now_ms: f64) -> bool {
        // The clock.
        let (reported, playing, rate) = match &self.media {
            Some(media) => (media.current_time(), !media.paused() && !media.ended(), media.playback_rate()),
            None => {
                let rate = self.tick_options.rate;
                let carried = if self.manual_playing && self.manual_event_ms >= 0.0 {
                    ((js_sys::Date::now() - self.manual_event_ms) / 1000.0).max(0.0) * rate.max(0.0)
                } else {
                    0.0
                };
                (self.manual_time + carried, self.manual_playing, rate)
            }
        };
        let reading = self.clock.sample(reported, playing, rate, now_ms);
        if playing || reported != 0.0 {
            self.started = true;
        }
        let lyric = (reading.time_s + self.lyric_shift(song.sync)) as f32;
        let scroll_time = lyric + self.theme.scroll_offset_s;
        let jumped = reading.jumped || (lyric - self.last_lyric).abs() > 0.5 && !playing;
        self.last_lyric = lyric;
        let moment = Moment { lyric, now_ms, sync: song.sync };
        let animating = self.started && !song.no_lyrics && song.sync != SyncType::None;

        // Phases.
        let prepare = if playing { PREPARE_S } else { 0.0 };
        let exit_ms = paint::exit_ms(&self.theme);
        let mut moving = false;
        for (index, line) in song.lines.iter().enumerate() {
            let next_start = song.lines.get(index + 1).map(|n| n.start_s).unwrap_or(f32::INFINITY);
            let end = next_start.max(line.end_s() + 0.05);
            let in_window = animating && lyric + prepare >= line.start_s && lyric < end;
            let stale = lyric > end + self.theme.fade_out_s + 0.05 && lyric >= line.start_s;
            let state = &mut self.lines[index];
            state.phase = match state.phase {
                _ if in_window => Phase::Live,
                Phase::Live if stale && jumped => Phase::Idle,
                Phase::Live => Phase::Exiting { since_ms: now_ms, lyric_s: lyric },
                Phase::Exiting { since_ms, .. } if now_ms - since_ms >= exit_ms => Phase::Idle,
                other => other,
            };
            if matches!(state.phase, Phase::Exiting { .. }) {
                moving = true;
            }
        }

        // Credits take the focus once the last line is over.
        let last_end = song.lines.iter().rev().find(|l| !l.instrumental).map(|l| l.end_s()).unwrap_or(f32::INFINITY);
        let focused = song.sync == SyncType::None || (self.started && scroll_time >= last_end);
        if focused != self.credits_focus.0 {
            self.credits_focus = (focused, now_ms);
            if focused {
                let _ = self.container.set_attribute("data-credits-focused", "true");
            } else {
                let _ = self.container.remove_attribute("data-credits-focused");
            }
        }

        // Something above the element in the scroller can appear or go (a loader, the page's own
        // panel content) and move it without resizing it, which no observer reports, so where it
        // sits is read again a few times a second.
        if !self.stage && now_ms - self.host_checked_ms >= HOST_RECHECK_MS {
            self.host_checked_ms = now_ms;
            let top = self.host_top_now();
            if (top - self.host_top_in_scroll).abs() >= 0.5 {
                self.host_top_in_scroll = top;
                self.autoscroll.force = true;
            }
        }

        // Autoscroll.
        let scroll_top = self.scroll_top();
        if self.user_paused_until > 0.0 && now_ms >= self.user_paused_until {
            self.resume_autoscroll();
        }
        let following = self.user_paused_until <= now_ms;
        // Another song starts where its first scroll would put it, before it plays: left where the old
        // song was, it would glide there from the old song's place once it did.
        let fresh = self.fresh_song && self.measured.is_some() && !self.stage;
        if fresh {
            self.fresh_song = false;
            if song.no_lyrics || song.sync == SyncType::None {
                // Unsynced lyrics drift from the top, and a message stands at it.
                let start = self.host_top_in_scroll.max(0.0);
                if scroll_top > start + 0.5 {
                    self.write_scroll_top(start);
                }
            }
        }
        let synced = !song.no_lyrics && song.sync != SyncType::None;
        let first = fresh && synced;
        // Whether autoscroll moved this frame, which has the glide's start to draw.
        let mut committed = false;
        if (animating || first) && following && !self.stage && (self.started || self.autoscroll.force || first) {
            if let Some(measured) = &self.measured {
                let offset = self.host_top_in_scroll;
                let lines: Vec<ScrollLine> = song
                    .lines
                    .iter()
                    .zip(&measured.lines)
                    .map(|(line, layout)| ScrollLine {
                        start_s: line.start_s,
                        duration_s: line.duration_s,
                        top: layout.top + offset,
                        height: layout.scroll_height,
                        instrumental: line.instrumental,
                    })
                    .collect();
                let credits = measured.credits.as_ref().map(|c| ScrollLine {
                    start_s: f32::INFINITY,
                    duration_s: 0.0,
                    top: c.top + offset,
                    height: c.height,
                    instrumental: false,
                });
                let params = ScrollParams {
                    ratio: self.theme.target_scroll_ratio,
                    early_consider_s: self.settings.early_scroll_consider_s,
                    ending_threshold_s: self.settings.lyric_ending_threshold_s,
                };
                if let Some(plan) = self.autoscroll.tick(
                    &lines,
                    credits,
                    scroll_time,
                    &params,
                    self.viewport,
                    scroll_top,
                    jumped || first,
                ) {
                    // Written first, so the glide starts from where the scroll landed: the browser
                    // rounds it, and may clamp it.
                    self.write_scroll_top(plan.to);
                    let landed = self.scroll_top();
                    let plan = scroll::Plan { to: landed, ..plan };
                    committed = true;
                    if !first && self.tick_options.smooth_scroll && self.theme.animate_scroll {
                        let (before, after) = (self.canvas_top_at(scroll_top), self.canvas_top_at(landed));
                        let dpr = self.dpr;
                        let shifts: Vec<f32> = lines
                            .iter()
                            .map(|l| l.top - offset)
                            .map(|top| scroll::pixel_shift(top - before, dpr) - scroll::pixel_shift(top - after, dpr))
                            .collect();
                        let tops: Vec<(f32, f32)> = lines
                            .iter()
                            .map(|l| (l.top, l.height))
                            .chain(credits.iter().map(|c| (c.top, c.height)))
                            .collect();
                        let mut curves: Vec<Vec<Curve>> =
                            self.lines.iter_mut().map(|s| std::mem::take(&mut s.curves)).collect();
                        curves.push(std::mem::take(&mut self.credits_curves));
                        scroll::start_glides(
                            &mut curves,
                            &tops,
                            &shifts,
                            &plan,
                            scroll_top,
                            self.viewport.height,
                            now_ms,
                            self.theme.scroll_easing,
                            !self.theme.reduced_motion,
                        );
                        self.credits_curves = curves.pop().unwrap_or_default();
                        for (state, line_curves) in self.lines.iter_mut().zip(curves) {
                            state.curves = line_curves;
                        }
                    }
                }
            }
        }

        // The distance effects follow the lines being sung, and give way while a reader scrolls.
        if let Some((first, last)) = self.autoscroll.followed_range() {
            let to = (first as f32, last as f32);
            if to != self.focus.to {
                let from =
                    if self.focus.duration_ms > 0.0 { self.focus.at(now_ms, self.theme.scroll_easing) } else { to };
                self.focus = Focus { from, to, start_ms: now_ms, duration_ms: FOCUS_MS };
            }
        }
        let wanted = if following { 1.0 } else { 0.0 };
        if wanted != self.effects.1 {
            let now = self.effect_strength(now_ms);
            self.effects = (now, wanted, now_ms);
        }
        let effects_on = !self.stage && animating && !self.theme.line_effects.is_empty();
        if effects_on && (self.focus.moving(now_ms) || now_ms < self.effects.2 + EFFECTS_FADE_MS) {
            moving = true;
        }
        // Lines other than the sung and hovered ones ease to the browsing opacity while the pointer
        // is over the lyrics or a reader scrolls.
        let hover_timing = (self.theme.line_hover.duration_s, self.theme.line_hover.easing);
        let browsing_opacity = self.theme.line_opacity_browsing.filter(|_| !self.stage && !song.no_lyrics);
        let browsing = browsing_opacity.is_some() && (self.pointer.is_some() || !following);
        // Unsynced lyrics have nothing to follow, so they drift instead.
        if song.sync == SyncType::None
            && !song.no_lyrics
            && !self.stage
            && self.tick_options.passive_scroll
            && self.settings.passive_scroll_enabled
        {
            moving |= self.passive_scroll(song, playing, now_ms);
        }

        // The stage.
        if self.stage {
            moving |= self.place_stage(song, lyric, now_ms, jumped, animating);
        }

        // Draw.
        let canvas_top = if self.stage { 0.0 } else { self.canvas_top_at(self.scroll_top()) };
        self.profile.lap(profile::Phase::Update);
        self.quads.clear();
        self.blur_jobs.clear();
        let view_h = self.canvas_size.1;
        let mut prefetched = 0;
        let mut last_line_offset = 0.0;
        let pointed = self.pointed_line(song, now_ms);
        let tracks_hover = self.tracks_hover();
        let Some(measured) = self.measured.as_mut() else { return false };
        for (index, line) in song.lines.iter().enumerate() {
            let layout = &mut measured.lines[index];
            let state = &mut self.lines[index];
            let offset = scroll::offset(&mut state.curves, now_ms);
            if index + 1 == song.lines.len() {
                last_line_offset = offset;
            }
            if !state.curves.is_empty() {
                moving = true;
            }
            let (y, mut opacity) = match self.stage_motion.get(index) {
                Some(motion) if self.stage => (motion.y(now_ms), motion.opacity(now_ms)),
                _ if self.stage => (0.0, 0.0),
                _ => {
                    // Its place at rest is on whole device pixels, and its glides start and end on
                    // such places, so the line is never pulled to the grid while it moves.
                    let rest = layout.top - canvas_top;
                    (rest + scroll::pixel_shift(rest, self.dpr) + offset, 1.0)
                }
            };
            let mut look = LineLook::PLAIN;
            if effects_on {
                let (first, last) = self.focus.at(now_ms, self.theme.scroll_easing);
                let at = index as f32;
                let distance = if at < first {
                    at - first
                } else if at > last {
                    at - last
                } else {
                    0.0
                };
                look = self.theme.line_effects.at(distance).scaled(effect_strength(self.effects, now_ms));
                opacity *= look.opacity;
            }
            let mut line_blur = look.blur;
            // The line under the pointer eases to the theme's hover look.
            let hover = self.theme.line_hover;
            let target = if pointed == Some(index) { 1.0 } else { 0.0 };
            state.hover.aim(target, now_ms, hover.duration_s, hover.easing);
            let hovered = if self.stage || song.no_lyrics || !tracks_hover {
                0.0
            } else {
                if state.hover.moving(now_ms, hover.duration_s) {
                    moving = true;
                }
                state.hover.at(now_ms, hover.duration_s, hover.easing)
            };
            if let Some(to) = browsing_opacity {
                // The lines being sung now, not the ones autoscroll last followed, which stand
                // still while a reader has paused it. A line is live a little before it starts,
                // to prepare its animation; it is sung from its start.
                let is_sung = state.phase == Phase::Live && lyric >= line.start_s;
                let target = if browsing && !is_sung { 1.0 } else { 0.0 };
                state.browse.aim(target, now_ms, hover_timing.0, hover_timing.1);
                if state.browse.moving(now_ms, hover_timing.0) {
                    moving = true;
                }
                let share = state.browse.at(now_ms, hover_timing.0, hover_timing.1) * (1.0 - hovered);
                if share > 0.0 {
                    opacity += (to - opacity) * share;
                }
            }
            if hovered > 0.0 {
                if let Some(to) = hover.opacity {
                    opacity += (to - opacity) * hovered;
                }
                if let Some(to) = hover.blur_px {
                    line_blur += (to - line_blur) * hovered;
                }
            }
            let hover_scale = hover.scale.map(|to| (to, hovered)).unwrap_or((1.0, 0.0));
            let margin = layout.font_px;
            let visible = opacity > 0.001 && y + layout.height + margin > 0.0 && y - margin < view_h;
            let near = y + layout.height > -view_h * PREFETCH_VIEWPORTS && y < view_h * (1.0 + PREFETCH_VIEWPORTS);
            let far = y + layout.height < -view_h * EVICT_VIEWPORTS || y > view_h * (1.0 + EVICT_VIEWPORTS);
            if far {
                if let Some(texture) = state.texture.take() {
                    self.gpu.release(texture);
                }
                continue;
            }
            // Not on the frame a scroll starts, which already has a glide to start smoothly.
            let prefetch = near && !committed && prefetched < PREFETCH_PER_FRAME;
            if state.texture.is_none() && (visible || prefetch) {
                if !visible {
                    prefetched += 1;
                }
                self.profile.lap(profile::Phase::Paint);
                if let Some(canvas) = self.raster.draw_line(layout, self.dpr) {
                    state.texture = self.gpu.upload_line(canvas);
                }
                self.profile.lap(profile::Phase::Raster);
            }
            if !visible || state.texture.is_none() {
                continue;
            }
            let entry = decoration_entry(state.decorated_ms, now_ms, &self.theme);
            if entry < 1.0 && (line.translation.is_some() || line.romanization.is_some() || line.rows.len() > 1) {
                moving = true;
            }
            let x = self.bleed_left + layout.left;
            let placement = Placement {
                x: if self.stage { x } else { x + scroll::pixel_shift(x, self.dpr) },
                y,
                dpr: self.dpr,
                opacity,
                entry,
                hover_scale,
                hover_color: hover.color.map(|color| (color, hovered)),
                // An easing that overshoots moves the line, but no colour or shadow past its own.
                hovered: hovered.clamp(0.0, 1.0),
                saturate: look.saturate,
                brightness: look.brightness,
                snap: self.stage,
            };
            self.line_quads.clear();
            self.line_under.clear();
            self.line_blurs.clear();
            paint::paint_line(
                &mut self.line_quads,
                &mut self.line_under,
                &mut self.line_blurs,
                line,
                layout,
                state.phase,
                moment,
                placement,
                &self.theme,
            );
            let texture = state.texture.as_ref().unwrap();
            texture.place(&mut self.line_quads);
            texture.place(&mut self.line_under);
            for blur in &mut self.line_blurs {
                texture.place(&mut blur.quads);
            }
            // A line the theme blurs for its distance is drawn whole into the atlas, glows and all.
            if line_blur * self.dpr >= MIN_BLUR_PX {
                let mut quads: Vec<Quad> = self.line_under.clone();
                quads.extend(self.line_blurs.drain(..).flat_map(|b| b.quads));
                quads.extend_from_slice(&self.line_quads);
                self.blur_jobs.push(BlurJob { quads, sigma: line_blur, composite: self.quads.len() });
                self.quads.push(Quad::default());
                continue;
            }
            // Shadows go under everything of the line, and glows under its text: blurred, or as they
            // are once too small to blur.
            self.quads.extend_from_slice(&self.line_under);
            for blur in self.line_blurs.drain(..) {
                if blur.sigma * self.dpr >= MIN_BLUR_PX {
                    self.blur_jobs.push(BlurJob { quads: blur.quads, sigma: blur.sigma, composite: self.quads.len() });
                    self.quads.push(Quad::default());
                } else {
                    self.quads.extend_from_slice(&blur.quads);
                }
            }
            self.quads.extend_from_slice(&self.line_quads);
        }

        // Credits.
        let mut rider_motion = None;
        let mut tail_dy = last_line_offset;
        if let Some(credits) = measured.credits.as_mut() {
            let credits_index = song.lines.len();
            let (y, stage_opacity) = match self.stage_motion.get(credits_index) {
                Some(motion) if self.stage => (motion.y(now_ms), motion.opacity(now_ms)),
                _ if self.stage => (0.0, 0.0),
                _ => {
                    tail_dy = scroll::offset(&mut self.credits_curves, now_ms);
                    (credits.top + tail_dy - canvas_top, 1.0)
                }
            };
            if !self.credits_curves.is_empty() {
                moving = true;
            }
            rider_motion = Some((y + canvas_top - credits.top, if self.stage { stage_opacity } else { 1.0 }));
            if stage_opacity > 0.001 && y + credits.height > 0.0 && y < view_h {
                if self.credits_texture.is_none() {
                    self.profile.lap(profile::Phase::Paint);
                    if let Some(canvas) = self.raster.draw_line(credits, self.dpr) {
                        self.credits_texture = self.gpu.upload_line(canvas);
                    }
                    self.profile.lap(profile::Phase::Raster);
                }
                let (from, to) = if self.credits_focus.0 {
                    (self.theme.credits_opacity, self.theme.credits_focused_opacity)
                } else {
                    (self.theme.credits_focused_opacity, self.theme.credits_opacity)
                };
                let t = ((now_ms - self.credits_focus.1) / 350.0) as f32;
                let opacity = if self.credits_focus.1 == 0.0 { to } else { from + (to - from) * DECORATION_EASE.at(t) };
                if t < 1.0 && self.credits_focus.1 != 0.0 {
                    moving = true;
                }
                if let Some(texture) = &self.credits_texture {
                    let first = self.quads.len();
                    let opacity = if self.stage { stage_opacity * self.theme.credits_focused_opacity } else { opacity };
                    let placement = Placement {
                        x: self.bleed_left + credits.left,
                        y,
                        dpr: self.dpr,
                        opacity,
                        entry: 1.0,
                        hover_scale: (1.0, 0.0),
                        hover_color: None,
                        hovered: 0.0,
                        saturate: 1.0,
                        brightness: 1.0,
                        snap: false,
                    };
                    paint_static(&mut self.quads, credits, placement, self.theme.rest_scale);
                    texture.place(&mut self.quads[first..]);
                }
            }
        }

        self.profile.lap(profile::Phase::Paint);
        if !self.riders.is_empty() {
            let (credits_dy, opacity) = rider_motion.unwrap_or((0.0, 1.0));
            self.place_riders(credits_dy, opacity, tail_dy);
        }
        self.profile.lap(profile::Phase::Riders);

        self.submit();
        self.drawn_ms = now_ms;
        self.profile.lap(profile::Phase::Submit);
        self.stats.quads = self.quads.len();
        self.stats.resident = self.lines.iter().filter(|l| l.texture.is_some()).count();
        self.stats.texture_bytes = self.gpu.page_bytes();

        (playing && animating) || moving || self.gpu.needs_page_reset()
    }
}

/// How strongly the distance effects apply at `now_ms`: easing between `effects.0` and `effects.1`
/// since `effects.2`.
fn effect_strength(effects: (f32, f32, f64), now_ms: f64) -> f32 {
    let t = (((now_ms - effects.2) / EFFECTS_FADE_MS) as f32).clamp(0.0, 1.0);
    effects.0 + (effects.1 - effects.0) * crate::easing::Easing::EASE.at(t)
}

impl View {
    fn effect_strength(&self, now_ms: f64) -> f32 {
        effect_strength(self.effects, now_ms)
    }

    /// Draws the frame: the blur jobs into the atlas and blurred there, then the canvas, where each
    /// job is one quad of the atlas in the place its quads would have been.
    fn submit(&mut self) {
        let dpr = self.dpr;
        // Pack the jobs into rows of the atlas, each scaled down so its sigma spans 1.5 to 3 texels.
        const ROW_WIDTH: f32 = 1024.0;
        let (mut x, mut y, mut row_h) = (0.0f32, 0.0f32, 0.0f32);
        let mut job_quads: Vec<Quad> = Vec::new();
        let mut regions: Vec<BlurRegion> = Vec::new();
        let mut placed: Vec<(usize, [f32; 4], f32, Rect)> = Vec::new(); // job, atlas rect, scale, region
        let mut unplaced: Vec<usize> = Vec::new();
        for (job_index, job) in self.blur_jobs.iter().enumerate() {
            let sigma_px = job.sigma * dpr;
            // What the job covers, and three sigma around it where the blur still shows.
            let mut region = job
                .quads
                .iter()
                .map(|q| Rect { x: q.rect[0], y: q.rect[1], w: q.rect[2], h: q.rect[3] })
                .reduce(|a, b| a.union(&b))
                .unwrap_or_default();
            region = region.expand(3.0 * job.sigma, 3.0 * job.sigma);
            // A job wider than a row (a long line blurred at a high pixel ratio) is drawn coarser
            // until it fits; its blur hides the difference.
            let mut ds = coarseness(sigma_px);
            let size = |ds: f32| ((region.w * dpr / ds).ceil() + 2.0, (region.h * dpr / ds).ceil() + 2.0);
            while (size(ds).0 > ROW_WIDTH || size(ds).1 > crate::gpu::MAX_ATLAS as f32) && ds < 256.0 {
                ds *= 2.0;
            }
            let scale = dpr / ds;
            let (w, h) = size(ds);
            if x + w > ROW_WIDTH {
                (x, y, row_h) = (0.0, y + row_h, 0.0);
            }
            if w > ROW_WIDTH || y + h > crate::gpu::MAX_ATLAS as f32 {
                unplaced.push(job_index);
                continue;
            }
            for quad in &job.quads {
                let mut q = *quad;
                q.rect = [
                    (q.rect[0] - region.x) * scale + x + 1.0,
                    (q.rect[1] - region.y) * scale + y + 1.0,
                    q.rect[2] * scale,
                    q.rect[3] * scale,
                ];
                q.wave[3] = ds.log2();
                job_quads.push(q);
            }
            regions.push(BlurRegion { rect: [x, y, w, h], params: [blur_sigma(sigma_px, ds) / ds, 0.0, 0.0, 0.0] });
            placed.push((job_index, [x, y, w, h], scale, region));
            x += w;
            row_h = row_h.max(h);
        }
        let used = (ROW_WIDTH as u32, (y + row_h).ceil() as u32);
        let (_, atlas_h) = self.gpu.atlas_size_for(used.0, used.1);
        let atlas_h = atlas_h as f32;

        // The composites: each job's place on the canvas, reading its region of the atlas, whose
        // rows the framebuffer counts from the bottom. A job that did not fit keeps an empty quad.
        for (index, [x, y, _, _], scale, region) in &placed {
            let job = &self.blur_jobs[*index];
            self.quads[job.composite] = Quad {
                rect: [region.x, region.y, region.w, region.h],
                uv: [x + 1.0, atlas_h - (y + 1.0), x + 1.0 + region.w * scale, atlas_h - (y + 1.0 + region.h * scale)],
                unlit: [1.0; 4],
                lit: [1.0; 4],
                ramp: [0.0, 0.0, 1.0, 0.0],
                wave: [0.0, 0.0, Quad::BLURRED, 0.0],
            };
        }
        for region in &mut regions {
            region.rect[1] = atlas_h - (region.rect[1] + region.rect[3]);
        }
        // With the atlas full, what is left is drawn sharp, in place of its composite, rather than
        // not at all.
        if !unplaced.is_empty() {
            let mut quads = Vec::with_capacity(self.quads.len());
            let mut next = unplaced.iter().map(|&i| &self.blur_jobs[i]).peekable();
            for (index, quad) in self.quads.iter().enumerate() {
                match next.peek() {
                    Some(job) if job.composite == index => {
                        quads.extend_from_slice(&job.quads);
                        next.next();
                    }
                    _ => quads.push(*quad),
                }
            }
            self.quads = quads;
        }

        self.gpu.begin();
        self.gpu.draw_jobs(&job_quads, &mut regions, used);
        self.gpu.draw_canvas(&self.quads);
        self.gpu.end();
    }

    /// Down the lyrics at a fixed pace per line, a pause at the bottom, a quick return to the top, a
    /// pause there, and again. Only playback time counts, and a reader's scroll is picked up from.
    fn passive_scroll(&mut self, song: &Song, playing: bool, now_ms: f64) -> bool {
        let settings = &self.settings;
        let max = self.viewport.max_scroll as f64;
        let down = song.lines.len() as f64 * settings.passive_seconds_per_line as f64;
        let (bottom, reset, top) = (
            settings.passive_bottom_pause_s as f64,
            settings.passive_reset_s as f64,
            settings.passive_top_pause_s as f64,
        );
        let last = self.passive.1.replace(now_ms);
        if !playing || max <= 0.0 || down <= 0.0 {
            self.passive.1 = None;
            return false;
        }
        if self.user_paused_until > now_ms {
            // Carry on from wherever the reader leaves it.
            self.passive.0 = (self.scroll_top() as f64 / max) * down;
            return true;
        }
        self.passive.0 += last.map(|l| ((now_ms - l) / 1000.0).min(0.5)).unwrap_or(0.0);
        let cycle = self.passive.0.rem_euclid(down + bottom + reset + top);
        let target = if cycle < down {
            cycle / down * max
        } else if cycle < down + bottom {
            max
        } else if cycle < down + bottom + reset {
            let u = (cycle - down - bottom) / reset;
            max * (1.0 - u).powi(2)
        } else {
            0.0
        };
        if (target as f32 - self.scroll_top()).abs() >= 0.5 {
            self.write_scroll_top(target as f32);
        }
        true
    }

    /// Moves each line toward where its role puts it, and reports the box around what is sung.
    /// Returns whether anything is still moving.
    fn place_stage(&mut self, song: &Song, lyric: f32, now_ms: f64, jumped: bool, animating: bool) -> bool {
        let Some(measured) = &self.measured else { return false };
        let mut items: Vec<stage::Item> = song
            .lines
            .iter()
            .map(|line| stage::Item {
                kind: if line.instrumental {
                    stage::Kind::Instrumental
                } else if line.blank {
                    stage::Kind::Blank
                } else {
                    stage::Kind::Line
                },
                start: line.start_s,
                end: line.end_s(),
            })
            .collect();
        let mut heights: Vec<f32> = measured.lines.iter().map(|l| l.height).collect();
        if let Some(credits) = &measured.credits {
            let last_end = song.lines.iter().map(|l| l.end_s()).fold(0.0, f32::max);
            items.push(stage::Item { kind: stage::Kind::Credits, start: last_end, end: f32::INFINITY });
            heights.push(credits.height);
        }
        // Unsynced lyrics have nothing to follow, so the stage stays empty.
        let roles = if animating { stage::roles(&items, lyric) } else { vec![Role::Queued; items.len()] };
        if roles != self.stage_roles {
            // As the DOM renderer marked them, for a host that styles or sizes around the sung line.
            if let Some(dom_) = &self.dom {
                let elements = dom_.lines.iter().map(|l| &l.element).chain(dom_.credits.iter());
                for (i, element) in elements.enumerate() {
                    if self.stage_roles.get(i) != roles.get(i) {
                        let name = match roles.get(i) {
                            Some(Role::Current) => "current",
                            Some(Role::Previous) => "previous",
                            Some(Role::Gone) => "gone",
                            _ => "queued",
                        };
                        dom::set_attr(element, "data-stage-role", name);
                    }
                }
            }
            self.stage_roles = roles.clone();
        }
        let gap = stage::GAP_EM * measured.lines.first().map(|l| l.font_px).unwrap_or(16.0);
        let last_y: Vec<f32> = self.stage_motion.iter().map(|m| m.to_y).collect();
        let rests = stage::targets(&roles, &heights, self.canvas_size.1, gap, &last_y);
        let instant = jumped || self.theme.reduced_motion || self.stage_motion.len() != items.len();
        if self.stage_motion.len() != items.len() {
            self.stage_motion = rests.iter().map(|&(y, _)| stage::Motion::at_rest(y, false)).collect();
        }
        let mut moving = false;
        for (motion, &(y, visible)) in self.stage_motion.iter_mut().zip(&rests) {
            // A line coming into view rises from just below the floor.
            if visible && !motion.visible && !instant {
                motion.from_y = y + gap;
                motion.to_y = y + gap;
            }
            motion.retarget(y, visible, now_ms, instant);
            moving |= motion.moving(now_ms);
        }

        // The box around the sung lines, as the host draws a plate behind them.
        let scale = self.theme.active_scale;
        let area = roles
            .iter()
            .enumerate()
            .filter(|(i, role)| {
                matches!(role, Role::Current | Role::Previous)
                    && matches!(items[*i].kind, stage::Kind::Line | stage::Kind::Credits)
            })
            .filter_map(|(i, _)| {
                let layout = measured.lines.get(i).or(measured.credits.as_ref())?;
                let y = rests[i].0;
                let (w, h) = (layout.width * scale, layout.height * scale);
                Some([layout.left + layout.origin_x * (1.0 - scale), y + layout.height * (1.0 - scale) / 2.0, w, h])
            })
            .reduce(|a, b| {
                let (x, y) = (a[0].min(b[0]), a[1].min(b[1]));
                [x, y, (a[0] + a[2]).max(b[0] + b[2]) - x, (a[1] + a[3]).max(b[1] + b[3]) - y]
            });
        if area != self.stage_area {
            self.stage_area = area;
            self.events.push(Event::StageLayout { area });
        }
        moving
    }
}

const DECORATION_EASE: crate::easing::Easing = crate::easing::Easing::Bezier(0.25, 1.0, 0.5, 1.0);

fn decoration_entry(decorated_ms: f64, now_ms: f64, theme: &Theme) -> f32 {
    if !theme.animate_decoration_entry {
        return 1.0;
    }
    (((now_ms - decorated_ms) / DECORATION_ENTRY_MS) as f32).clamp(0.0, 1.0)
}

/// Credits: static text at the resting line scale.
fn paint_static(out: &mut Vec<Quad>, layout: &LineLayout, placement: Placement, scale: f32) {
    let color = layout.static_color;
    let alpha = color[3] * placement.opacity;
    let flat = [color[0] * alpha, color[1] * alpha, color[2] * alpha, alpha];
    let cy = layout.height / 2.0;
    for slot in &layout.slots {
        for glyph in &slot.glyphs {
            let r = glyph.rect;
            let x = r.x * scale;
            let y = cy + (r.y - cy) * scale;
            let p = slot.placement;
            out.push(Quad {
                rect: [x + placement.x, y + placement.y, r.w * scale, r.h * scale],
                uv: [
                    r.x * placement.dpr - p.origin.0 + p.tex.0,
                    r.y * placement.dpr - p.origin.1 + p.tex.1,
                    r.right() * placement.dpr - p.origin.0 + p.tex.0,
                    r.bottom() * placement.dpr - p.origin.1 + p.tex.1,
                ],
                unlit: flat,
                lit: flat,
                ramp: [0.0, 0.0, 1.0, 0.0],
                wave: [0.0, 0.0, Quad::TEXT, 0.0],
            });
        }
    }
}

fn distance(rect: layout::Rect, x: f32, y: f32) -> f32 {
    let (cx, cy) = (rect.x + rect.w / 2.0, rect.y + rect.h / 2.0);
    ((cx - x).powi(2) + (cy - y).powi(2)).sqrt()
}

fn root_font_px(doc: &Document) -> f32 {
    doc.document_element()
        .map(|root| dom::px(&dom::computed_value(&root, "font-size")))
        .filter(|v| *v > 0.0)
        .unwrap_or(16.0)
}

fn install_stylesheet(doc: &web_sys::Document) {
    if doc.get_element_by_id(style::STYLE_ID).is_some() {
        return;
    }
    let el = element(doc, "style", "");
    el.set_id(style::STYLE_ID);
    el.set_text_content(Some(style::CSS));
    if let Some(head) = doc.head() {
        // First in the head, so every page stylesheet comes after it in the cascade.
        let _ = head.insert_before(&el, head.first_child().as_ref());
    }
}

impl Drop for View {
    fn drop(&mut self) {
        self.release_textures();
        self.canvas.remove();
        self.container.remove();
        self.host.class_list().remove_1("brs-host").ok();
    }
}

pub fn event_detail(event: &Event) -> (&'static str, JsValue) {
    let detail = js_sys::Object::new();
    let name = match event {
        Event::LyricsLoaded { line_count, sync } => {
            dom::set(&detail, "lineCount", &JsValue::from(*line_count as u32));
            dom::set(&detail, "syncType", &JsValue::from_str(sync.as_str()));
            "braccato:lyrics-loaded"
        }
        Event::LineClick { time_s } => {
            dom::set(&detail, "timeS", &JsValue::from(*time_s));
            "braccato:line-click"
        }
        Event::ScrollState { user_scrolling } => {
            dom::set(&detail, "userScrolling", &JsValue::from(*user_scrolling));
            "braccato:scroll-state"
        }
        Event::StageLayout { area } => {
            let value = match area {
                Some([x, y, width, height]) => {
                    let rect = js_sys::Object::new();
                    for (key, v) in [("x", x), ("y", y), ("width", width), ("height", height)] {
                        dom::set(&rect, key, &JsValue::from(*v));
                    }
                    rect.into()
                }
                None => JsValue::NULL,
            };
            dom::set(&detail, "box", &value);
            "braccato:stage-layout"
        }
    };
    (name, detail.into())
}

#[cfg(test)]
mod tests {
    use super::Tween;
    use crate::easing::Easing;

    #[test]
    fn a_hover_reversed_midway_eases_back_from_where_it_was() {
        let mut hover = Tween::default();
        hover.aim(1.0, 0.0, 0.2, Easing::Linear);
        assert!((hover.at(100.0, 0.2, Easing::Linear) - 0.5).abs() < 1e-6);
        assert!(hover.moving(100.0, 0.2));
        hover.aim(0.0, 100.0, 0.2, Easing::Linear);
        assert!((hover.at(100.0, 0.2, Easing::Linear) - 0.5).abs() < 1e-6);
        assert!((hover.at(200.0, 0.2, Easing::Linear) - 0.25).abs() < 1e-6);
        assert_eq!(hover.at(400.0, 0.2, Easing::Linear), 0.0);
        assert!(!hover.moving(400.0, 0.2));
    }
}
