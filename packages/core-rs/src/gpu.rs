//! The WebGL2 side: two shader programs, the line pages that rasterized lines live in, and an atlas
//! that blurs are drawn and blurred in.
//!
//! A frame is at most four draws, however many lines it shows: the blur jobs into the atlas, the two
//! blur passes, and the canvas. Each instance is an axis-aligned quad cut out of a texture: a line
//! in the line pages, whose red channel holds the text's coverage, or a region of the blur atlas.
//! What a quad shows is decided per fragment from four numbers: the colour where it is unlit, the
//! colour where it is lit, a linear ramp across the texture that says how lit each column is, and
//! which kind of texel it reads.
//!
//! The line pages are one array texture. Each line is packed onto a shelf of a layer, with a margin
//! around it so that the mip levels the blur jobs read do not bleed in from its neighbours. Quads are
//! painted in the line's own texel coordinates and moved onto its place by `LineTexture::place`.
//!
//! Glows, the instrumental note's glow and blurred lines are real Gaussian blurs, made each frame:
//!
//! 1. What is to be blurred (a glowing word's lit letters in the glow colour, the note's filled part,
//!    a whole line) is drawn with the ordinary quads into a region of the atlas, scaled down so its
//!    standard deviation spans 1.5 to 3 texels. The quads read the line pages' mip level for that
//!    scale, so the shrinking averages properly.
//! 2. Every region is blurred across, then down, by the blur program (`src/shaders/blur.wgsl`), one
//!    instanced draw per direction for all of them.
//! 3. Each region is drawn onto the canvas as one quad, scaled back up with bilinear filtering.
//!
//! Sampled that finely the blur has nothing to ripple, and at that scale it costs a few texel reads
//! per covered pixel.
//!
//! The atlas's quads and the canvas's each have an instance buffer of their own, with the vertex
//! attributes pointed at it once, so a frame sets no vertex state: it uploads the quads and draws.
//! Texture unit 0 holds the line pages and unit 1 the blur atlas.
//!
//! The shaders are written in WGSL (`src/shaders/`). build.rs validates them with naga and translates
//! them to GLSL ES 3.00 at build time, so a shader error fails the build. Their only uniform is a
//! small buffer holding the size of what is drawn into, one for the canvas and one for the atlas,
//! written when that size changes.

use wasm_bindgen::JsCast;
use web_sys::{
    HtmlCanvasElement, WebGl2RenderingContext as Gl, WebGlBuffer, WebGlFramebuffer, WebGlProgram, WebGlShader,
    WebGlTexture, WebGlVertexArrayObject,
};

/// One instanced quad. The layout is mirrored by the attribute pointers in `instance_stream`.
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct Quad {
    /// x, y, width, height in canvas CSS pixels (in atlas texels while drawn into the atlas).
    pub rect: [f32; 4],
    /// u0, v0, u1, v1 in texels of the texture.
    pub uv: [f32; 4],
    /// Premultiplied colour where the ramp is 0.
    pub unlit: [f32; 4],
    /// Premultiplied colour where the ramp is 1.
    pub lit: [f32; 4],
    /// How lit each texel is: `clamp(u * ramp[0] + v * ramp[1] + ramp[2] + ramp[3] * sin(u * wave[0] + wave[1]), 0, 1)`
    /// for texel (u, v). Text only uses the first and third terms; the instrumental note's rising
    /// wave uses the rest.
    pub ramp: [f32; 4],
    /// `wave[0..2]` as above. `wave[2]` says what the texel is: `TEXT` or `COLOR` while painted,
    /// then a code for the page layer and kind (see `LineTexture::place`), or `BLURRED`. `wave[3]` is
    /// the mip level read: 0 on the canvas.
    pub wave: [f32; 4],
}

impl Quad {
    /// Coverage, tinted by the quad's colours.
    pub const TEXT: f32 = -1.0;
    /// Texels in their own colours (emoji), scaled by the colours' alpha.
    pub const COLOR: f32 = -2.0;
    /// Reads the blur atlas, in its own colours.
    pub const BLURRED: f32 = 3.0;
}

const FLOATS_PER_QUAD: usize = std::mem::size_of::<Quad>() / 4;

/// One region of the atlas to blur in one direction.
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct BlurRegion {
    /// x, y, width, height in atlas texels, rows counted from the bottom as the framebuffer has them.
    pub rect: [f32; 4],
    /// Standard deviation in texels, then the direction (filled in per pass), then padding.
    pub params: [f32; 4],
}

const FLOATS_PER_REGION: usize = std::mem::size_of::<BlurRegion>() / 4;

/// The shaders, `src/shaders/*.wgsl`, as build.rs checked and translated them to GLSL ES 3.00, with the
/// names naga gave their uniform blocks and textures.
mod quad_shader {
    include!(concat!(env!("OUT_DIR"), "/quad_names.rs"));
    pub const VERTEX: &str = include_str!(concat!(env!("OUT_DIR"), "/quad.vert.glsl"));
    pub const FRAGMENT: &str = include_str!(concat!(env!("OUT_DIR"), "/quad.frag.glsl"));
}

mod blur_shader {
    include!(concat!(env!("OUT_DIR"), "/blur_names.rs"));
    pub const VERTEX: &str = include_str!(concat!(env!("OUT_DIR"), "/blur.vert.glsl"));
    pub const FRAGMENT: &str = include_str!(concat!(env!("OUT_DIR"), "/blur.frag.glsl"));
}

/// `Globals` in the shaders: the target's size, padded to std140's 16 bytes.
const GLOBALS_FLOATS: usize = 4;

/// The texture units: the line pages, and the blur atlas.
const PAGES_UNIT: u32 = 0;
const BLUR_UNIT: u32 = 1;

/// Lines are placed on multiples of this many texels and keep at least this much empty margin to
/// their neighbours, so a mip level up to `PAGE_LEVELS - 1` (16 texels a texel) reads only the
/// line's own texels.
const PAGE_ALIGN: u32 = 16;
/// Mip levels kept for the line pages: a blur job reads level log2 of how much it shrinks the line,
/// and coarser than 16 times it reads level 4, which the blur hides.
const PAGE_LEVELS: i32 = 5;
/// The most layers the pages grow to. Past that a line that does not fit is not drawn until others
/// scroll far enough away to be released.
const MAX_LAYERS: u32 = 16;
const MIN_PAGE_SIDE: u32 = 1024;

fn align(value: u32) -> u32 {
    value.div_ceil(PAGE_ALIGN) * PAGE_ALIGN
}

/// Where a rasterized line sits in the line pages.
pub struct LineTexture {
    layer: u32,
    x: u32,
    y: u32,
    /// The space it holds, margin included.
    held: (u32, u32),
    /// The pages it was placed in; a reset makes new ones.
    generation: u32,
    pub width: u32,
    pub height: u32,
}

impl LineTexture {
    /// Moves quads painted in the line's own texel coordinates onto its place in the pages, and
    /// marks which layer and kind of texel they read.
    pub fn place(&self, quads: &mut [Quad]) {
        let (x, y) = (self.x as f32, self.y as f32);
        let layer = self.layer as f32;
        for q in quads {
            q.uv[0] += x;
            q.uv[2] += x;
            q.uv[1] += y;
            q.uv[3] += y;
            // The ramp and the wave are in the line's texels; they move with it.
            q.ramp[2] -= x * q.ramp[0] + y * q.ramp[1];
            q.wave[1] -= x * q.wave[0];
            let kind = if q.wave[2] == Quad::COLOR { 2.0 } else { 1.0 };
            q.wave[2] = layer * 4.0 + kind;
        }
    }
}

/// A row of a layer, holding lines of about its height, with the spans still free on it.
struct Shelf {
    y: u32,
    height: u32,
    /// (x, width), in order and never touching.
    free: Vec<(u32, u32)>,
}

struct Layer {
    shelves: Vec<Shelf>,
    /// Where the next shelf would start.
    top: u32,
}

/// Where lines go in the pages' layers: shelves of rows, lines side by side on them. Only
/// bookkeeping; `Pages` holds the texture.
struct Shelves {
    width: u32,
    height: u32,
    layers: Vec<Layer>,
}

impl Shelves {
    fn new(width: u32, height: u32, layers: u32) -> Shelves {
        let mut shelves = Shelves { width, height, layers: Vec::new() };
        shelves.add_layers(layers);
        shelves
    }

    fn add_layers(&mut self, count: u32) {
        self.layers.extend((0..count).map(|_| Layer { shelves: Vec::new(), top: 0 }));
    }

    /// Finds space `w` x `h`, margin included, on the first shelf that suits it or a new one:
    /// (layer, x, y).
    fn allocate(&mut self, w: u32, h: u32) -> Option<(u32, u32, u32)> {
        for (index, layer) in self.layers.iter_mut().enumerate() {
            // A shelf much taller than the line would waste most of what it takes.
            for shelf in layer.shelves.iter_mut().filter(|s| s.height >= h && s.height <= h + h / 2) {
                if let Some(span) = shelf.free.iter_mut().find(|(_, width)| *width >= w) {
                    let x = span.0;
                    span.0 += w;
                    span.1 -= w;
                    shelf.free.retain(|(_, width)| *width > 0);
                    return Some((index as u32, x, shelf.y));
                }
            }
        }
        for (index, layer) in self.layers.iter_mut().enumerate() {
            if layer.top + h <= self.height {
                let y = layer.top;
                layer.top += h;
                let free = if w < self.width { vec![(w, self.width - w)] } else { Vec::new() };
                layer.shelves.push(Shelf { y, height: h, free });
                return Some((index as u32, 0, y));
            }
        }
        None
    }

    /// Gives back the space at `(layer, x, y)`, `w` wide.
    fn free(&mut self, layer: u32, x: u32, y: u32, w: u32) {
        let width = self.width;
        let Some(layer) = self.layers.get_mut(layer as usize) else { return };
        let Some(shelf) = layer.shelves.iter_mut().find(|s| s.y == y) else { return };
        let at = shelf.free.partition_point(|(start, _)| *start < x);
        shelf.free.insert(at, (x, w));
        // Merge with the spans either side.
        if at + 1 < shelf.free.len() && shelf.free[at].0 + shelf.free[at].1 == shelf.free[at + 1].0 {
            shelf.free[at].1 += shelf.free[at + 1].1;
            shelf.free.remove(at + 1);
        }
        if at > 0 && shelf.free[at - 1].0 + shelf.free[at - 1].1 == shelf.free[at].0 {
            shelf.free[at - 1].1 += shelf.free[at].1;
            shelf.free.remove(at);
        }
        // Empty shelves at the top of the layer give their rows back.
        while layer.shelves.last().is_some_and(|s| s.free == [(0, width)]) {
            let shelf = layer.shelves.pop().unwrap();
            layer.top = shelf.y;
        }
    }
}

/// The line pages: one array texture, and where the lines are in it.
struct Pages {
    texture: WebGlTexture,
    shelves: Shelves,
    /// Holds a layer as a render target, to clear a line's space or copy a layer.
    framebuffer: WebGlFramebuffer,
    generation: u32,
}

/// Two textures the size of the atlas, blurred from one into the other and back.
struct Atlas {
    textures: [WebGlTexture; 2],
    framebuffers: [WebGlFramebuffer; 2],
    width: u32,
    height: u32,
}

/// The largest the atlas grows to, on each side. Regions that do not fit are drawn unblurred.
pub const MAX_ATLAS: u32 = 2048;

/// A uniform buffer holding one target's `Globals`, and the size it was last written with.
struct Globals {
    buffer: WebGlBuffer,
    size: (f32, f32),
}

/// A `Float32Array` over all of wasm memory, so an upload passes an offset into it rather than
/// making a view object, which the page would later have to collect. Made again when the memory
/// grows, which detaches the buffer under the old one.
#[derive(Default)]
struct MemoryView {
    view: Option<js_sys::Float32Array>,
    pages: usize,
}

impl MemoryView {
    fn get(&mut self) -> &js_sys::Float32Array {
        let pages = memory_pages();
        if self.view.is_none() || pages != self.pages {
            let memory: js_sys::WebAssembly::Memory = wasm_bindgen::memory().unchecked_into();
            self.view = Some(js_sys::Float32Array::new(&memory.buffer()));
            self.pages = pages;
        }
        self.view.as_ref().unwrap()
    }
}

/// The size of wasm memory in pages: a wasm instruction, no call out to JavaScript.
fn memory_pages() -> usize {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::memory_size(0)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

/// Writes `data` to the start of the buffer bound to `target`, straight out of wasm memory.
fn upload_f32(gl: &Gl, memory: &mut MemoryView, target: u32, data: &[f32]) {
    let offset = data.as_ptr() as usize / 4;
    gl.buffer_sub_data_with_i32_and_array_buffer_view_and_src_offset_and_length(
        target,
        0,
        memory.get(),
        offset as u32,
        data.len() as u32,
    );
}

/// An instance buffer with a vertex array pointing the quad attributes at it, once.
struct InstanceStream {
    vao: WebGlVertexArrayObject,
    buffer: WebGlBuffer,
    capacity: usize,
}

pub struct Gpu {
    pub gl: Gl,
    program: WebGlProgram,
    jobs: InstanceStream,
    canvas: InstanceStream,
    blur_program: WebGlProgram,
    blur_vao: WebGlVertexArrayObject,
    blur_instances: WebGlBuffer,
    blur_capacity: usize,
    canvas_globals: Globals,
    atlas_globals: Globals,
    /// The canvas's size in device pixels, for the viewport.
    canvas_px: (i32, i32),
    pages: Option<Pages>,
    /// The size a line needed that the pages could not hold: the renderer resets them before the
    /// next frame, at least this large.
    pages_wanted: Option<(u32, u32)>,
    pages_generation: u32,
    atlas: Option<Atlas>,
    /// Bound to the blur unit while there is no atlas, so the unit is never empty.
    empty: WebGlTexture,
    /// Whether the atlas can be half floats, so faint glows do not band.
    half_float: bool,
    max_texture_size: u32,
    memory: MemoryView,
    timer: Option<Timer>,
}

/// GPU time per frame, from `EXT_disjoint_timer_query_webgl2`, when profiling is on. Results arrive
/// a few frames late, so queries are kept in flight and read as they land.
struct Timer {
    pending: std::collections::VecDeque<web_sys::WebGlQuery>,
    active: Option<web_sys::WebGlQuery>,
    /// Exponential average of GPU milliseconds per frame.
    pub average_ms: f64,
    /// Each frame's GPU milliseconds, until taken.
    samples: Vec<f32>,
}

const TIME_ELAPSED_EXT: u32 = 0x88BF;
const GPU_DISJOINT_EXT: u32 = 0x8FBB;
const RGBA16F: i32 = 0x881A;
const HALF_FLOAT: u32 = 0x140B;

impl Gpu {
    pub fn new(canvas: &HtmlCanvasElement) -> Result<Gpu, String> {
        let options = js_sys::Object::new();
        for (key, value) in [
            ("alpha", true),
            ("premultipliedAlpha", true),
            ("antialias", false),
            ("depth", false),
            ("stencil", false),
            ("preserveDrawingBuffer", false),
            ("desynchronized", false),
        ] {
            let _ = js_sys::Reflect::set(&options, &key.into(), &value.into());
        }
        let _ = js_sys::Reflect::set(&options, &"powerPreference".into(), &"low-power".into());
        let gl: Gl = canvas
            .get_context_with_context_options("webgl2", &options)
            .map_err(|_| "webgl2 context failed".to_string())?
            .ok_or("webgl2 is not available")?
            // Not `dyn_into`: a canvas in another window hands back that realm's context.
            .unchecked_into();

        let program = link(&gl, quad_shader::VERTEX, quad_shader::FRAGMENT)?;
        bind_resources(
            &gl,
            &program,
            &[(quad_shader::LINE_PAGES_SAMPLERS, PAGES_UNIT), (quad_shader::BLUR_ATLAS_SAMPLERS, BLUR_UNIT)],
            quad_shader::GLOBALS_BLOCKS,
            quad_shader::GLOBALS_BINDING,
        );
        let blur_program = link(&gl, blur_shader::VERTEX, blur_shader::FRAGMENT)?;
        bind_resources(
            &gl,
            &blur_program,
            &[(blur_shader::SOURCE_SAMPLERS, BLUR_UNIT)],
            blur_shader::GLOBALS_BLOCKS,
            blur_shader::GLOBALS_BINDING,
        );
        let canvas_globals = Globals { buffer: uniform_buffer(&gl)?, size: (0.0, 0.0) };
        let atlas_globals = Globals { buffer: uniform_buffer(&gl)?, size: (0.0, 0.0) };

        let corners = gl.create_buffer().ok_or("no buffer")?;
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&corners));
        let corner_data: [f32; 8] = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0];
        // SAFETY: the view is consumed by buffer_data before any allocation can move wasm memory.
        unsafe {
            let view = js_sys::Float32Array::view(&corner_data);
            gl.buffer_data_with_array_buffer_view(Gl::ARRAY_BUFFER, &view, Gl::STATIC_DRAW);
        }
        // Every vertex array reads the shared corner at location 0 and its instances after it.
        let vertex_array = |instances: &WebGlBuffer| -> Result<WebGlVertexArrayObject, String> {
            let vao = gl.create_vertex_array().ok_or("no vao")?;
            gl.bind_vertex_array(Some(&vao));
            gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&corners));
            gl.enable_vertex_attrib_array(0);
            gl.vertex_attrib_pointer_with_i32(0, 2, Gl::FLOAT, false, 0, 0);
            gl.bind_buffer(Gl::ARRAY_BUFFER, Some(instances));
            Ok(vao)
        };
        let instance_attributes = |stride: usize, layout: &[(u32, i32)]| {
            for &(location, offset) in layout {
                gl.enable_vertex_attrib_array(location);
                gl.vertex_attrib_pointer_with_i32(location, 4, Gl::FLOAT, false, (stride * 4) as i32, offset * 4);
                gl.vertex_attrib_divisor(location, 1);
            }
        };
        let quad_layout: [(u32, i32); 6] = [(1, 0), (2, 4), (3, 8), (4, 12), (5, 16), (6, 20)];
        let instance_stream = || -> Result<InstanceStream, String> {
            let buffer = gl.create_buffer().ok_or("no buffer")?;
            let vao = vertex_array(&buffer)?;
            instance_attributes(FLOATS_PER_QUAD, &quad_layout);
            Ok(InstanceStream { vao, buffer, capacity: 0 })
        };
        let jobs = instance_stream()?;
        let canvas_stream = instance_stream()?;
        let blur_instances = gl.create_buffer().ok_or("no buffer")?;
        let blur_vao = vertex_array(&blur_instances)?;
        instance_attributes(FLOATS_PER_REGION, &[(1, 0), (2, 4)]);
        gl.bind_vertex_array(None);

        gl.disable(Gl::DEPTH_TEST);
        gl.enable(Gl::BLEND);
        gl.blend_func(Gl::ONE, Gl::ONE_MINUS_SRC_ALPHA);
        gl.pixel_storei(Gl::UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
        let half_float = gl.get_extension("EXT_color_buffer_float").ok().flatten().is_some();
        let max_texture_size =
            gl.get_parameter(Gl::MAX_TEXTURE_SIZE).ok().and_then(|v| v.as_f64()).unwrap_or(4096.0) as u32;

        let empty = gl.create_texture().ok_or("no texture")?;
        gl.active_texture(Gl::TEXTURE0 + BLUR_UNIT);
        gl.bind_texture(Gl::TEXTURE_2D, Some(&empty));
        gl.tex_image_2d_with_i32_and_i32_and_i32_and_format_and_type_and_opt_u8_array(
            Gl::TEXTURE_2D,
            0,
            Gl::RGBA as i32,
            1,
            1,
            0,
            Gl::RGBA,
            Gl::UNSIGNED_BYTE,
            Some(&[0, 0, 0, 0]),
        )
        .map_err(|_| "no texture")?;

        Ok(Gpu {
            gl,
            program,
            jobs,
            canvas: canvas_stream,
            blur_program,
            blur_vao,
            blur_instances,
            blur_capacity: 0,
            canvas_globals,
            atlas_globals,
            canvas_px: (1, 1),
            pages: None,
            pages_wanted: None,
            pages_generation: 0,
            atlas: None,
            empty,
            half_float,
            max_texture_size,
            memory: MemoryView::default(),
            timer: None,
        })
    }

    pub fn resize(&mut self, canvas: &HtmlCanvasElement, css_width: f32, css_height: f32, dpr: f32) {
        let width = (css_width * dpr).round().max(1.0) as u32;
        let height = (css_height * dpr).round().max(1.0) as u32;
        if canvas.width() != width {
            canvas.set_width(width);
        }
        if canvas.height() != height {
            canvas.set_height(height);
        }
        self.canvas_px = (width as i32, height as i32);
        write_globals(&self.gl, &mut self.canvas_globals, (css_width.max(1.0), css_height.max(1.0)));
    }

    /// Copies a rasterized line into the pages. None when it does not fit: too large for the pages,
    /// which `needs_page_reset` then reports, or no room left in them.
    pub fn upload_line(&mut self, source: &HtmlCanvasElement) -> Option<LineTexture> {
        let (width, height) = (source.width(), source.height());
        let held = (align(width + PAGE_ALIGN), align(height + PAGE_ALIGN));
        if self.pages.is_none() {
            // Wide enough for any line of this canvas, and a few lines tall.
            let wanted = self.pages_wanted.take().unwrap_or((0, 0));
            let side = |at_least: u32| align(at_least.max(MIN_PAGE_SIDE)).min(self.max_texture_size);
            let page_width = side(held.0.max(wanted.0).max(self.canvas_px.0 as u32 * 5 / 4));
            let page_height = side(held.1.max(wanted.1));
            self.pages = Some(self.create_pages(page_width, page_height)?);
        }
        let shelves = &self.pages.as_ref().unwrap().shelves;
        if held.0 > shelves.width || held.1 > shelves.height {
            if held.0 <= self.max_texture_size && held.1 <= self.max_texture_size {
                self.pages_wanted = Some((held.0.max(shelves.width), held.1.max(shelves.height)));
            }
            return None;
        }
        let place = match self.pages.as_mut().unwrap().shelves.allocate(held.0, held.1) {
            Some(place) => place,
            None => {
                self.grow_pages()?;
                self.pages.as_mut().unwrap().shelves.allocate(held.0, held.1)?
            }
        };
        let (layer, x, y) = place;
        let gl = &self.gl;
        let pages = self.pages.as_ref().unwrap();
        // The space may hold a line released earlier; its margin must be empty.
        gl.bind_framebuffer(Gl::FRAMEBUFFER, Some(&pages.framebuffer));
        gl.framebuffer_texture_layer(Gl::FRAMEBUFFER, Gl::COLOR_ATTACHMENT0, Some(&pages.texture), 0, layer as i32);
        gl.enable(Gl::SCISSOR_TEST);
        gl.scissor(x as i32, y as i32, held.0 as i32, held.1 as i32);
        gl.clear_color(0.0, 0.0, 0.0, 0.0);
        gl.clear(Gl::COLOR_BUFFER_BIT);
        gl.disable(Gl::SCISSOR_TEST);
        gl.bind_framebuffer(Gl::FRAMEBUFFER, None);
        gl.active_texture(Gl::TEXTURE0 + PAGES_UNIT);
        gl.bind_texture(Gl::TEXTURE_2D_ARRAY, Some(&pages.texture));
        gl.tex_sub_image_3d_with_html_canvas_element(
            Gl::TEXTURE_2D_ARRAY,
            0,
            x as i32,
            y as i32,
            layer as i32,
            width as i32,
            height as i32,
            1,
            Gl::RGBA,
            Gl::UNSIGNED_BYTE,
            source,
        )
        .ok()?;
        // Read when the line is drawn into the blur atlas at a fraction of its size.
        gl.generate_mipmap(Gl::TEXTURE_2D_ARRAY);
        Some(LineTexture { layer, x, y, held, generation: pages.generation, width, height })
    }

    pub fn release(&mut self, texture: LineTexture) {
        if let Some(pages) = self.pages.as_mut().filter(|p| p.generation == texture.generation) {
            pages.shelves.free(texture.layer, texture.x, texture.y, texture.held.0);
        }
    }

    /// Whether a line was too large for the pages. The renderer then releases every line and calls
    /// `reset_pages`, and the lines are drawn again into larger ones.
    pub fn needs_page_reset(&self) -> bool {
        self.pages_wanted.is_some()
    }

    pub fn reset_pages(&mut self) {
        if let Some(pages) = self.pages.take() {
            self.gl.delete_texture(Some(&pages.texture));
            self.gl.delete_framebuffer(Some(&pages.framebuffer));
        }
    }

    /// The bytes the line pages take, mip levels included.
    pub fn page_bytes(&self) -> usize {
        self.pages
            .as_ref()
            .map(|p| (p.shelves.width * p.shelves.height) as usize * 4 * p.shelves.layers.len() * 4 / 3)
            .unwrap_or(0)
    }

    /// An array texture for the pages, `layers` deep, with its mip levels, bound to the pages unit.
    fn page_texture(&self, width: u32, height: u32, layers: u32) -> Option<WebGlTexture> {
        let gl = &self.gl;
        let texture = gl.create_texture()?;
        gl.active_texture(Gl::TEXTURE0 + PAGES_UNIT);
        gl.bind_texture(Gl::TEXTURE_2D_ARRAY, Some(&texture));
        gl.tex_storage_3d(Gl::TEXTURE_2D_ARRAY, PAGE_LEVELS, Gl::RGBA8, width as i32, height as i32, layers as i32);
        gl.tex_parameteri(Gl::TEXTURE_2D_ARRAY, Gl::TEXTURE_MIN_FILTER, Gl::LINEAR_MIPMAP_LINEAR as i32);
        gl.tex_parameteri(Gl::TEXTURE_2D_ARRAY, Gl::TEXTURE_MAG_FILTER, Gl::LINEAR as i32);
        gl.tex_parameteri(Gl::TEXTURE_2D_ARRAY, Gl::TEXTURE_WRAP_S, Gl::CLAMP_TO_EDGE as i32);
        gl.tex_parameteri(Gl::TEXTURE_2D_ARRAY, Gl::TEXTURE_WRAP_T, Gl::CLAMP_TO_EDGE as i32);
        Some(texture)
    }

    fn create_pages(&mut self, width: u32, height: u32) -> Option<Pages> {
        let texture = self.page_texture(width, height, 1)?;
        let framebuffer = self.gl.create_framebuffer()?;
        self.pages_generation += 1;
        Some(Pages { texture, shelves: Shelves::new(width, height, 1), framebuffer, generation: self.pages_generation })
    }

    /// Doubles the pages' layers, keeping every line where it is.
    fn grow_pages(&mut self) -> Option<()> {
        let pages = self.pages.as_ref()?;
        let (width, height, count) = (pages.shelves.width, pages.shelves.height, pages.shelves.layers.len() as u32);
        if count >= MAX_LAYERS {
            return None;
        }
        let grown = self.page_texture(width, height, (count * 2).min(MAX_LAYERS))?;
        let gl = &self.gl;
        let pages = self.pages.as_mut().unwrap();
        // Layer by layer, read from the old texture into the new one, which `page_texture` left
        // bound. The mip levels follow with the next upload's `generate_mipmap`.
        gl.bind_framebuffer(Gl::READ_FRAMEBUFFER, Some(&pages.framebuffer));
        for layer in 0..count as i32 {
            gl.framebuffer_texture_layer(Gl::READ_FRAMEBUFFER, Gl::COLOR_ATTACHMENT0, Some(&pages.texture), 0, layer);
            gl.copy_tex_sub_image_3d(Gl::TEXTURE_2D_ARRAY, 0, 0, 0, layer, 0, 0, width as i32, height as i32);
        }
        gl.bind_framebuffer(Gl::READ_FRAMEBUFFER, None);
        gl.delete_texture(Some(&pages.texture));
        pages.texture = grown;
        pages.shelves.add_layers((count * 2).min(MAX_LAYERS) - count);
        Some(())
    }

    /// Turns GPU timing on or off. Returns whether the browser can time the GPU at all.
    pub fn set_profiling(&mut self, on: bool) -> bool {
        if !on {
            self.timer = None;
            return true;
        }
        let supported = self.gl.get_extension("EXT_disjoint_timer_query_webgl2").ok().flatten().is_some();
        if supported && self.timer.is_none() {
            self.timer =
                Some(Timer { pending: Default::default(), active: None, average_ms: 0.0, samples: Vec::new() });
        }
        supported
    }

    /// The GPU milliseconds of each frame timed since the last call.
    pub fn take_gpu_samples(&mut self) -> Vec<f32> {
        self.timer.as_mut().map(|t| std::mem::take(&mut t.samples)).unwrap_or_default()
    }

    /// Average GPU milliseconds per frame, while profiling.
    pub fn gpu_ms(&self) -> Option<f64> {
        self.timer.as_ref().map(|t| t.average_ms)
    }

    fn poll_timer(&mut self) {
        let gl = &self.gl;
        let Some(timer) = self.timer.as_mut() else { return };
        let disjoint = gl.get_parameter(GPU_DISJOINT_EXT).ok().and_then(|v| v.as_bool()).unwrap_or(false);
        while let Some(query) = timer.pending.front() {
            let ready = gl.get_query_parameter(query, Gl::QUERY_RESULT_AVAILABLE).as_bool().unwrap_or(false);
            if !ready {
                break;
            }
            let query = timer.pending.pop_front().unwrap();
            if !disjoint {
                let ns = gl.get_query_parameter(&query, Gl::QUERY_RESULT).as_f64().unwrap_or(0.0);
                timer.average_ms = timer.average_ms * 0.9 + ns / 1e6 * 0.1;
                if timer.samples.len() < 1 << 16 {
                    timer.samples.push((ns / 1e6) as f32);
                }
            }
            gl.delete_query(Some(&query));
        }
        if timer.pending.len() < 8 {
            if let Some(query) = gl.create_query() {
                gl.begin_query(TIME_ELAPSED_EXT, &query);
                timer.active = Some(query);
            }
        }
    }

    /// Starts a frame.
    pub fn begin(&mut self) {
        self.poll_timer();
    }

    /// Ends the frame's GPU timing, if any.
    pub fn end(&mut self) {
        if let Some(timer) = self.timer.as_mut() {
            if let Some(query) = timer.active.take() {
                self.gl.end_query(TIME_ELAPSED_EXT);
                timer.pending.push_back(query);
            }
        }
    }

    /// The atlas size that holds `width` x `height` texels, never smaller than it already is.
    pub fn atlas_size_for(&self, width: u32, height: u32) -> (u32, u32) {
        let (w0, h0) = self.atlas.as_ref().map(|a| (a.width, a.height)).unwrap_or((256, 256));
        (w0.max(width.next_power_of_two()).min(MAX_ATLAS), h0.max(height.next_power_of_two()).min(MAX_ATLAS))
    }

    /// Draws the blur jobs' quads into the atlas, sized at least `size`, and blurs `regions` of it.
    pub fn draw_jobs(&mut self, quads: &[Quad], regions: &mut [BlurRegion], size: (u32, u32)) {
        if quads.is_empty() || regions.is_empty() || self.pages.is_none() {
            return;
        }
        let (width, height) = self.atlas_size_for(size.0, size.1);
        if self.atlas.as_ref().is_none_or(|a| a.width != width || a.height != height) {
            if let Some(old) = self.atlas.take() {
                for t in &old.textures {
                    self.gl.delete_texture(Some(t));
                }
                for f in &old.framebuffers {
                    self.gl.delete_framebuffer(Some(f));
                }
            }
            match self.create_atlas(width, height) {
                Some(atlas) => self.atlas = Some(atlas),
                None => return,
            }
        }
        let gl = &self.gl;
        let atlas = self.atlas.as_ref().unwrap();
        gl.bind_framebuffer(Gl::FRAMEBUFFER, Some(&atlas.framebuffers[0]));
        gl.viewport(0, 0, width as i32, height as i32);
        write_globals(gl, &mut self.atlas_globals, (width as f32, height as f32));
        gl.bind_buffer_base(Gl::UNIFORM_BUFFER, quad_shader::GLOBALS_BINDING, Some(&self.atlas_globals.buffer));
        gl.clear_color(0.0, 0.0, 0.0, 0.0);
        gl.clear(Gl::COLOR_BUFFER_BIT);
        gl.use_program(Some(&self.program));
        gl.bind_vertex_array(Some(&self.jobs.vao));
        upload_quads(gl, &mut self.memory, &mut self.jobs, quads);
        // The blur unit must not hold the texture being drawn into, though no job reads it.
        bind_units(gl, self.pages.as_ref().map(|p| &p.texture), &atlas.textures[1]);
        gl.draw_arrays_instanced(Gl::TRIANGLE_STRIP, 0, 4, quads.len() as i32);
        self.blur(regions);
    }

    fn create_atlas(&self, width: u32, height: u32) -> Option<Atlas> {
        let gl = &self.gl;
        gl.active_texture(Gl::TEXTURE0 + BLUR_UNIT);
        let make = || -> Option<(WebGlTexture, WebGlFramebuffer)> {
            let texture = gl.create_texture()?;
            gl.bind_texture(Gl::TEXTURE_2D, Some(&texture));
            let (internal, kind) =
                if self.half_float { (RGBA16F, HALF_FLOAT) } else { (Gl::RGBA as i32, Gl::UNSIGNED_BYTE) };
            gl.tex_image_2d_with_i32_and_i32_and_i32_and_format_and_type_and_opt_u8_array(
                Gl::TEXTURE_2D,
                0,
                internal,
                width as i32,
                height as i32,
                0,
                Gl::RGBA,
                kind,
                None,
            )
            .ok()?;
            gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MIN_FILTER, Gl::LINEAR as i32);
            gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MAG_FILTER, Gl::LINEAR as i32);
            gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_S, Gl::CLAMP_TO_EDGE as i32);
            gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_T, Gl::CLAMP_TO_EDGE as i32);
            let framebuffer = gl.create_framebuffer()?;
            gl.bind_framebuffer(Gl::FRAMEBUFFER, Some(&framebuffer));
            gl.framebuffer_texture_2d(Gl::FRAMEBUFFER, Gl::COLOR_ATTACHMENT0, Gl::TEXTURE_2D, Some(&texture), 0);
            Some((texture, framebuffer))
        };
        let (t0, f0) = make()?;
        let (t1, f1) = make()?;
        Some(Atlas { textures: [t0, t1], framebuffers: [f0, f1], width, height })
    }

    /// Blurs every region of the atlas across, then down. The result is back in the first texture,
    /// where the canvas reads it.
    fn blur(&mut self, regions: &mut [BlurRegion]) {
        let Some(atlas) = self.atlas.as_ref() else { return };
        let gl = &self.gl;
        gl.use_program(Some(&self.blur_program));
        gl.bind_vertex_array(Some(&self.blur_vao));
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&self.blur_instances));
        if regions.len() > self.blur_capacity {
            self.blur_capacity = regions.len().next_power_of_two().max(32);
            gl.buffer_data_with_i32(
                Gl::ARRAY_BUFFER,
                (self.blur_capacity * FLOATS_PER_REGION * 4) as i32,
                Gl::DYNAMIC_DRAW,
            );
        }
        gl.disable(Gl::BLEND);
        gl.active_texture(Gl::TEXTURE0 + BLUR_UNIT);
        for ((from, to), dir) in [((0usize, 1usize), (1.0, 0.0)), ((1, 0), (0.0, 1.0))] {
            for region in regions.iter_mut() {
                region.params[1] = dir.0;
                region.params[2] = dir.1;
            }
            // SAFETY: BlurRegion is repr(C) and made only of f32s.
            let data = unsafe {
                std::slice::from_raw_parts(regions.as_ptr() as *const f32, regions.len() * FLOATS_PER_REGION)
            };
            upload_f32(gl, &mut self.memory, Gl::ARRAY_BUFFER, data);
            gl.bind_framebuffer(Gl::FRAMEBUFFER, Some(&atlas.framebuffers[to]));
            gl.bind_texture(Gl::TEXTURE_2D, Some(&atlas.textures[from]));
            gl.draw_arrays_instanced(Gl::TRIANGLE_STRIP, 0, 4, regions.len() as i32);
        }
        gl.enable(Gl::BLEND);
    }

    /// Clears the canvas and draws `quads` onto it.
    pub fn draw_canvas(&mut self, quads: &[Quad]) {
        let gl = &self.gl;
        gl.bind_framebuffer(Gl::FRAMEBUFFER, None);
        gl.viewport(0, 0, self.canvas_px.0, self.canvas_px.1);
        gl.clear_color(0.0, 0.0, 0.0, 0.0);
        gl.clear(Gl::COLOR_BUFFER_BIT);
        let Some(pages) = self.pages.as_ref() else { return };
        if quads.is_empty() {
            return;
        }
        gl.bind_buffer_base(Gl::UNIFORM_BUFFER, quad_shader::GLOBALS_BINDING, Some(&self.canvas_globals.buffer));
        gl.use_program(Some(&self.program));
        gl.bind_vertex_array(Some(&self.canvas.vao));
        upload_quads(gl, &mut self.memory, &mut self.canvas, quads);
        bind_units(gl, Some(&pages.texture), self.atlas.as_ref().map(|a| &a.textures[0]).unwrap_or(&self.empty));
        gl.draw_arrays_instanced(Gl::TRIANGLE_STRIP, 0, 4, quads.len() as i32);
    }
}

fn bind_units(gl: &Gl, pages: Option<&WebGlTexture>, blur: &WebGlTexture) {
    gl.active_texture(Gl::TEXTURE0 + PAGES_UNIT);
    gl.bind_texture(Gl::TEXTURE_2D_ARRAY, pages);
    gl.active_texture(Gl::TEXTURE0 + BLUR_UNIT);
    gl.bind_texture(Gl::TEXTURE_2D, Some(blur));
}

/// Uploads a draw's quads into its instance buffer, which its vertex array already reads.
fn upload_quads(gl: &Gl, memory: &mut MemoryView, stream: &mut InstanceStream, quads: &[Quad]) {
    // SAFETY: Quad is repr(C) and made only of f32s.
    let data: &[f32] =
        unsafe { std::slice::from_raw_parts(quads.as_ptr() as *const f32, quads.len() * FLOATS_PER_QUAD) };
    gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&stream.buffer));
    if quads.len() > stream.capacity {
        stream.capacity = quads.len().next_power_of_two().max(256);
        gl.buffer_data_with_i32(Gl::ARRAY_BUFFER, (stream.capacity * FLOATS_PER_QUAD * 4) as i32, Gl::DYNAMIC_DRAW);
    }
    upload_f32(gl, memory, Gl::ARRAY_BUFFER, data);
}

/// Points a program's textures at their units and every stage's copy of `Globals` at its binding.
fn bind_resources(gl: &Gl, program: &WebGlProgram, samplers: &[(&[&str], u32)], blocks: &[&str], binding: u32) {
    gl.use_program(Some(program));
    for &(names, unit) in samplers {
        for name in names {
            gl.uniform1i(gl.get_uniform_location(program, name).as_ref(), unit as i32);
        }
    }
    for name in blocks {
        let index = gl.get_uniform_block_index(program, name);
        if index != Gl::INVALID_INDEX {
            gl.uniform_block_binding(program, index, binding);
        }
    }
}

fn uniform_buffer(gl: &Gl) -> Result<WebGlBuffer, String> {
    let buffer = gl.create_buffer().ok_or("no buffer")?;
    gl.bind_buffer(Gl::UNIFORM_BUFFER, Some(&buffer));
    gl.buffer_data_with_i32(Gl::UNIFORM_BUFFER, (GLOBALS_FLOATS * 4) as i32, Gl::DYNAMIC_DRAW);
    Ok(buffer)
}

/// Writes a target's size into its `Globals`, when it changed.
fn write_globals(gl: &Gl, globals: &mut Globals, size: (f32, f32)) {
    if globals.size == size {
        return;
    }
    globals.size = size;
    let data: [f32; GLOBALS_FLOATS] = [size.0, size.1, 0.0, 0.0];
    gl.bind_buffer(Gl::UNIFORM_BUFFER, Some(&globals.buffer));
    // SAFETY: the view is consumed by buffer_sub_data before any allocation can move wasm memory.
    unsafe {
        let view = js_sys::Float32Array::view(&data);
        gl.buffer_sub_data_with_i32_and_array_buffer_view(Gl::UNIFORM_BUFFER, 0, &view);
    }
}

fn compile(gl: &Gl, kind: u32, source: &str) -> Result<WebGlShader, String> {
    let shader = gl.create_shader(kind).ok_or("no shader")?;
    gl.shader_source(&shader, source);
    gl.compile_shader(&shader);
    if gl.get_shader_parameter(&shader, Gl::COMPILE_STATUS).as_bool().unwrap_or(false) {
        Ok(shader)
    } else {
        Err(gl.get_shader_info_log(&shader).unwrap_or_default())
    }
}

fn link(gl: &Gl, vertex: &str, fragment: &str) -> Result<WebGlProgram, String> {
    let program = gl.create_program().ok_or("no program")?;
    gl.attach_shader(&program, &compile(gl, Gl::VERTEX_SHADER, vertex)?);
    gl.attach_shader(&program, &compile(gl, Gl::FRAGMENT_SHADER, fragment)?);
    gl.link_program(&program);
    if gl.get_program_parameter(&program, Gl::LINK_STATUS).as_bool().unwrap_or(false) {
        Ok(program)
    } else {
        Err(gl.get_program_info_log(&program).unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shelves_pack_lines_and_take_back_what_is_freed() {
        let mut shelves = Shelves::new(1024, 256, 1);
        // Two lines of a height share a shelf; a much shorter one starts its own.
        assert_eq!(shelves.allocate(400, 96), Some((0, 0, 0)));
        assert_eq!(shelves.allocate(400, 96), Some((0, 400, 0)));
        assert_eq!(shelves.allocate(200, 48), Some((0, 0, 96)));
        // No room in the layer for another shelf of 128.
        assert_eq!(shelves.allocate(100, 128), None);
        // Freeing the shorter line, the top shelf, gives its rows back.
        shelves.free(0, 0, 96, 200);
        assert_eq!(shelves.layers[0].top, 96);
        assert_eq!(shelves.allocate(100, 128), Some((0, 0, 96)));
        // Freed spans merge, so a wider line fits where two were.
        shelves.free(0, 0, 0, 400);
        shelves.free(0, 400, 0, 400);
        assert_eq!(shelves.layers[0].shelves[0].free, vec![(0, 1024)]);
        assert_eq!(shelves.allocate(900, 96), Some((0, 0, 0)));
        // A second layer takes what the first cannot.
        shelves.add_layers(1);
        assert_eq!(shelves.allocate(1024, 160), Some((1, 0, 0)));
    }

    #[test]
    fn placing_a_quad_keeps_its_ramp_and_wave_on_the_same_texels() {
        let texture = LineTexture { layer: 2, x: 320, y: 48, held: (0, 0), generation: 0, width: 0, height: 0 };
        let quad = Quad {
            uv: [10.0, 5.0, 30.0, 25.0],
            ramp: [0.25, -0.5, 2.0, 0.3],
            wave: [0.1, 1.0, Quad::TEXT, 0.0],
            ..Default::default()
        };
        let mut placed = [quad];
        texture.place(&mut placed);
        let lit = |q: &Quad, u: f32, v: f32| {
            u * q.ramp[0] + v * q.ramp[1] + q.ramp[2] + q.ramp[3] * (u * q.wave[0] + q.wave[1]).sin()
        };
        let (u, v) = (17.0, 9.0);
        assert!((lit(&quad, u, v) - lit(&placed[0], u + 320.0, v + 48.0)).abs() < 1e-4);
        assert_eq!(placed[0].uv, [330.0, 53.0, 350.0, 73.0]);
        assert_eq!(placed[0].wave[2], 2.0 * 4.0 + 1.0);
    }
}
