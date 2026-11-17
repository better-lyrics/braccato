//! Turns a `Song` into invisible DOM, lets the browser lay it out, and reads back where every
//! letter landed.
//!
//! The DOM mirrors the DOM renderer's markup (minus its highlight copies), so wrapping, bidi
//! reordering, font fallback and per-language glyph choice are exactly what CSS produces. It stays in
//! the page with `opacity: 0`: it is what the scroll element scrolls, what a click lands on, and what
//! a screen reader reads. Nothing in it changes while the song plays, so the browser never lays it
//! out again until the size, fonts or lyrics change.
//!
//! What comes out is a `LineLayout` per line: drawable slots (one per piece of a word, so each can
//! glow on its own), the quads cut out of them, and how the sweep maps across each quad.

use crate::dom::{self, append, element, set_attr, text_node};
use crate::song::{Line, RowKind, Song};
use crate::text;
use crate::theme::Theme;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use wasm_bindgen::JsCast;
use web_sys::{CanvasRenderingContext2d, Document, DomRect, Element, HtmlCanvasElement, HtmlElement, Node, Range};

pub type Rgba = [f32; 4];

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn right(&self) -> f32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> f32 {
        self.y + self.h
    }
    pub fn union(&self, other: &Rect) -> Rect {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        Rect { x, y, w: self.right().max(other.right()) - x, h: self.bottom().max(other.bottom()) - y }
    }
    pub fn expand(&self, dx: f32, dy: f32) -> Rect {
        Rect { x: self.x - dx, y: self.y - dy, w: self.w + 2.0 * dx, h: self.h + 2.0 * dy }
    }
    fn relative(rect: &DomRect, origin: (f32, f32)) -> Rect {
        Rect {
            x: rect.left() as f32 - origin.0,
            y: rect.top() as f32 - origin.1,
            w: rect.width() as f32,
            h: rect.height() as f32,
        }
    }
}

/// One `fillText`: a string drawn with its left edge at `x` and its baseline at `baseline`, in line
/// coordinates. A run cut out of a longer word that must stay shaped together carries a clip.
#[derive(Clone, Debug)]
pub struct TextRun {
    pub text: String,
    pub font: Rc<str>,
    pub letter_spacing: Rc<str>,
    pub lang: Rc<str>,
    pub rtl: bool,
    pub x: f32,
    pub baseline: f32,
    pub clip: Option<Rect>,
}

#[derive(Clone, Debug)]
pub enum Ink {
    Text(Vec<TextRun>),
    /// The instrumental note, drawn from its SVG path.
    Note,
    /// The romanization's rounded background.
    Pill {
        radius: f32,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    /// A timed word, by index into `Line::parts`.
    Part(usize),
    Translation,
    Romanization,
    Pill,
    Credits,
    Note,
}

/// How the sweep crosses a quad: the quad's left and right edges (line coordinates) map onto `a`
/// to `a + w` in word widths, read from the right for right-to-left words.
#[derive(Clone, Copy, Debug, Default)]
pub struct SweepMap {
    pub x0: f32,
    pub x1: f32,
    pub a: f32,
    pub w: f32,
    pub rtl: bool,
}

impl SweepMap {
    /// The word-width position of line x.
    pub fn at(&self, x: f32) -> f32 {
        let width = (self.x1 - self.x0).max(1e-3);
        let along = if self.rtl { (self.x1 - x) / width } else { (x - self.x0) / width };
        self.a + self.w * along
    }
}

#[derive(Clone, Debug)]
pub struct Glyph {
    pub rect: Rect,
    /// Which letter of its word this is, for the letter wave.
    pub letter: Option<u16>,
    pub sweep: SweepMap,
}

/// Where a slot's pixels live in its line's texture. Filled in by the rasterizer.
#[derive(Clone, Copy, Debug, Default)]
pub struct Placement {
    /// Texture pixel that holds the slot's origin (`origin` below).
    pub tex: (f32, f32),
    /// The slot's origin in line device pixels, a whole number so texels land on device pixels.
    pub origin: (f32, f32),
}

#[derive(Clone, Debug)]
pub struct Slot {
    pub ink: Ink,
    pub owner: Owner,
    /// The union of the slot's glyphs, in line coordinates.
    pub rect: Rect,
    /// Room kept around `rect` in the texture for overhanging glyphs and the glow.
    pub margin: f32,
    pub halo: bool,
    pub glyphs: Vec<Glyph>,
    pub placement: Placement,
    /// Drawn in its own colours (emoji), sampled as colour rather than as coverage to tint.
    pub color: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct PartStyle {
    pub inactive: Rgba,
    pub active: Rgba,
    pub glow: Rgba,
    /// The word's font size, which the em lengths of the wobble and wave resolve against.
    pub em: f32,
    pub letters: u16,
    /// Whether the word is its own box (swept as one) rather than flowing inline.
    pub atomic: bool,
}

#[derive(Clone, Debug)]
pub struct LineLayout {
    /// Top and height of the line box in container coordinates.
    pub top: f32,
    pub height: f32,
    /// The height autoscroll centres the line by. The DOM renderer read it as the line's scroll
    /// height, which its sweep cells' 2rem clip margin stretched below the last row of words, and
    /// where lines settle depends on it, so it is kept.
    pub scroll_height: f32,
    pub left: f32,
    pub width: f32,
    /// The scale origin's x, in line coordinates.
    pub origin_x: f32,
    pub slots: Vec<Slot>,
    pub parts: Vec<PartStyle>,
    /// Each word group's box, which its wobble scales about.
    pub groups: Vec<Rect>,
    pub inactive: Rgba,
    pub active: Rgba,
    pub static_color: Rgba,
    pub pill_color: Rgba,
    pub font_px: f32,
    /// Font size of the line's decorations, which their entry slide is measured in.
    pub static_em: f32,
}

/// Handles on the elements a line is measured from.
pub struct LineDom {
    pub element: HtmlElement,
    pub words: Vec<HtmlElement>,
    pub letters: Vec<Vec<HtmlElement>>,
    pub groups: Vec<HtmlElement>,
    pub translation: Option<HtmlElement>,
    pub romanization: Option<HtmlElement>,
    pub romanization_text: Option<HtmlElement>,
    pub note: Option<HtmlElement>,
}

pub struct LayoutDom {
    pub container: HtmlElement,
    pub lines: Vec<LineDom>,
    pub credits: Option<HtmlElement>,
}

// -- Building --------------------------------------------

pub fn build_dom(doc: &Document, container: &HtmlElement, song: &Song, theme: &Theme) -> LayoutDom {
    container.set_inner_html("");
    set_attr(container, "data-sync", song.sync.as_str());
    if song.no_lyrics {
        set_attr(container, "data-no-lyrics", "true");
    } else {
        let _ = container.remove_attribute("data-no-lyrics");
    }
    let lines =
        song.lines.iter().enumerate().map(|(index, line)| build_line(doc, container, line, index, theme)).collect();
    let credits = song.credits.as_ref().map(|names| {
        let p = element(doc, "p", "blyrics-credits");
        let span = element(doc, "span", "blyrics-credits__text");
        let label = dom::computed_value(container, "--blyrics-credits-label");
        let label = label.trim().trim_matches('"').trim_matches('\'');
        let label = if label.is_empty() { "Written by" } else { label };
        text_node(doc, &span, &format!("{label} "));
        let names_span = element(doc, "span", "blyrics-credits__names");
        set_attr(&names_span, "dir", "auto");
        text_node(doc, &names_span, names);
        append(&span, &names_span);
        append(&p, &span);
        append(container, &p);
        p
    });
    LayoutDom { container: container.clone(), lines, credits }
}

fn build_line(doc: &Document, container: &HtmlElement, line: &Line, index: usize, theme: &Theme) -> LineDom {
    let el = element(doc, "div", "blyrics--line");
    set_attr(&el, "dir", "auto");
    set_attr(&el, "data-line-number", &index.to_string());
    if !line.lang.is_empty() {
        set_attr(&el, "lang", &line.lang);
    }
    if let Some(agent) = &line.agent {
        set_attr(&el, "data-agent", agent);
    }
    if line.rtl {
        el.class_list().add_1("blyrics-rtl").ok();
        set_attr(&el, "data-direction", "rtl");
    }
    let mut dom = LineDom {
        element: el.clone(),
        words: Vec::new(),
        letters: Vec::new(),
        groups: Vec::new(),
        translation: None,
        romanization: None,
        romanization_text: None,
        note: None,
    };
    if line.instrumental {
        el.class_list().add_1("blyrics--instrumental").ok();
        set_attr(&el, "data-instrumental", "true");
        let note = element(doc, "span", "brs-note");
        append(&el, &note);
        dom.note = Some(note);
        append(container, &el);
        return dom;
    }
    if line.blank {
        set_attr(&el, "data-blank", "true");
    }

    // Word spans first, indexed like the parts, then placed into their rows.
    for part in &line.parts {
        let word = element(doc, "span", "blyrics--word blyrics-word-highlight");
        set_attr(&word, "dir", "auto");
        if part.rtl {
            word.class_list().add_1("blyrics-rtl").ok();
        }
        if part.long_word {
            set_attr(&word, "data-long-word", "true");
        }
        let mut letters = Vec::new();
        if part.lettered {
            word.class_list().add_1("blyrics-word--lettered").ok();
            for (start, end) in text::grapheme_ranges(&part.text) {
                let letter = element(doc, "span", "blyrics--letter");
                text_node(doc, &letter, &part.text[start..end]);
                append(&word, &letter);
                letters.push(letter);
            }
        } else {
            fill_with_breaks(
                doc,
                &word,
                &part.text,
                theme.settings.long_word_wrap_threshold,
                text::has_joining_script(&part.text),
            );
        }
        dom.words.push(word);
        dom.letters.push(letters);
    }
    for group in &line.groups {
        let class = if group.long { "blyrics-word-group blyrics-word-group-long" } else { "blyrics-word-group" };
        let span = element(doc, "span", class);
        set_attr(&span, "dir", "auto");
        for &part in &group.parts {
            append(&span, &dom.words[part]);
        }
        dom.groups.push(span);
    }

    let mut romanization_row: Option<HtmlElement> = None;
    for row in &line.rows {
        let (row_class, background) = match row.kind {
            RowKind::Main => ("blyrics-line-main", false),
            RowKind::Background(_) => ("blyrics-background-line", true),
            RowKind::Romanization => ("blyrics-line-main", false),
        };
        let row_el = element(doc, "div", row_class);
        set_attr(&row_el, "dir", "auto");
        if row.bidi_sensitive {
            row_el.class_list().add_1("blyrics-bidi-sensitive").ok();
        }
        if row.rtl {
            row_el.class_list().add_1("blyrics-rtl").ok();
            set_attr(&row_el, "data-direction", "rtl");
        }
        let run = element(doc, "span", "blyrics-bidi-run");
        set_attr(&run, "dir", "auto");
        // The run needs the direction too: `dir=auto` alone skips the isolated words inside it and
        // would resolve to left-to-right.
        if row.rtl {
            run.class_list().add_1("blyrics-rtl").ok();
            set_attr(&run, "data-direction", "rtl");
        }
        for (i, &group) in row.groups.iter().enumerate() {
            if row.spaced_before[i] {
                if background {
                    let space = element(doc, "span", "blyrics-background-lyric blyrics-run-background");
                    text_node(doc, &space, " ");
                    append(&run, &space);
                } else {
                    text_node(doc, &run, " ");
                }
            }
            let group_el = &dom.groups[group];
            // Background vocals keep their class wherever they are, so a theme can colour them;
            // only in their own row are they also set smaller.
            if line.groups[group].background {
                group_el.class_list().add_1("blyrics-background-lyric").ok();
                for &part in &line.groups[group].parts {
                    dom.words[part].class_list().add_1("blyrics-background-lyric").ok();
                }
            }
            if background {
                group_el.class_list().add_1("blyrics-run-background").ok();
            }
            append(&run, group_el);
        }
        append(&row_el, &run);
        if row.kind == RowKind::Romanization {
            romanization_row = Some(row_el);
        } else {
            append(&el, &row_el);
        }
    }

    if romanization_row.is_some() || line.romanization.is_some() {
        let pill = element(doc, "div", "blyrics--romanized blyrics-content-line");
        set_attr(&pill, "dir", "auto");
        let lang = line.lang.split('-').next().filter(|l| !l.is_empty()).unwrap_or("und");
        set_attr(&pill, "lang", &format!("{lang}-Latn"));
        if let Some(row) = &romanization_row {
            append(&pill, row);
        } else if let Some(text) = &line.romanization {
            let span = element(doc, "span", "brs-plain");
            text_node(doc, &span, text);
            append(&pill, &span);
            dom.romanization_text = Some(span);
        }
        append(&el, &pill);
        dom.romanization = Some(pill);
    }
    if let Some((text, lang)) = &line.translation {
        let div = element(doc, "div", "blyrics--translated blyrics-content-line");
        set_attr(&div, "dir", "auto");
        if !lang.is_empty() {
            set_attr(&div, "lang", lang);
        }
        text_node(doc, &div, text);
        append(&el, &div);
        dom.translation = Some(div);
    }
    append(container, &el);
    dom
}

/// Long unsplit words get a break opportunity every `every` clusters, as the DOM renderer gave them.
fn fill_with_breaks(doc: &Document, word: &HtmlElement, text: &str, every: usize, joining: bool) {
    let clusters = text::grapheme_ranges(text);
    if joining || text.encode_utf16().count() <= every || clusters.len() <= every {
        text_node(doc, word, text);
        return;
    }
    for (index, chunk) in clusters.chunks(every).enumerate() {
        if index > 0 {
            append(word, &element(doc, "wbr", ""));
        }
        let (start, end) = (chunk[0].0, chunk[chunk.len() - 1].1);
        text_node(doc, word, &text[start..end]);
    }
}

// -- Measuring --------------------------------------------

/// Font metrics and colour parsing need a 2D context; one is kept for the life of the page.
struct Metrics {
    context: CanvasRenderingContext2d,
    ascents: HashMap<Rc<str>, f32>,
    colors: HashMap<String, Rgba>,
    fonts: HashMap<String, Rc<str>>,
}

thread_local! {
    static METRICS: RefCell<Option<Metrics>> = const { RefCell::new(None) };
}

fn with_metrics<R>(f: impl FnOnce(&mut Metrics) -> R) -> R {
    METRICS.with(|cell| {
        let mut slot = cell.borrow_mut();
        let metrics = slot.get_or_insert_with(|| {
            let canvas: HtmlCanvasElement = dom::document().create_element("canvas").unwrap().unchecked_into();
            canvas.set_width(1);
            canvas.set_height(1);
            let options = js_sys::Object::new();
            dom::set(&options, "willReadFrequently", &true.into());
            let context: CanvasRenderingContext2d =
                canvas.get_context_with_context_options("2d", &options).unwrap().unwrap().unchecked_into();
            Metrics { context, ascents: HashMap::new(), colors: HashMap::new(), fonts: HashMap::new() }
        });
        f(metrics)
    })
}

/// The distance from the top of a text box to its baseline, which is the primary font's ascent.
fn ascent(font: &Rc<str>) -> f32 {
    with_metrics(|m| {
        if let Some(&a) = m.ascents.get(font) {
            return a;
        }
        m.context.set_font(font);
        let metrics = m.context.measure_text("Hg").unwrap();
        let a = metrics.font_bounding_box_ascent() as f32;
        m.ascents.insert(font.clone(), a);
        a
    })
}

/// Any CSS colour as straight sRGB. The browser parses it, whatever syntax it is in (`oklch()`,
/// `color(display-p3 ...)`, `color-mix()`), by painting one pixel with it and reading it back.
pub fn parse_color(css: &str) -> Rgba {
    with_metrics(|m| {
        if let Some(c) = m.colors.get(css) {
            return *c;
        }
        let ctx = &m.context;
        ctx.clear_rect(0.0, 0.0, 1.0, 1.0);
        ctx.set_fill_style_str("#0000");
        ctx.set_fill_style_str(css);
        ctx.fill_rect(0.0, 0.0, 1.0, 1.0);
        let color = match ctx.get_image_data(0.0, 0.0, 1.0, 1.0) {
            Ok(image) => {
                let data = image.data();
                let channel = |i: usize| data[i] as f32 / 255.0;
                [channel(0), channel(1), channel(2), channel(3)]
            }
            Err(_) => [1.0, 1.0, 1.0, 1.0],
        };
        m.colors.insert(css.to_string(), color);
        color
    })
}

struct ElementStyle {
    font: Rc<str>,
    letter_spacing: Rc<str>,
    font_px: f32,
    color: Rgba,
    active: Rgba,
    glow: Rgba,
    rtl: bool,
}

fn element_style(el: &Element) -> ElementStyle {
    let style = dom::computed(el);
    let get = |name: &str| style.get_property_value(name).unwrap_or_default();
    let font_size = get("font-size");
    let key = format!("{} {} {} {}", get("font-style"), get("font-weight"), font_size, get("font-family"));
    let font = with_metrics(|m| m.fonts.entry(key.clone()).or_insert_with(|| Rc::from(key.as_str())).clone());
    let spacing = get("letter-spacing");
    let letter_spacing: Rc<str> = Rc::from(if spacing == "normal" { "0px" } else { spacing.as_str() });
    ElementStyle {
        font,
        letter_spacing,
        font_px: dom::px(&font_size),
        color: parse_color(&get("color")),
        active: parse_color(&get("text-decoration-color")),
        glow: parse_color(&get("caret-color")),
        rtl: get("direction") == "rtl",
    }
}

fn range() -> Range {
    dom::document().create_range().expect("range")
}

fn content_rects(node: &Node, origin: (f32, f32)) -> Vec<Rect> {
    let r = range();
    let _ = r.select_node_contents(node);
    let Some(list) = r.get_client_rects() else { return Vec::new() };
    (0..list.length())
        .filter_map(|i| list.get(i))
        .map(|rect| Rect::relative(&rect, origin))
        .filter(|rect| rect.w > 0.01 && rect.h > 0.01)
        .collect()
}

fn content_rect(node: &Node, origin: (f32, f32)) -> Rect {
    let r = range();
    let _ = r.select_node_contents(node);
    Rect::relative(&r.get_bounding_client_rect(), origin)
}

/// The text of an element cut into visually contiguous pieces, each with its box. One piece when
/// the text sits in one box; otherwise grapheme by grapheme, regrouped by where they landed.
fn text_pieces(el: &Element, origin: (f32, f32)) -> Vec<(Rect, String)> {
    let rects = content_rects(el, origin);
    let full = el.text_content().unwrap_or_default();
    if rects.len() <= 1 {
        return rects.into_iter().map(|rect| (rect, full.clone())).collect();
    }
    let mut graphemes: Vec<(Rect, String)> = Vec::new();
    let walker = dom::document().create_tree_walker_with_what_to_show(el, 4).expect("walker");
    while let Ok(Some(node)) = walker.next_node() {
        let text = node.text_content().unwrap_or_default();
        for (start, end) in text::grapheme_ranges(&text) {
            let r = range();
            let _ = r.set_start(&node, text::utf16_offset(&text, start));
            let _ = r.set_end(&node, text::utf16_offset(&text, end));
            let rect = Rect::relative(&r.get_bounding_client_rect(), origin);
            if rect.w > 0.01 || !text[start..end].trim().is_empty() {
                graphemes.push((rect, text[start..end].to_string()));
            }
        }
    }
    let mut pieces: Vec<(Rect, String)> = Vec::new();
    for (rect, grapheme) in graphemes {
        if let Some((last, text)) = pieces.last_mut() {
            let same_row = (last.y - rect.y).abs() < 1.0;
            let touches = rect.x <= last.right() + 1.0 && rect.right() >= last.x - 1.0;
            if same_row && touches {
                *last = last.union(&rect);
                text.push_str(&grapheme);
                continue;
            }
        }
        pieces.push((rect, grapheme));
    }
    pieces.retain(|(rect, text)| rect.w > 0.01 && !text.trim().is_empty());
    pieces
}

pub struct Measured {
    pub lines: Vec<LineLayout>,
    pub credits: Option<LineLayout>,
    pub content_height: f32,
}

pub fn measure(dom_: &LayoutDom, song: &Song, theme: &Theme, root_px: f32) -> Measured {
    let container_rect = dom_.container.get_bounding_client_rect();
    let container_origin = (container_rect.left() as f32, container_rect.top() as f32);
    let container_style = element_style(&dom_.container);
    let lines = song
        .lines
        .iter()
        .zip(&dom_.lines)
        .map(|(line, line_dom)| measure_line(line, line_dom, container_origin, &container_style, song, theme, root_px))
        .collect();
    let credits = dom_.credits.as_ref().map(|p| measure_credits(p, container_origin));
    Measured { lines, credits, content_height: container_rect.height() as f32 }
}

fn line_box(el: &HtmlElement, container_origin: (f32, f32)) -> Rect {
    Rect::relative(&el.get_bounding_client_rect(), container_origin)
}

fn measure_line(
    line: &Line,
    dom_: &LineDom,
    container_origin: (f32, f32),
    container_style: &ElementStyle,
    song: &Song,
    theme: &Theme,
    root_px: f32,
) -> LineLayout {
    let bounds = line_box(&dom_.element, container_origin);
    let origin = (container_origin.0 + bounds.x, container_origin.1 + bounds.y);
    let line_style = element_style(&dom_.element);
    let align = line.align();
    let origin_x = match align {
        crate::song::Align::Left => 0.0,
        crate::song::Align::Right => bounds.w,
        crate::song::Align::Center => bounds.w / 2.0,
    };
    let mut layout = LineLayout {
        top: bounds.y,
        height: bounds.h,
        scroll_height: bounds.h,
        left: bounds.x,
        width: bounds.w,
        origin_x,
        slots: Vec::new(),
        parts: Vec::new(),
        groups: Vec::new(),
        inactive: line_style.color,
        active: line_style.active,
        static_color: container_style.color,
        pill_color: [1.0, 1.0, 1.0, 0.145],
        font_px: line_style.font_px,
        static_em: line_style.font_px,
    };

    if let Some(note) = &dom_.note {
        let rect = Rect::relative(&note.get_bounding_client_rect(), origin);
        // The 24-unit view box is fitted to the box's height and centred across its width.
        let side = rect.h;
        let square = Rect { x: rect.x + (rect.w - side) / 2.0, y: rect.y, w: side, h: side };
        layout.slots.push(Slot {
            ink: Ink::Note,
            owner: Owner::Note,
            rect: square,
            margin: side * 0.6,
            halo: true,
            glyphs: vec![Glyph { rect: square, letter: None, sweep: SweepMap::default() }],
            placement: Placement::default(),
            color: false,
        });
        return layout;
    }

    let glows = theme.animate_glow && song.sync != crate::model::SyncType::None;
    // Two standard deviations of the widest glow (its full radius). A blurred edge is down to about
    // 2% there, which at the glow's strength is below one level of 8-bit colour.
    let halo_margin = (theme.glow_radius_px * 2.0).ceil() + 2.0;
    let group_rects: Vec<Rect> = dom_.groups.iter().map(|g| content_rect(g, origin)).collect();

    for (index, part) in line.parts.iter().enumerate() {
        let word = &dom_.words[index];
        let style = element_style(word);
        let group = &line.groups[part.group];
        let row = &line.rows[part.row];
        let atomic = !row.bidi_sensitive && !group.long;
        let letters = &dom_.letters[index];
        let halo = glows && style.glow[3] >= 0.5 / 255.0;
        layout.parts.push(PartStyle {
            inactive: style.color,
            active: style.active,
            glow: style.glow,
            em: style.font_px,
            letters: letters.len().max(1) as u16,
            atomic,
        });

        // The pieces of the word as drawn: its letters, or its text cut where it wraps or reorders.
        let pieces: Vec<(Rect, String, Option<u16>)> = if part.lettered && !letters.is_empty() {
            letters
                .iter()
                .enumerate()
                .map(|(i, letter)| {
                    (content_rect(letter, origin), letter.text_content().unwrap_or_default(), Some(i as u16))
                })
                .collect()
        } else {
            text_pieces(word, origin).into_iter().map(|(rect, text)| (rect, text, None)).collect()
        };
        if pieces.is_empty() {
            continue;
        }

        // The sweep: across the whole word when it is its own box, letter by letter when its
        // letters flow, otherwise piece by piece in proportion to their widths.
        let whole = pieces.iter().skip(1).fold(pieces[0].0, |acc, (rect, _, _)| acc.union(rect));
        let total_width: f32 = pieces.iter().map(|(rect, _, _)| rect.w).sum::<f32>().max(1e-3);
        let count = pieces.len() as f32;
        let mut before = 0.0;
        let maps: Vec<SweepMap> = pieces
            .iter()
            .enumerate()
            .map(|(i, (rect, _, letter))| {
                let map = if atomic {
                    SweepMap { x0: whole.x, x1: whole.right(), a: 0.0, w: 1.0, rtl: part.rtl }
                } else if letter.is_some() {
                    SweepMap { x0: rect.x, x1: rect.right(), a: i as f32 / count, w: 1.0 / count, rtl: part.rtl }
                } else {
                    SweepMap {
                        x0: rect.x,
                        x1: rect.right(),
                        a: before / total_width,
                        w: rect.w / total_width,
                        rtl: part.rtl,
                    }
                };
                before += rect.w;
                map
            })
            .collect();

        // Words in a joining script keep their whole group shaped together, clipped to this word.
        let joined = text::has_joining_script(&part.text) && group.parts.len() > 1;
        let group_rect = group_rects[part.group];
        let group_text: String = group.parts.iter().map(|&p| line.parts[p].text.as_str()).collect();
        let base_ascent = ascent(&style.font);
        let run_for = |rect: &Rect, text: &str| -> TextRun {
            let one_row = (group_rect.h - rect.h).abs() < rect.h * 0.5;
            if joined && one_row {
                TextRun {
                    text: group_text.clone(),
                    font: style.font.clone(),
                    letter_spacing: style.letter_spacing.clone(),
                    lang: Rc::from(line.lang.as_str()),
                    rtl: style.rtl || part.rtl,
                    x: group_rect.x,
                    baseline: rect.y + base_ascent,
                    clip: Some(*rect),
                }
            } else {
                TextRun {
                    text: text.to_string(),
                    font: style.font.clone(),
                    letter_spacing: style.letter_spacing.clone(),
                    lang: Rc::from(line.lang.as_str()),
                    rtl: style.rtl || part.rtl,
                    x: rect.x,
                    baseline: rect.y + base_ascent,
                    clip: None,
                }
            }
        };

        // One slot per row the word occupies, so each piece can be lifted, scaled and glow alone.
        let overhang = style.font_px * 0.3;
        let mut row_start = 0;
        while row_start < pieces.len() {
            let mut row_end = row_start + 1;
            while row_end < pieces.len() && (pieces[row_end].0.y - pieces[row_start].0.y).abs() < 1.0 {
                row_end += 1;
            }
            let row_pieces = &pieces[row_start..row_end];
            let rect = row_pieces.iter().skip(1).fold(row_pieces[0].0, |acc, (r, _, _)| acc.union(r));
            let left_most = row_pieces.iter().map(|(r, _, _)| r.x).fold(f32::INFINITY, f32::min);
            let right_most = row_pieces.iter().map(|(r, _, _)| r.right()).fold(f32::NEG_INFINITY, f32::max);
            let glyphs = row_pieces
                .iter()
                .zip(&maps[row_start..row_end])
                .map(|((r, _, letter), map)| {
                    // Room above and below for tall glyphs, and at the outer ends for overhangs.
                    let mut g = r.expand(0.0, overhang);
                    if (r.x - left_most).abs() < 0.5 {
                        g.x -= overhang * 0.5;
                        g.w += overhang * 0.5;
                    }
                    if (r.right() - right_most).abs() < 0.5 {
                        g.w += overhang * 0.5;
                    }
                    Glyph { rect: g, letter: *letter, sweep: *map }
                })
                .collect();
            let runs: Vec<TextRun> = row_pieces.iter().map(|(r, text, _)| run_for(r, text)).collect();
            let color = runs.iter().any(|run| text::has_color_glyphs(&run.text));
            layout.slots.push(Slot {
                ink: Ink::Text(runs),
                owner: Owner::Part(index),
                rect,
                margin: if halo && !color { halo_margin.max(overhang) } else { overhang },
                halo: halo && !color,
                glyphs,
                placement: Placement::default(),
                color,
            });
            row_start = row_end;
        }
    }
    layout.groups = group_rects;
    // The DOM renderer built a sweep cell for a word that is its own box, and one per letter of a
    // lettered word; only those existed when it measured. A flowing word got its cells once its line
    // started, too late to count.
    let words_bottom = dom_
        .words
        .iter()
        .zip(&layout.parts)
        .zip(&line.parts)
        .filter(|((_, style), part)| style.atomic || part.lettered)
        .map(|((w, _), _)| Rect::relative(&w.get_bounding_client_rect(), origin).bottom())
        .fold(f32::NEG_INFINITY, f32::max);
    if words_bottom.is_finite() {
        layout.scroll_height = layout.height.max(words_bottom + 2.0 * root_px);
    }

    if let Some(pill) = &dom_.romanization {
        let rect = Rect::relative(&pill.get_bounding_client_rect(), origin);
        layout.pill_color = parse_color("rgb(255 255 255 / 0.145)");
        layout.slots.push(Slot {
            ink: Ink::Pill { radius: dom::px(&dom::computed_value(pill, "border-top-left-radius")) },
            owner: Owner::Pill,
            rect,
            margin: 1.0,
            halo: false,
            glyphs: vec![Glyph { rect, letter: None, sweep: SweepMap::default() }],
            placement: Placement::default(),
            color: false,
        });
        if let Some(text_el) = &dom_.romanization_text {
            push_static_text(&mut layout, text_el, origin, Owner::Romanization);
        }
    }
    if let Some(translation) = &dom_.translation {
        push_static_text(&mut layout, translation, origin, Owner::Translation);
    }
    layout
}

/// Untimed text (translations, plain romanizations, credits): one slot per visual piece.
fn push_static_text(layout: &mut LineLayout, el: &HtmlElement, origin: (f32, f32), owner: Owner) {
    let style = element_style(el);
    layout.static_color = style.color;
    layout.static_em = style.font_px;
    let base_ascent = ascent(&style.font);
    let overhang = style.font_px * 0.3;
    for (rect, text) in text_pieces(el, origin) {
        let run = TextRun {
            text,
            font: style.font.clone(),
            letter_spacing: style.letter_spacing.clone(),
            lang: Rc::from(
                el.closest("[lang]").ok().flatten().and_then(|e| e.get_attribute("lang")).unwrap_or_default().as_str(),
            ),
            rtl: style.rtl,
            x: rect.x,
            baseline: rect.y + base_ascent,
            clip: None,
        };
        let glyph_rect = rect.expand(overhang * 0.5, overhang);
        let color = text::has_color_glyphs(&run.text);
        layout.slots.push(Slot {
            ink: Ink::Text(vec![run]),
            owner,
            rect,
            margin: overhang,
            halo: false,
            glyphs: vec![Glyph { rect: glyph_rect, letter: None, sweep: SweepMap::default() }],
            placement: Placement::default(),
            color,
        });
    }
}

fn measure_credits(p: &HtmlElement, container_origin: (f32, f32)) -> LineLayout {
    let bounds = line_box(p, container_origin);
    let origin = (container_origin.0 + bounds.x, container_origin.1 + bounds.y);
    let style = element_style(p);
    let mut layout = LineLayout {
        top: bounds.y,
        height: bounds.h,
        scroll_height: bounds.h,
        left: bounds.x,
        width: bounds.w,
        origin_x: 0.0,
        slots: Vec::new(),
        parts: Vec::new(),
        groups: Vec::new(),
        inactive: style.color,
        active: style.color,
        static_color: style.color,
        pill_color: [0.0; 4],
        font_px: style.font_px,
        static_em: style.font_px,
    };
    if let Some(text) = p.first_element_child() {
        push_static_text(&mut layout, text.unchecked_ref(), origin, Owner::Credits);
    }
    layout
}
