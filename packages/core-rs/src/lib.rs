//! braccato's lyrics renderer, drawn with WebGL2.
//!
//! `Renderer` is the whole public surface: the custom element in `js/element.js` creates one per
//! connected element and forwards its properties. Everything else is internal.

pub mod clock;
pub mod dom;
pub mod easing;
pub mod gpu;
pub mod layout;
pub mod model;
pub mod paint;
pub mod profile;
pub mod raster;
pub mod renderer;
pub mod scroll;
pub mod song;
pub mod stage;
pub mod style;
pub mod text;
pub mod theme;

use renderer::{TickOptions, View};
use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use wasm_bindgen::prelude::*;
use web_sys::{Element, HtmlCanvasElement, HtmlElement, HtmlMediaElement};

type FrameCallback = Closure<dyn FnMut(f64)>;
type ResizeWatch = (web_sys::ResizeObserver, Closure<dyn FnMut()>);
type IntersectionWatch = (web_sys::IntersectionObserver, Closure<dyn FnMut(js_sys::Array)>);

struct Shared {
    /// The window the view is in. Its animation frames, not this module's window's, are the ones to
    /// draw on: a Picture-in-Picture window keeps getting frames while the tab behind it is hidden.
    win: web_sys::Window,
    /// `performance.now()` in that window.
    now: dom::Now,
    view: RefCell<View>,
    frame: RefCell<Option<FrameCallback>>,
    scheduled: Cell<Option<i32>>,
    listeners: RefCell<Vec<Listener>>,
    media_listeners: RefCell<Vec<Listener>>,
    resize: RefCell<Option<ResizeWatch>>,
    on_page: RefCell<Option<IntersectionWatch>>,
    /// A `(resolution)` query for the device pixel ratio the view draws at, which reports when the
    /// ratio changes (zoom, another screen) so that frames need not read it.
    pixel_ratio: RefCell<Option<Listener>>,
    /// Set when that query fired: the next frame watches the new ratio. Not done in the listener,
    /// which would drop itself while running.
    rewatch_pixel_ratio: Cell<bool>,
}

/// An event listener kept alive for as long as it is attached.
struct Listener {
    target: web_sys::EventTarget,
    name: &'static str,
    closure: Closure<dyn FnMut(web_sys::Event)>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = self.target.remove_event_listener_with_callback(self.name, self.closure.as_ref().unchecked_ref());
    }
}

fn listen(
    shared: &Rc<Shared>,
    target: &web_sys::EventTarget,
    name: &'static str,
    passive: bool,
    handler: impl Fn(&Rc<Shared>, web_sys::Event) + 'static,
) -> Listener {
    let weak: Weak<Shared> = Rc::downgrade(shared);
    let closure = Closure::<dyn FnMut(web_sys::Event)>::new(move |event: web_sys::Event| {
        if let Some(shared) = weak.upgrade() {
            handler(&shared, event);
        }
    });
    let options = web_sys::AddEventListenerOptions::new();
    options.set_passive(passive);
    let _ = target.add_event_listener_with_callback_and_add_event_listener_options(
        name,
        closure.as_ref().unchecked_ref(),
        &options,
    );
    Listener { target: target.clone(), name, closure }
}

impl Shared {
    fn request_frame(self: &Rc<Self>) {
        if self.scheduled.get().is_some() {
            return;
        }
        let frame = self.frame.borrow();
        if let Some(closure) = frame.as_ref() {
            if let Ok(id) = self.win.request_animation_frame(closure.as_ref().unchecked_ref()) {
                self.scheduled.set(Some(id));
            }
        }
    }

    fn run_frame(self: &Rc<Self>, now_ms: f64) {
        self.scheduled.set(None);
        self.view.borrow_mut().profile.begin();
        let started = self.now.ms();
        let again = self.view.borrow_mut().frame(now_ms);
        {
            let mut view = self.view.borrow_mut();
            let spent = self.now.ms() - started;
            view.stats.frames += 1;
            view.stats.cpu_ms = if view.stats.frames == 1 { spent } else { view.stats.cpu_ms * 0.95 + spent * 0.05 };
            view.stats.max_cpu_ms = view.stats.max_cpu_ms.max(spent);
        }
        if self.view.borrow_mut().take_built() {
            self.observe_layout();
        }
        let wanted = self.view.borrow_mut().take_wanted_image();
        if let Some(url) = wanted {
            self.load_image(url);
        }
        self.flush_events();
        if self.rewatch_pixel_ratio.take() {
            self.watch_pixel_ratio();
        }
        self.view.borrow_mut().profile.end();
        if again {
            self.request_frame();
        }
    }

    /// Watches the window's current device pixel ratio for a change.
    fn watch_pixel_ratio(self: &Rc<Self>) {
        let query = format!("(resolution: {}dppx)", self.win.device_pixel_ratio());
        let Ok(Some(list)) = self.win.match_media(&query) else { return };
        let listener = listen(self, &list.unchecked_into(), "change", true, |shared, _| {
            shared.view.borrow_mut().pixel_ratio_changed = true;
            shared.rewatch_pixel_ratio.set(true);
            shared.request_frame();
        });
        *self.pixel_ratio.borrow_mut() = Some(listener);
    }

    /// Loads an image-highlight image, CORS-enabled so the texture it is drawn into stays readable.
    /// A failed load leaves the note in its colours.
    fn load_image(self: &Rc<Self>, url: String) {
        let doc = self.view.borrow().doc.clone();
        let Ok(image) = doc.create_element("img") else { return };
        let image: web_sys::HtmlImageElement = image.unchecked_into();
        image.set_cross_origin(Some("anonymous"));
        image.set_src(&url);
        let weak = Rc::downgrade(self);
        let loaded = image.clone();
        let done = Closure::once(move |_: JsValue| {
            if let Some(shared) = weak.upgrade() {
                shared.view.borrow_mut().image_loaded(url, loaded);
                shared.request_frame();
            }
        });
        let failed = Closure::once(|_: JsValue| {});
        let _ = image.decode().then2(&done, &failed);
        done.forget();
        failed.forget();
    }

    fn observe_layout(&self) {
        let resize = self.resize.borrow();
        let Some((observer, _)) = resize.as_ref() else { return };
        observer.disconnect();
        let view = self.view.borrow();
        observer.observe(&view.host);
        if let Some(scroller) = &view.scroller {
            observer.observe(scroller);
        }
        for element in view.observed_elements() {
            observer.observe(&element);
        }
    }

    /// Dispatched outside the view's borrow, so a listener may call back into the renderer.
    fn flush_events(&self) {
        let (host, events) = {
            let mut view = self.view.borrow_mut();
            (view.host.clone(), std::mem::take(&mut view.events))
        };
        for event in &events {
            let (name, detail) = renderer::event_detail(event);
            let init = web_sys::CustomEventInit::new();
            init.set_bubbles(true);
            init.set_composed(true);
            init.set_detail(&detail);
            if let Ok(custom) = web_sys::CustomEvent::new_with_event_init_dict(name, &init) {
                let _ = host.dispatch_event(&custom);
            }
        }
    }
}

#[wasm_bindgen]
pub struct Renderer {
    shared: Rc<Shared>,
}

#[wasm_bindgen]
impl Renderer {
    /// Builds the view inside `host`.
    #[wasm_bindgen(constructor)]
    pub fn new(host: HtmlElement) -> Result<Renderer, JsValue> {
        let view = View::new(host.clone()).map_err(|e| JsValue::from_str(&e))?;
        let (win, doc) = (view.win.clone(), view.doc.clone());
        let shared = Rc::new(Shared {
            win: win.clone(),
            now: dom::Now::of(&win),
            view: RefCell::new(view),
            frame: RefCell::new(None),
            scheduled: Cell::new(None),
            listeners: RefCell::new(Vec::new()),
            media_listeners: RefCell::new(Vec::new()),
            resize: RefCell::new(None),
            on_page: RefCell::new(None),
            pixel_ratio: RefCell::new(None),
            rewatch_pixel_ratio: Cell::new(false),
        });
        let weak = Rc::downgrade(&shared);
        *shared.frame.borrow_mut() = Some(Closure::new(move |now: f64| {
            if let Some(shared) = weak.upgrade() {
                shared.run_frame(now);
            }
        }));

        let container: web_sys::EventTarget = shared.view.borrow().container.clone().into();
        let mut listeners = vec![listen(&shared, &container, "click", false, |shared, event| {
            // Unchecked casts: the event may come from another window's realm.
            let mouse: &web_sys::MouseEvent = event.unchecked_ref();
            let Some(target) = event.target().map(|t| t.unchecked_into::<Element>()) else { return };
            if !js_sys::Reflect::has(&target, &"closest".into()).unwrap_or(false) {
                return;
            }
            let seeked = shared.view.borrow_mut().on_click(
                &target,
                mouse.alt_key(),
                (mouse.client_x() as f32, mouse.client_y() as f32),
            );
            if seeked.is_some() {
                shared.flush_events();
                shared.request_frame();
            }
        })];
        // The line under the pointer, for the theme's hover look. A touch has no hover: its
        // `pointerover` comes with the tap and would leave the line looking hovered.
        listeners.push(listen(&shared, &container, "pointerover", false, |shared, event| {
            if dom::get(&event, "pointerType").as_string().as_deref() == Some("touch") {
                return;
            }
            let index = event
                .target()
                .map(|t| t.unchecked_into::<Element>())
                .filter(|t| js_sys::Reflect::has(t, &"closest".into()).unwrap_or(false))
                .and_then(|t| t.closest(".blyrics--line").ok().flatten())
                .and_then(|line| line.get_attribute("data-line-number"))
                .and_then(|n| n.parse::<usize>().ok());
            if shared.view.borrow_mut().set_hovered(index) {
                shared.request_frame();
            }
        }));
        listeners.push(listen(&shared, &container, "pointerleave", false, |shared, _| {
            if shared.view.borrow_mut().set_hovered(None) {
                shared.request_frame();
            }
        }));
        let fonts: web_sys::EventTarget = doc.fonts().unchecked_into();
        listeners.push(listen(&shared, &fonts, "loadingdone", true, |shared, _| {
            shared.view.borrow_mut().invalidate_layout();
            shared.request_frame();
        }));
        // The theme's image-highlight image can depend on these, as the DOM renderer's did.
        for query in ["(dynamic-range: high)", "(forced-colors: active)"] {
            if let Ok(Some(list)) = win.match_media(query) {
                listeners.push(listen(&shared, &list.unchecked_into(), "change", true, |shared, _| {
                    shared.view.borrow_mut().invalidate_layout();
                    shared.request_frame();
                }));
            }
        }
        listeners.push(listen(&shared, &win.clone().into(), "resize", true, |shared, _| {
            shared.view.borrow_mut().invalidate_layout();
            shared.request_frame();
        }));
        *shared.listeners.borrow_mut() = listeners;
        shared.watch_pixel_ratio();

        let weak = Rc::downgrade(&shared);
        let on_resize = Closure::<dyn FnMut()>::new(move || {
            if let Some(shared) = weak.upgrade() {
                shared.view.borrow_mut().invalidate_layout();
                shared.request_frame();
            }
        });
        if let Ok(observer) = web_sys::ResizeObserver::new(on_resize.as_ref().unchecked_ref()) {
            observer.observe(&host);
            *shared.resize.borrow_mut() = Some((observer, on_resize));
        }

        // Whether the page shows the lines at all, reported on change rather than polled.
        let weak = Rc::downgrade(&shared);
        let on_page = Closure::<dyn FnMut(js_sys::Array)>::new(move |entries: js_sys::Array| {
            let Some(shared) = weak.upgrade() else { return };
            let Some(entry) = entries.iter().last() else { return };
            let visible = dom::get(&entry, "isIntersecting").as_bool().unwrap_or(true);
            shared.view.borrow_mut().set_on_page(visible);
            if visible {
                shared.request_frame();
            }
        });
        if let Ok(observer) = web_sys::IntersectionObserver::new(on_page.as_ref().unchecked_ref()) {
            observer.observe(&shared.view.borrow().container);
            *shared.on_page.borrow_mut() = Some((observer, on_page));
        }

        let renderer = Renderer { shared };
        renderer.set_scroll_element(None);
        // Fonts that finish loading before the first frame change nothing, but the ones still
        // loading would leave the first layout measured in fallback faces.
        let weak = Rc::downgrade(&renderer.shared);
        let ready = doc.fonts().ready();
        if let Ok(ready) = ready {
            let then = Closure::once(move |_: JsValue| {
                if let Some(shared) = weak.upgrade() {
                    shared.view.borrow_mut().invalidate_layout();
                    shared.request_frame();
                }
            });
            let _ = ready.then(&then);
            then.forget();
        }
        Ok(renderer)
    }

    /// The song. `lyrics` is a `Lyric[]`, `options` a `{ noLyrics?, language?, songwriters? }`.
    #[wasm_bindgen(js_name = setLyrics)]
    pub fn set_lyrics(&self, lyrics: JsValue, options: JsValue) -> Result<(), JsValue> {
        let lyrics: Vec<model::Lyric> = if lyrics.is_null() || lyrics.is_undefined() {
            Vec::new()
        } else {
            serde_wasm_bindgen::from_value(lyrics)?
        };
        let options: model::LyricsOptions = if options.is_null() || options.is_undefined() {
            Default::default()
        } else {
            serde_wasm_bindgen::from_value(options)?
        };
        self.shared.view.borrow_mut().set_lyrics(lyrics, options);
        self.observe_after_change();
        Ok(())
    }

    /// A theme stylesheet: `--blyrics-*` custom properties, and `blyrics-key = value;` settings in its comments.
    #[wasm_bindgen(js_name = setTheme)]
    pub fn set_theme(&self, css: &str) {
        self.shared.view.borrow_mut().set_theme(css);
        self.shared.request_frame();
    }

    /// Drives the clock by hand, when no media element is bound.
    #[wasm_bindgen(js_name = setTime)]
    pub fn set_time(&self, seconds: f64, playing: bool) {
        self.shared.view.borrow_mut().set_time(seconds, playing);
        self.shared.request_frame();
    }

    /// Binds a media element as the clock, or unbinds with `null`.
    #[wasm_bindgen(js_name = setMedia)]
    pub fn set_media(&self, media: Option<HtmlMediaElement>) {
        self.shared.media_listeners.borrow_mut().clear();
        if let Some(media) = &media {
            let target: web_sys::EventTarget = media.clone().into();
            let listeners = ["play", "pause", "seeking", "seeked", "ratechange", "timeupdate", "loadedmetadata"]
                .into_iter()
                .map(|name| {
                    listen(&self.shared, &target, name, true, move |shared, _| {
                        if name == "play" {
                            shared.view.borrow_mut().resume_autoscroll();
                        }
                        shared.request_frame();
                    })
                })
                .collect();
            *self.shared.media_listeners.borrow_mut() = listeners;
        }
        self.shared.view.borrow_mut().media = media;
        self.shared.request_frame();
    }

    /// The element autoscroll moves. `null` finds the nearest scrolling ancestor.
    #[wasm_bindgen(js_name = setScrollElement)]
    pub fn set_scroll_element(&self, element: Option<Element>) {
        let host = self.shared.view.borrow().host.clone();
        let scroller = element.or_else(|| nearest_scroller(&host));
        let target: web_sys::EventTarget = match &scroller {
            Some(el) => el.clone().into(),
            None => self.shared.win.clone().into(),
        };
        let listener = listen(&self.shared, &target, "scroll", true, |shared, _| {
            // What is drawn is placed by the scroll position, so any scroll is drawn again.
            shared.view.borrow().scroll_changed();
            if !shared.view.borrow().own_scroll_detection {
                shared.request_frame();
                return;
            }
            let now = shared.now.ms();
            shared.view.borrow_mut().on_scroll(now);
            shared.flush_events();
            shared.request_frame();
        });
        {
            let mut listeners = self.shared.listeners.borrow_mut();
            listeners.retain(|l| l.name != "scroll");
            listeners.push(listener);
        }
        if let (Some(el), Some((observer, _))) = (&scroller, self.shared.resize.borrow().as_ref()) {
            observer.observe(el);
        }
        let mut view = self.shared.view.borrow_mut();
        view.scroller = scroller;
        view.scroll_changed();
        view.invalidate_layout();
        drop(view);
        self.shared.request_frame();
    }

    /// `{ lyricOffset?, globalLyricOffset?, playbackRate?, smoothScroll?, passiveScrollEnabled? }`,
    /// offsets in seconds.
    #[wasm_bindgen(js_name = setTickOptions)]
    pub fn set_tick_options(&self, options: JsValue) {
        let number = |key: &str, fallback: f64| dom::get(&options, key).as_f64().unwrap_or(fallback);
        let smooth = dom::get(&options, "smoothScroll").as_bool().unwrap_or(true);
        let passive = dom::get(&options, "passiveScrollEnabled").as_bool().unwrap_or(false);
        self.shared.view.borrow_mut().tick_options = TickOptions {
            lyric_offset_s: number("lyricOffset", 0.0),
            global_offset_s: number("globalLyricOffset", 0.0),
            richsync_trim_s: number("richsyncOffsetTrim", 0.0),
            line_trim_s: number("lineOffsetTrim", 0.0),
            rate: number("playbackRate", 1.0),
            smooth_scroll: smooth,
            passive_scroll: passive,
        };
        self.shared.request_frame();
    }

    /// `"stage"` shows only the lines being sung, at the bottom of the element; anything else scrolls.
    #[wasm_bindgen(js_name = setLayout)]
    pub fn set_layout(&self, layout: &str) {
        let mut view = self.shared.view.borrow_mut();
        let stage = layout == "stage";
        if view.stage != stage {
            view.stage = stage;
            view.rebuild();
        }
        drop(view);
        self.shared.request_frame();
    }

    /// Which decorations to show from the lyrics' own fields.
    #[wasm_bindgen(js_name = setDecorations)]
    pub fn set_decorations(&self, translations: bool, romanizations: bool) {
        let mut view = self.shared.view.borrow_mut();
        view.decorations = song::Decorations { translations, romanizations };
        view.rebuild();
        drop(view);
        self.shared.request_frame();
    }

    #[wasm_bindgen(js_name = resumeAutoscroll)]
    pub fn resume_autoscroll(&self) {
        self.shared.view.borrow_mut().resume_autoscroll();
        self.shared.flush_events();
        self.shared.request_frame();
    }

    /// Starts or stops profiling: GPU time, and each frame's CPU time by phase for `takeProfile()`.
    /// Returns whether the browser can time the GPU.
    #[wasm_bindgen(js_name = setProfiling)]
    pub fn set_profiling(&self, on: bool) -> bool {
        self.shared.view.borrow_mut().set_profiling(on)
    }

    /// The frames profiled since profiling started or this was last called, which it forgets:
    /// `{ fields, frames, gpu }`. `frames` holds one row of `fields.length` milliseconds per frame,
    /// the frame's total and then its phases. `gpu` holds the GPU milliseconds of the frames timed so
    /// far, which lag a few frames behind and are empty where the browser cannot time the GPU.
    #[wasm_bindgen(js_name = takeProfile)]
    pub fn take_profile(&self) -> JsValue {
        let mut view = self.shared.view.borrow_mut();
        let (frames, gpu) = view.take_profile();
        let fields = js_sys::Array::new();
        fields.push(&"total".into());
        for phase in profile::PHASES {
            fields.push(&phase.into());
        }
        let out = js_sys::Object::new();
        dom::set(&out, "fields", &fields);
        dom::set(&out, "frames", &js_sys::Float32Array::from(&frames[..]));
        dom::set(&out, "gpu", &js_sys::Float32Array::from(&gpu[..]));
        out.into()
    }

    /// `{ frames, cpuMs, maxCpuMs, gpuMs, quads, residentLines, textureBytes }`: averages over recent frames, and
    /// the slowest frame since the last call.
    pub fn stats(&self) -> JsValue {
        let mut view = self.shared.view.borrow_mut();
        let max_cpu_ms = std::mem::take(&mut view.stats.max_cpu_ms);
        let out = js_sys::Object::new();
        dom::set(&out, "frames", &JsValue::from(view.stats.frames as f64));
        dom::set(&out, "cpuMs", &JsValue::from(view.stats.cpu_ms));
        dom::set(&out, "maxCpuMs", &JsValue::from(max_cpu_ms));
        dom::set(&out, "gpuMs", &view.gpu_ms().map(JsValue::from).unwrap_or(JsValue::NULL));
        dom::set(&out, "quads", &JsValue::from(view.stats.quads as u32));
        dom::set(&out, "residentLines", &JsValue::from(view.stats.resident as u32));
        dom::set(&out, "textureBytes", &JsValue::from(view.stats.texture_bytes as f64));
        out.into()
    }

    /// Measures the lines again on the next frame. With `settle`, lines the new measurement moves
    /// slide there, and the line in view holds still.
    pub fn relayout(&self, settle: Option<bool>) {
        self.shared.view.borrow_mut().relayout(settle.unwrap_or(false));
        self.shared.request_frame();
    }

    // -- For the `createLyricsRenderer` adapter in js/renderer.js --------------------------------

    /// A player snapshot: the time it showed, whether it was playing, and when it was read, as
    /// `Date.now()` (negative when it was not read off a player).
    #[wasm_bindgen(js_name = setSnapshot)]
    pub fn set_snapshot(&self, seconds: f64, playing: bool, event_ms: f64) {
        if self.shared.view.borrow_mut().set_snapshot(seconds, playing, event_ms) {
            self.shared.request_frame();
        }
    }

    #[wasm_bindgen(js_name = resetClock)]
    pub fn reset_clock(&self) {
        self.shared.view.borrow_mut().reset_clock();
    }

    /// Whether the host has the view off the screen. A hidden view draws nothing until shown.
    #[wasm_bindgen(js_name = setHidden)]
    pub fn set_hidden(&self, hidden: bool) {
        let was = std::mem::replace(&mut self.shared.view.borrow_mut().hidden, hidden);
        if was && !hidden {
            self.shared.request_frame();
        }
    }

    /// Moves the view into another element of the same document.
    #[wasm_bindgen(js_name = setHost)]
    pub fn set_host(&self, host: HtmlElement) {
        self.shared.view.borrow_mut().set_host(host);
        self.observe_after_change();
    }

    /// Hangs a translation on line `index`, or takes it off with `null`. Returns whether the line
    /// had one before.
    #[wasm_bindgen(js_name = hangTranslation)]
    pub fn hang_translation(&self, index: usize, text: Option<String>, language: Option<String>) -> bool {
        let value = text.map(|t| (t, language.unwrap_or_default()));
        let had = self.shared.view.borrow_mut().hang_translation(index, value);
        self.shared.request_frame();
        had
    }

    /// Hangs a romanization on line `index`, swept by `timed` (a `LyricPart[]`) if given, or takes
    /// it off with `null`. Returns whether the line had one before.
    #[wasm_bindgen(js_name = hangRomanization)]
    pub fn hang_romanization(&self, index: usize, text: Option<String>, timed: JsValue) -> Result<bool, JsValue> {
        let timed: Option<Vec<model::LyricPart>> =
            if timed.is_null() || timed.is_undefined() { None } else { Some(serde_wasm_bindgen::from_value(timed)?) };
        let value = text.map(|t| (t, timed));
        let had = self.shared.view.borrow_mut().hang_romanization(index, value);
        self.shared.request_frame();
        Ok(had)
    }

    #[wasm_bindgen(js_name = setLanguage)]
    pub fn set_language(&self, language: Option<String>) {
        self.shared.view.borrow_mut().set_language(language.filter(|l| !l.is_empty()));
        self.shared.request_frame();
    }

    /// Moves line `index`'s start, or with `part` one of its parts', to `start` seconds.
    #[wasm_bindgen(js_name = setStart)]
    pub fn set_start(&self, index: usize, part: Option<usize>, start: f32) {
        self.shared.view.borrow_mut().set_start(index, part, start);
        self.shared.request_frame();
    }

    /// `[start, duration]` in seconds of line `index`, or with `part` one of its parts.
    pub fn timing(&self, index: usize, part: Option<usize>) -> Option<Vec<f32>> {
        self.shared.view.borrow().timing(index, part).map(|(start, duration)| vec![start, duration])
    }

    /// `[{ element, parts: HTMLElement[] }]`, one per line, in order.
    #[wasm_bindgen(js_name = lineElements)]
    pub fn line_elements(&self) -> js_sys::Array {
        let out = js_sys::Array::new();
        for (element, parts) in self.shared.view.borrow().line_elements() {
            let record = js_sys::Object::new();
            dom::set(&record, "element", &element);
            let list = js_sys::Array::new();
            for part in parts {
                list.push(&part);
            }
            dom::set(&record, "parts", &list);
            out.push(&record);
        }
        out
    }

    /// The index of the line `element` is, or -1.
    #[wasm_bindgen(js_name = lineIndex)]
    pub fn line_index(&self, element: &Element) -> i32 {
        self.shared.view.borrow().line_index(element).map(|i| i as i32).unwrap_or(-1)
    }

    /// Changes whenever the line elements do.
    #[wasm_bindgen(getter)]
    pub fn generation(&self) -> u32 {
        self.shared.view.borrow().generation
    }

    /// `"richsync"`, `"synced"` or `"none"`, and `"none"` with no song.
    #[wasm_bindgen(js_name = syncType)]
    pub fn sync_type(&self) -> String {
        self.shared.view.borrow().sync_type().map(|s| s.as_str()).unwrap_or("none").to_string()
    }

    #[wasm_bindgen(js_name = hasSong)]
    pub fn has_song(&self) -> bool {
        self.shared.view.borrow().has_song()
    }

    /// The container the lines are built in, which the host may add its own things to.
    #[wasm_bindgen(getter)]
    pub fn container(&self) -> HtmlElement {
        self.shared.view.borrow().container.clone()
    }

    /// Takes the lines off the screen and keeps the container. Returns whether there were any.
    #[wasm_bindgen(js_name = clearOnScreen)]
    pub fn clear_on_screen(&self) -> bool {
        self.shared.view.borrow_mut().clear_on_screen()
    }

    /// Drops the song and takes the container out of the page; `setLyrics` puts both back.
    pub fn clear(&self) {
        self.shared.view.borrow_mut().clear();
    }

    /// The host saw the reader scroll. Scrolls the renderer made itself are told apart and ignored.
    #[wasm_bindgen(js_name = noteScroll)]
    pub fn note_scroll(&self) {
        let now = self.shared.now.ms();
        self.shared.view.borrow_mut().on_scroll(now);
        self.shared.flush_events();
        self.shared.request_frame();
    }

    /// The canvas the view draws on.
    #[wasm_bindgen(getter)]
    pub fn canvas(&self) -> HtmlCanvasElement {
        self.shared.view.borrow().canvas.clone()
    }

    /// A copy of what the view shows now, on a 2D canvas the same size, styled like the view's: for
    /// a host that clones the page to animate it away, where a WebGL canvas clones blank. The frame
    /// is drawn and copied in one go, while the drawing buffer still holds it.
    pub fn snapshot(&self) -> Option<HtmlCanvasElement> {
        let now = self.shared.now.ms();
        self.shared.view.borrow_mut().frame(now);
        let view = self.shared.view.borrow();
        let source = &view.canvas;
        let copy: HtmlCanvasElement = view.doc.create_element("canvas").ok()?.unchecked_into();
        copy.set_width(source.width());
        copy.set_height(source.height());
        let _ = copy.set_attribute("style", &source.get_attribute("style").unwrap_or_default());
        copy.set_class_name(&source.class_name());
        let context: web_sys::CanvasRenderingContext2d = copy.get_context("2d").ok()??.unchecked_into();
        context.draw_image_with_html_canvas_element(source, 0.0, 0.0).ok()?;
        Some(copy)
    }

    /// Whether the view watches its scroll element for a reader scrolling (the default), or leaves
    /// it to the host to report scrolls through `noteScroll`.
    #[wasm_bindgen(js_name = setScrollDetection)]
    pub fn set_scroll_detection(&self, own: bool) {
        self.shared.view.borrow_mut().own_scroll_detection = own;
    }

    /// Sends any events waiting on the next frame now.
    #[wasm_bindgen(js_name = flushEvents)]
    pub fn flush_events(&self) {
        self.shared.flush_events();
    }

    fn observe_after_change(&self) {
        self.shared.observe_layout();
        self.shared.request_frame();
    }

    /// Detaches everything. The renderer is unusable afterwards.
    pub fn destroy(&self) {
        if let Some(id) = self.shared.scheduled.take() {
            let _ = self.shared.win.cancel_animation_frame(id);
        }
        self.shared.listeners.borrow_mut().clear();
        self.shared.media_listeners.borrow_mut().clear();
        if let Some((observer, _)) = self.shared.resize.borrow_mut().take() {
            observer.disconnect();
        }
        if let Some((observer, _)) = self.shared.on_page.borrow_mut().take() {
            observer.disconnect();
        }
        self.shared.frame.borrow_mut().take();
    }
}

fn nearest_scroller(host: &HtmlElement) -> Option<Element> {
    let mut node: Option<Element> = Some(host.clone().into());
    while let Some(el) = node {
        let overflow = dom::computed_value(&el, "overflow-y");
        if overflow == "auto" || overflow == "scroll" {
            return Some(el);
        }
        node = el.parent_element();
    }
    None
}
