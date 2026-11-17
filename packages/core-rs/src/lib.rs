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
use web_sys::{Element, HtmlElement, HtmlMediaElement};

type FrameCallback = Closure<dyn FnMut(f64)>;
type ResizeWatch = (web_sys::ResizeObserver, Closure<dyn FnMut()>);

struct Shared {
    view: RefCell<View>,
    frame: RefCell<Option<FrameCallback>>,
    scheduled: Cell<Option<i32>>,
    listeners: RefCell<Vec<Listener>>,
    media_listeners: RefCell<Vec<Listener>>,
    resize: RefCell<Option<ResizeWatch>>,
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
            if let Ok(id) = dom::window().request_animation_frame(closure.as_ref().unchecked_ref()) {
                self.scheduled.set(Some(id));
            }
        }
    }

    fn run_frame(self: &Rc<Self>, now_ms: f64) {
        self.scheduled.set(None);
        let started = dom::now_ms();
        let again = self.view.borrow_mut().frame(now_ms);
        {
            let mut view = self.view.borrow_mut();
            let spent = dom::now_ms() - started;
            view.stats.frames += 1;
            view.stats.cpu_ms = if view.stats.frames == 1 { spent } else { view.stats.cpu_ms * 0.95 + spent * 0.05 };
            view.stats.max_cpu_ms = view.stats.max_cpu_ms.max(spent);
        }
        if self.view.borrow_mut().take_built() {
            self.observe_layout();
        }
        self.flush_events();
        if again {
            self.request_frame();
        }
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
        let shared = Rc::new(Shared {
            view: RefCell::new(view),
            frame: RefCell::new(None),
            scheduled: Cell::new(None),
            listeners: RefCell::new(Vec::new()),
            media_listeners: RefCell::new(Vec::new()),
            resize: RefCell::new(None),
        });
        let weak = Rc::downgrade(&shared);
        *shared.frame.borrow_mut() = Some(Closure::new(move |now: f64| {
            if let Some(shared) = weak.upgrade() {
                shared.run_frame(now);
            }
        }));

        let container: web_sys::EventTarget = shared.view.borrow().container.clone().into();
        let mut listeners = vec![listen(&shared, &container, "click", false, |shared, event| {
            let Some(mouse) = event.dyn_ref::<web_sys::MouseEvent>() else { return };
            let Some(target) = event.target().and_then(|t| t.dyn_into::<Element>().ok()) else { return };
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
        if let Ok(fonts) = dom::document().fonts().dyn_into::<web_sys::EventTarget>() {
            listeners.push(listen(&shared, &fonts, "loadingdone", true, |shared, _| {
                shared.view.borrow_mut().invalidate_layout();
                shared.request_frame();
            }));
        }
        listeners.push(listen(&shared, &dom::window().into(), "resize", true, |shared, _| {
            shared.view.borrow_mut().invalidate_layout();
            shared.request_frame();
        }));
        *shared.listeners.borrow_mut() = listeners;

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

        let renderer = Renderer { shared };
        renderer.set_scroll_element(None);
        // Fonts that finish loading before the first frame change nothing, but the ones still
        // loading would leave the first layout measured in fallback faces.
        let weak = Rc::downgrade(&renderer.shared);
        let ready = dom::document().fonts().ready();
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
        self.shared.request_frame();
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
            None => dom::window().into(),
        };
        let listener = listen(&self.shared, &target, "scroll", true, |shared, _| {
            shared.view.borrow_mut().on_scroll(dom::now_ms());
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

    /// Starts or stops measuring GPU time. Returns whether the browser can time the GPU.
    #[wasm_bindgen(js_name = setProfiling)]
    pub fn set_profiling(&self, on: bool) -> bool {
        self.shared.view.borrow_mut().set_profiling(on)
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

    pub fn relayout(&self) {
        self.shared.view.borrow_mut().invalidate_layout();
        self.shared.request_frame();
    }

    /// Detaches everything. The renderer is unusable afterwards.
    pub fn destroy(&self) {
        if let Some(id) = self.shared.scheduled.take() {
            let _ = dom::window().cancel_animation_frame(id);
        }
        self.shared.listeners.borrow_mut().clear();
        self.shared.media_listeners.borrow_mut().clear();
        if let Some((observer, _)) = self.shared.resize.borrow_mut().take() {
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
