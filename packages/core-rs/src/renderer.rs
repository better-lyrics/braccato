//! The view: owns the element's DOM, the canvas and every piece of state, and draws a frame.
//!
//! A frame reads the clock, moves each line through its phases, lets autoscroll decide whether to
//! scroll, rasterizes any line that has come into view, and draws. When nothing is playing or
//! moving, no frames are requested at all, so an idle view costs nothing.

use crate::clock::Clock;
use crate::dom::{self, element, set_style};
use crate::gpu::{Gpu, LineTexture, Quad};
use crate::layout::{self, LayoutDom, LineDom, LineLayout, Measured, Owner};
use crate::model::{Lyric, LyricPart, LyricsOptions, SyncType};
use crate::paint::{self, Moment, Phase, Placement};
use crate::raster::Rasterizer;
use crate::scroll::{self, AutoScroll, Curve, ScrollLine, ScrollParams, Viewport};
use crate::song::{self, Decorations, Hung, Song};
use crate::stage::{self, Role};
use crate::style;
use crate::theme::{CommentSettings, Theme};
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Document, Element, HtmlCanvasElement, HtmlElement, HtmlMediaElement, Window};

/// How often the element's place in the scroll element is read again (see `frame_with`).
const HOST_RECHECK_MS: f64 = 250.0;
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
    riders: Vec<(HtmlElement, (f32, f32))>,
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
    started: bool,
    last_lyric: f32,

    pub scroller: Option<Element>,
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
    needs_build: bool,
    needs_layout: bool,
    just_built: bool,
    quads: Vec<Quad>,
    draws: Vec<(usize, usize, usize)>,
    pub events: Vec<Event>,
    pub stats: Stats,

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
    /// Lines whose texture is on the GPU, and the bytes those textures take.
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
            started: false,
            last_lyric: 0.0,
            scroller: None,
            autoscroll: AutoScroll::default(),
            user_paused_until: 0.0,
            host_top_in_scroll: 0.0,
            host_checked_ms: 0.0,
            viewport: Viewport::default(),
            canvas_size: (0.0, 0.0),
            bleed_left: 0.0,
            passive: (0.0, None),
            dpr: 1.0,
            needs_build: false,
            needs_layout: false,
            just_built: false,
            quads: Vec::new(),
            draws: Vec::new(),
            events: Vec::new(),
            stats: Stats::default(),
            stage: false,
            stage_motion: Vec::new(),
            stage_area: None,
        })
    }

    // -- Inputs --------------------------------------------

    /// A new song, built at once so its elements exist when this returns. Lyrics given with the
    /// `song_key` of the song on screen are swapped into it instead (see `swap`).
    pub fn set_lyrics(&mut self, lyrics: Vec<Lyric>, options: LyricsOptions) {
        let same_song = options.song_key.is_some() && options.song_key == self.options.song_key;
        if same_song && self.song.is_some() && !options.no_lyrics && !self.options.no_lyrics {
            self.swap(lyrics, options);
            return;
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
        self.build();
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
        let song = song::build_song(&self.lyrics, &self.hung, &self.options, &self.settings, self.decorations);
        self.apply_song(song, &origins, true);
        self.layout();
    }

    /// Rebuilds the song on hand (after a host hung a decoration, changed the language or a line's
    /// time) and refills only the lines that came out different.
    fn refresh(&mut self, settle: bool) {
        if self.song.is_none() {
            return;
        }
        let mut song = song::build_song(&self.lyrics, &self.hung, &self.options, &self.settings, self.decorations);
        self.apply_time_overrides(&mut song);
        let origins: Vec<Option<usize>> = (0..song.lines.len()).map(Some).collect();
        self.apply_song(song, &origins, settle);
    }

    /// Puts `song` on screen in place of the one there, given where each new line came from.
    fn apply_song(&mut self, song: Song, origins: &[Option<usize>], settle: bool) {
        let now = dom::now_ms(&self.win);
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
        self.gpu.begin(&[]);
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
    /// `Date.now()`, so frames between snapshots carry it forward.
    pub fn set_snapshot(&mut self, seconds: f64, playing: bool, event_ms: f64) {
        self.manual_time = seconds;
        self.manual_playing = playing;
        self.manual_event_ms = event_ms;
    }

    pub fn reset_clock(&mut self) {
        self.clock.reset();
    }

    pub fn set_profiling(&mut self, on: bool) -> bool {
        self.gpu.set_profiling(on)
    }

    pub fn gpu_ms(&self) -> Option<f64> {
        self.gpu.gpu_ms()
    }

    pub fn invalidate_layout(&mut self) {
        self.needs_layout = true;
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
        match &self.scroller {
            Some(el) => el.scroll_top() as f32,
            None => self.win.scroll_y().unwrap_or(0.0) as f32,
        }
    }

    fn write_scroll_top(&mut self, value: f32) {
        match &self.scroller {
            Some(el) => el.set_scroll_top(value.round() as i32),
            None => self.win.scroll_to_with_x_and_y(self.win.scroll_x().unwrap_or(0.0), value.round() as f64),
        }
        self.autoscroll.last_written = Some(self.scroll_top());
    }

    /// A scroll event: if it is not the one autoscroll just caused, a reader is scrolling.
    pub fn on_scroll(&mut self, now_ms: f64) {
        let top = self.scroll_top();
        let ours = self.autoscroll.last_written.is_some_and(|w| (w - top).abs() <= 1.0);
        if ours || self.song.as_ref().is_none_or(|s| s.no_lyrics) {
            return;
        }
        let unsynced = self.song.as_ref().is_some_and(|s| s.sync == SyncType::None);
        let pause = if unsynced { USER_SCROLL_PAUSE_UNSYNCED_MS } else { USER_SCROLL_PAUSE_MS };
        let was_paused = self.user_paused_until > now_ms;
        self.user_paused_until = now_ms + pause;
        self.autoscroll.last_written = None;
        if !was_paused {
            self.container.class_list().add_1("blyrics-user-scrolling").ok();
            self.events.push(Event::ScrollState { user_scrolling: true });
        }
    }

    /// A click on a line: the player time it seeks to, if any.
    pub fn on_click(&mut self, target: &Element, alt: bool, client: (f32, f32)) -> Option<f64> {
        let song = self.song.as_ref()?;
        if song.sync == SyncType::None || song.no_lyrics {
            return None;
        }
        let line_el = target.closest(".blyrics--line").ok().flatten()?;
        let index: usize = line_el.get_attribute("data-line-number")?.parse().ok()?;
        let line = song.lines.get(index)?;
        let mut time = line.start_s as f64;
        if alt && song.sync == SyncType::Richsync {
            let layout = self.measured.as_ref()?.lines.get(index)?;
            let origin = self.container.get_bounding_client_rect();
            let (px, py) = (client.0 - origin.left() as f32 - layout.left, client.1 - origin.top() as f32 - layout.top);
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

    fn build(&mut self) {
        self.needs_build = false;
        self.pending_refresh = None;
        if !self.host.is_same_node(self.container.parent_node().as_ref()) {
            let _ = self.host.append_child(&self.container);
        }
        self.read_theme();
        self.hung.resize(self.lyrics.len(), Hung::default());
        let mut song = song::build_song(&self.lyrics, &self.hung, &self.options, &self.settings, self.decorations);
        self.apply_time_overrides(&mut song);
        self.release_textures();
        let dom_ = layout::build_dom(&self.doc, &self.container, &song, &self.theme);
        self.mark_stage(&song, &dom_);
        self.stage_motion.clear();
        self.stage_roles.clear();
        self.stage_area = None;
        let now = dom::now_ms(&self.win);
        self.lines = song.lines.iter().map(|_| LineState { decorated_ms: now, ..Default::default() }).collect();
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
        // over as the DOM renderer did: the top only as `--blyrics-padding-top` on the root, for the
        // page's CSS to use or not (core's stylesheet keeps a fixed 2rem, so the first lines start
        // above the target; Better Lyrics uses the variable in fullscreen), and the bottom as
        // `--blyrics-padding-bottom` and inline, where no theme can take it away.
        let padding = |name: &str| dom::px(&dom::computed_value(&self.container, name));
        let old_top = padding("padding-top");
        let _ = self.container.style().remove_property("padding-top");
        if !self.stage {
            let root = self.doc.document_element().map(|r| r.unchecked_into::<HtmlElement>());
            let publish = |name: &str, value: f32| {
                if let Some(root) = &root {
                    set_style(root, name, &format!("{value}px"));
                }
            };
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
        let now = dom::now_ms(&self.win);
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

    /// What the host put inside the credits (a source card): the renderer draws the credits
    /// itself, so it moves these with them.
    fn find_riders(&self) -> Vec<(HtmlElement, (f32, f32))> {
        let Some(credits) = self.dom.as_ref().and_then(|d| d.credits.as_ref()) else { return Vec::new() };
        let children = credits.children();
        (0..children.length())
            .filter_map(|i| children.item(i))
            .filter(|child| !child.class_list().contains("blyrics-credits__text"))
            .map(|child| (child.unchecked_into::<HtmlElement>(), (f32::NAN, f32::NAN)))
            .collect()
    }

    /// Moves the riders by `dy` from where the page laid them out, at `opacity`.
    fn place_riders(&mut self, dy: f32, opacity: f32) {
        let mut changed = false;
        for (rider, last) in &mut self.riders {
            if (last.0 - dy).abs() < 0.25 && (last.1 - opacity).abs() < 0.002 {
                continue;
            }
            *last = (dy, opacity);
            changed = true;
            set_style(rider, "translate", &format!("0 {dy:.2}px"));
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
        self.host_top_in_scroll = host_rect.top() as f32 - view_top + scroll_top;
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
            self.dpr = window.device_pixel_ratio() as f32;
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
        self.dpr = window.device_pixel_ratio() as f32;
        self.gpu.resize(&self.canvas, width, height, self.dpr);
    }

    /// Where the element's top is in the scroll element's content.
    fn host_top_now(&self) -> f32 {
        let host = self.host.get_bounding_client_rect().top() as f32;
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
        if self.hidden {
            return false;
        }
        if self.needs_build {
            self.build();
        }
        if let Some(settle) = self.pending_refresh.take() {
            self.refresh(settle);
        }
        if self.needs_layout {
            self.layout();
        }
        if (self.win.device_pixel_ratio() as f32 - self.dpr).abs() > 1e-3 {
            self.measure_viewport();
            self.release_textures();
        }
        let Some(song) = self.song.take() else { return false };
        let keep_going = self.frame_with(&song, now_ms);
        self.song = Some(song);
        keep_going
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
        if animating && following && !self.stage && (self.started || self.autoscroll.force) {
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
                if let Some(plan) =
                    self.autoscroll.tick(&lines, credits, scroll_time, &params, self.viewport, scroll_top, jumped)
                {
                    if self.tick_options.smooth_scroll && self.theme.animate_scroll {
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
                    self.write_scroll_top(plan.to);
                }
            }
        }

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
        let scroll_top = self.scroll_top();
        let canvas_top = if self.stage {
            0.0
        } else {
            (scroll_top - self.host_top_in_scroll).clamp(
                0.0,
                (self.measured.as_ref().map(|m| m.content_height).unwrap_or(0.0) - self.canvas_size.1).max(0.0),
            )
        };
        self.quads.clear();
        self.draws.clear();
        let view_h = self.canvas_size.1;
        let mut prefetched = 0;
        let Some(measured) = self.measured.as_mut() else { return false };
        for (index, line) in song.lines.iter().enumerate() {
            let layout = &mut measured.lines[index];
            let state = &mut self.lines[index];
            let offset = scroll::offset(&mut state.curves, now_ms);
            if !state.curves.is_empty() {
                moving = true;
            }
            let (y, opacity) = match self.stage_motion.get(index) {
                Some(motion) if self.stage => (motion.y(now_ms), motion.opacity(now_ms)),
                _ if self.stage => (0.0, 0.0),
                _ => (layout.top + offset - canvas_top, 1.0),
            };
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
            if state.texture.is_none() && (visible || (near && prefetched < PREFETCH_PER_FRAME)) {
                if !visible {
                    prefetched += 1;
                }
                if let Some(canvas) = self.raster.draw_line(layout, self.dpr, self.theme.glow_radius_px) {
                    state.texture = self.gpu.upload_line(canvas);
                }
            }
            if !visible || state.texture.is_none() {
                continue;
            }
            let entry = decoration_entry(state.decorated_ms, now_ms, &self.theme);
            if entry < 1.0 && (line.translation.is_some() || line.romanization.is_some() || line.rows.len() > 1) {
                moving = true;
            }
            let first = self.quads.len();
            let placement = Placement { x: self.bleed_left + layout.left, y, dpr: self.dpr, opacity, entry };
            paint::paint_line(&mut self.quads, line, layout, state.phase, moment, placement, &self.theme);
            self.draws.push((index, first, self.quads.len() - first));
        }

        // Credits.
        let mut rider_motion = None;
        if let Some(credits) = measured.credits.as_mut() {
            let credits_index = song.lines.len();
            let (y, stage_opacity) = match self.stage_motion.get(credits_index) {
                Some(motion) if self.stage => (motion.y(now_ms), motion.opacity(now_ms)),
                _ if self.stage => (0.0, 0.0),
                _ => (credits.top + scroll::offset(&mut self.credits_curves, now_ms) - canvas_top, 1.0),
            };
            if !self.credits_curves.is_empty() {
                moving = true;
            }
            rider_motion = Some((y + canvas_top - credits.top, if self.stage { stage_opacity } else { 1.0 }));
            if stage_opacity > 0.001 && y + credits.height > 0.0 && y < view_h {
                if self.credits_texture.is_none() {
                    if let Some(canvas) = self.raster.draw_line(credits, self.dpr, 0.0) {
                        self.credits_texture = self.gpu.upload_line(canvas);
                    }
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
                let first = self.quads.len();
                let opacity = if self.stage { stage_opacity * self.theme.credits_focused_opacity } else { opacity };
                let placement = Placement { x: self.bleed_left + credits.left, y, dpr: self.dpr, opacity, entry: 1.0 };
                paint_static(&mut self.quads, credits, placement, self.theme.rest_scale);
                self.draws.push((usize::MAX, first, self.quads.len() - first));
            }
        }

        if let Some((dy, opacity)) = rider_motion {
            self.place_riders(dy, opacity);
        }

        self.gpu.begin(&self.quads);
        for &(index, first, count) in &self.draws {
            let texture =
                if index == usize::MAX { self.credits_texture.as_ref() } else { self.lines[index].texture.as_ref() };
            if let Some(texture) = texture {
                self.gpu.draw(texture, first, count);
            }
        }
        self.gpu.end();
        self.stats.quads = self.quads.len();
        self.stats.resident = self.lines.iter().filter(|l| l.texture.is_some()).count();
        self.stats.texture_bytes =
            self.lines.iter().filter_map(|l| l.texture.as_ref()).map(|t| (t.width * t.height * 4) as usize).sum();

        (playing && animating) || moving
    }
}

impl View {
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
