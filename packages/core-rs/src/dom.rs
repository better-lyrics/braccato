//! Thin helpers over web-sys so the layout code reads like the markup it builds.

use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Document, Element, HtmlElement, Window};

// A view can live in another window than the one this module loaded in (Document
// Picture-in-Picture, an iframe), so nothing below reaches for the global window: each helper works
// in the window of the node it is given. That window is also another JavaScript realm, so DOM
// objects from it are cast with `unchecked_into`, never `dyn_into`, whose `instanceof` check would
// fail against this realm's constructors.

/// The window this module was loaded in, for when a node has none.
fn global_window() -> Window {
    web_sys::window().expect("no window")
}

/// The document a node belongs to.
pub fn doc_of(node: &web_sys::Node) -> Document {
    node.owner_document().unwrap_or_else(|| global_window().document().expect("no document"))
}

/// The window a node's document is shown in.
pub fn win_of(node: &web_sys::Node) -> Window {
    doc_of(node).default_view().unwrap_or_else(global_window)
}

/// Creates `<tag class="...">`.
pub fn element(doc: &Document, tag: &str, class: &str) -> HtmlElement {
    let element: HtmlElement = doc.create_element(tag).expect("create_element").unchecked_into();
    if !class.is_empty() {
        element.set_class_name(class);
    }
    element
}

pub fn text_node(doc: &Document, parent: &Element, text: &str) -> web_sys::Text {
    let node = doc.create_text_node(text);
    let _ = parent.append_child(&node);
    node
}

pub fn set_attr(element: &Element, name: &str, value: &str) {
    let _ = element.set_attribute(name, value);
}

pub fn set_style(element: &HtmlElement, property: &str, value: &str) {
    let _ = element.style().set_property(property, value);
}

pub fn append(parent: &Element, child: &Element) {
    let _ = parent.append_child(child);
}

pub fn computed(element: &Element) -> web_sys::CssStyleDeclaration {
    win_of(element).get_computed_style(element).ok().flatten().expect("computed style")
}

pub fn computed_value(element: &Element, property: &str) -> String {
    computed(element).get_property_value(property).unwrap_or_default().trim().to_string()
}

/// How far the element's `transform` and `translate` move it down, in pixels. Only translations are
/// read, which is what a page slides content in with.
pub fn translated_y(element: &Element) -> f32 {
    let style = computed(element);
    let read = |property: &str| style.get_property_value(property).unwrap_or_default();
    let transform = read("transform");
    let transform = transform.trim();
    let matrix = |prefix: &str, index: usize| {
        let args = transform.strip_prefix(prefix)?.strip_suffix(')')?;
        args.split(',').nth(index).map(px)
    };
    let mut y = matrix("matrix(", 5).or_else(|| matrix("matrix3d(", 13)).unwrap_or(0.0);
    // `translate` is "none", or "x", "x y" or "x y z"; a percentage is of the element's own height.
    if let Some(second) = read("translate").split_whitespace().nth(1) {
        y += match second.strip_suffix('%') {
            Some(percent) => {
                percent.parse::<f32>().unwrap_or(0.0) / 100.0 * element.get_bounding_client_rect().height() as f32
            }
            None => px(second),
        };
    }
    y
}

/// The element's parent, crossing out of a shadow root to its host.
pub fn parent_across_shadow(element: &Element) -> Option<Element> {
    element.parent_element().or_else(|| {
        let parent = element.parent_node()?;
        // A shadow root is the only document fragment an element in the page can sit in.
        if parent.node_type() != web_sys::Node::DOCUMENT_FRAGMENT_NODE {
            return None;
        }
        let host = get(&parent, "host");
        (!host.is_null() && !host.is_undefined()).then(|| host.unchecked_into())
    })
}

/// `performance.now()` in `win`, which is the clock that window's animation frames are stamped in.
/// `performance.now()` in one window. It holds on to the window's `Performance`: fetching it for
/// every reading is a second call, and an object for the page to collect.
#[derive(Clone)]
pub struct Now(Option<web_sys::Performance>);

impl Now {
    pub fn of(win: &Window) -> Now {
        Now(win.performance())
    }

    pub fn ms(&self) -> f64 {
        self.0.as_ref().map(|p| p.now()).unwrap_or(0.0)
    }
}

/// Reads a property off a plain JS object, for the handful of browser APIs web-sys does not wrap.
pub fn get(object: &JsValue, key: &str) -> JsValue {
    js_sys::Reflect::get(object, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
}

pub fn set(object: &JsValue, key: &str, value: &JsValue) {
    let _ = js_sys::Reflect::set(object, &JsValue::from_str(key), value);
}

/// A CSS length or number in pixels, as the browser serialises computed values ("12.5px", "0").
pub fn px(value: &str) -> f32 {
    value.trim().trim_end_matches("px").parse().unwrap_or(0.0)
}
