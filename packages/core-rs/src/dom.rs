//! Thin helpers over web-sys so the layout code reads like the markup it builds.

use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Document, Element, HtmlElement, Window};

pub fn window() -> Window {
    web_sys::window().expect("no window")
}

pub fn document() -> Document {
    window().document().expect("no document")
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
    window().get_computed_style(element).ok().flatten().expect("computed style")
}

pub fn computed_value(element: &Element, property: &str) -> String {
    computed(element).get_property_value(property).unwrap_or_default().trim().to_string()
}

pub fn now_ms() -> f64 {
    window().performance().map(|p| p.now()).unwrap_or(0.0)
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
