//! The view: owns the element's DOM, the canvas and every piece of state, and draws a frame.
//!
//! A frame reads the clock, moves each line through its phases, lets autoscroll decide whether to
//! scroll, rasterizes any line that has come into view, and draws. When nothing is playing or
//! moving, no frames are requested at all, so an idle view costs nothing.

use crate::clock::Clock;
use crate::dom::{self, element, set_style};
use crate::gpu::{Gpu, LineTexture, Quad};
use crate::layout::{self, LayoutDom, LineLayout, Measured, Owner};
use crate::model::{Lyric, LyricsOptions, SyncType};
use crate::paint::{self, Moment, Phase, Placement};
use crate::raster::Rasterizer;
use crate::scroll::{self, AutoScroll, Curve, ScrollLine, ScrollParams, Viewport};
use crate::song::{self, Decorations, Song};
use crate::stage::{self, Role};
use crate::style;
use crate::theme::{CommentSettings, Theme};
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Element, HtmlCanvasElement, HtmlElement, HtmlMediaElement};

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

/// What a line carries from frame to frame.
#[derive(Default)]
struct LineState {
    phase: Phase,
    /// Scroll glides still running on the line, added together.
    curves: Vec<Curve>,
    texture: Option<LineTexture>,
}

/// Offsets and options a host passes with the clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct TickOptions {
    pub lyric_offset_s: f64,
    pub global_offset_s: f64,
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
    canvas: HtmlCanvasElement,
    pub container: HtmlElement,
    gpu: Gpu,
    raster: Rasterizer,

    lyrics: Vec<Lyric>,
    options: LyricsOptions,
    settings: CommentSettings,
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
    built_ms: f64,

    clock: Clock,
    pub media: Option<HtmlMediaElement>,
    manual_time: f64,
    manual_playing: bool,
    pub tick_options: TickOptions,
    started: bool,
    last_lyric: f32,

    pub scroller: Option<Element>,
    autoscroll: AutoScroll,
    user_paused_until: f64,
    host_top_in_scroll: f32,
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
        let doc = dom::document();
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
        let theme = Theme::read(&container, settings.clone(), root_font_px());
        Ok(View {
            host,
            canvas,
            container,
            gpu,
            raster: Rasterizer::new(),
            lyrics: Vec::new(),
            options: LyricsOptions::default(),
            settings,
            decorations: Decorations { translations: true, romanizations: true },
            theme,
            song: None,
            dom: None,
            measured: None,
            lines: Vec::new(),
            credits_texture: None,
            credits_focus: (false, 0.0),
            credits_curves: Vec::new(),
            built_ms: 0.0,
            clock: Clock::default(),
            media: None,
            manual_time: 0.0,
            manual_playing: false,
            tick_options: TickOptions { rate: 1.0, smooth_scroll: true, ..Default::default() },
            started: false,
            last_lyric: 0.0,
            scroller: None,
            autoscroll: AutoScroll::default(),
            user_paused_until: 0.0,
            host_top_in_scroll: 0.0,
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

    pub fn set_lyrics(&mut self, lyrics: Vec<Lyric>, options: LyricsOptions) {
        self.lyrics = lyrics;
        self.options = options;
        self.needs_build = true;
        self.autoscroll.reset();
        self.user_paused_until = 0.0;
        self.started = false;
    }

    pub fn set_theme(&mut self, css: &str) {
        let doc = dom::document();
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
            None => dom::window().scroll_y().unwrap_or(0.0) as f32,
        }
    }

    fn write_scroll_top(&mut self, value: f32) {
        match &self.scroller {
            Some(el) => el.set_scroll_top(value.round() as i32),
            None => dom::window().scroll_to_with_x_and_y(dom::window().scroll_x().unwrap_or(0.0), value.round() as f64),
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
        let base =
            if sync == SyncType::Richsync { self.theme.richsync_offset_s } else { self.theme.line_offset_s } as f64;
        base - self.tick_options.global_offset_s - self.tick_options.lyric_offset_s
    }

    // -- Building and layout --------------------------------------------

    fn build(&mut self) {
        self.needs_build = false;
        self.theme = Theme::read(&self.container, self.settings.clone(), root_font_px());
        let song = song::build_song(&self.lyrics, &self.options, &self.settings, self.decorations);
        self.release_textures();
        let dom_ = layout::build_dom(&dom::document(), &self.container, &song, &self.theme);
        self.mark_stage(&song, &dom_);
        self.stage_motion.clear();
        self.stage_area = None;
        self.lines = song.lines.iter().map(|_| LineState::default()).collect();
        self.events.push(Event::LyricsLoaded { line_count: song.lines.len(), sync: song.sync });
        self.song = Some(song);
        self.dom = Some(dom_);
        self.built_ms = dom::now_ms();
        self.credits_focus = (false, 0.0);
        self.needs_layout = true;
        self.just_built = true;
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
        self.theme = Theme::read(&self.container, self.settings.clone(), root_font_px());
        self.measure_viewport();
        let (Some(song), Some(dom_)) = (&self.song, &self.dom) else { return };
        let mut measured = layout::measure(dom_, song, &self.theme, root_font_px());

        // Room above the first line and below the last so both can reach the target position.
        let (top, bottom) = if self.stage || song.no_lyrics || measured.lines.is_empty() {
            (0.0, 0.0)
        } else {
            let vh = self.viewport.height;
            let ratio = self.theme.target_scroll_ratio;
            let first_h = measured.lines[0].height;
            let top = (vh * ratio - first_h / 2.0).max(0.0);
            let last = measured.credits.as_ref().filter(|c| c.height > 0.0).or(measured.lines.last()).unwrap();
            let old_top = dom::px(&dom::computed_value(&self.container, "padding-top"));
            let old_bottom = dom::px(&dom::computed_value(&self.container, "padding-bottom"));
            let content = measured.content_height - old_bottom - old_top + top;
            let last_centre = last.top - old_top + top + last.height / 2.0;
            let below = vh * (1.0 - ratio);
            let bottom =
                (last_centre + below - content).max(vh - content).max(below - last.height / 2.0).max(0.0).ceil();
            (top, bottom)
        };
        let old_top = dom::px(&dom::computed_value(&self.container, "padding-top"));
        set_style(&self.container, "padding-top", &format!("{top}px"));
        set_style(&self.container, "padding-bottom", &format!("{bottom}px"));
        let shift = top - old_top;
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
        self.measured = Some(measured);
        self.measure_viewport();
        self.release_textures();
        self.autoscroll.force = true;
    }

    /// Where the view is: the scroll element's size and the canvas that covers it.
    fn measure_viewport(&mut self) {
        let window = dom::window();
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
                None => dom::document()
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
        self.bleed_left = (host_rect.left() as f32 - view_left).max(0.0);
        let bleed_right = (view_right - host_rect.right() as f32).max(0.0);
        let width = host_rect.width() as f32 + self.bleed_left + bleed_right;
        let height = view_height.min(content.max(1.0));
        self.canvas_size = (width, height);
        set_style(&self.canvas, "width", &format!("{width}px"));
        set_style(&self.canvas, "height", &format!("{height}px"));
        set_style(&self.canvas, "margin-left", &format!("{}px", -self.bleed_left));
        set_style(&self.canvas, "margin-bottom", &format!("{}px", -height));
        self.dpr = window.device_pixel_ratio() as f32;
        self.gpu.resize(&self.canvas, width, height, self.dpr);
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
        if self.needs_build {
            self.build();
        }
        if self.needs_layout {
            self.layout();
        }
        if (dom::window().device_pixel_ratio() as f32 - self.dpr).abs() > 1e-3 {
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
            None => (self.manual_time, self.manual_playing, self.tick_options.rate),
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
            let entry = decoration_entry(self.built_ms, now_ms, &self.theme);
            if entry < 1.0 && (line.translation.is_some() || line.romanization.is_some() || line.rows.len() > 1) {
                moving = true;
            }
            let first = self.quads.len();
            let placement = Placement { x: self.bleed_left + layout.left, y, dpr: self.dpr, opacity, entry };
            paint::paint_line(&mut self.quads, line, layout, state.phase, moment, placement, &self.theme);
            self.draws.push((index, first, self.quads.len() - first));
        }

        // Credits.
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

fn decoration_entry(built_ms: f64, now_ms: f64, theme: &Theme) -> f32 {
    if !theme.animate_decoration_entry {
        return 1.0;
    }
    (((now_ms - built_ms) / DECORATION_ENTRY_MS) as f32).clamp(0.0, 1.0)
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

fn root_font_px() -> f32 {
    dom::document()
        .document_element()
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
