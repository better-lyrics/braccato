//! The WebGL2 side: one shader program, one instance buffer, and a texture per rasterized line.
//!
//! Every frame is a handful of instanced draws. Each instance is an axis-aligned quad cut out of a
//! line texture whose red channel holds the text and whose green and blue channels hold the text
//! blurred at the glow's full and partial radius (see `raster.rs`). What a quad shows is decided per
//! fragment from four numbers: the colour where it is unlit, the colour where it is lit, a linear ramp
//! across the texture that says how lit each column is, and for glow quads how far the blur has
//! shrunk. Nothing else is computed on the GPU, so the shader stays small and the fill cost is one
//! texture fetch per covered pixel.
//!
//! The shader is written in WGSL (`src/shaders/quad.wgsl`). build.rs validates it with naga and
//! translates it to GLSL ES 3.00 at build time, so a shader error fails the build. The only uniforms
//! are one small uniform buffer, written when the canvas is resized, and the texture: nothing changes
//! between draws but the bound texture and the instance range.

use wasm_bindgen::JsCast;
use web_sys::{
    HtmlCanvasElement, WebGl2RenderingContext as Gl, WebGlBuffer, WebGlProgram, WebGlShader, WebGlTexture,
    WebGlVertexArrayObject,
};

/// Where the shader switches from blending text into the tight halo to blending the tight halo into
/// the wide one, as a fraction of the full glow radius. Must match `raster::TIGHT_HALO_FRACTION`.
pub const TIGHT_HALO_FRACTION: f32 = 0.45;

/// One instanced quad. The layout is mirrored by the attribute pointers in `Gpu::new`.
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct Quad {
    /// x, y, width, height in canvas CSS pixels.
    pub rect: [f32; 4],
    /// u0, v0, u1, v1 in texels of the line texture.
    pub uv: [f32; 4],
    /// Premultiplied colour where the ramp is 0.
    pub unlit: [f32; 4],
    /// Premultiplied colour where the ramp is 1.
    pub lit: [f32; 4],
    /// How lit each texel is: `clamp(u * ramp[0] + v * ramp[1] + ramp[2] + ramp[3] * sin(u * wave[0] + wave[1]), 0, 1)`
    /// for texel (u, v). Text only uses the first and third terms; the instrumental note's rising
    /// wave uses the rest.
    pub ramp: [f32; 4],
    /// `wave[0..2]` as above. `wave[2]` is negative for text, otherwise the glow radius as a fraction
    /// of the full radius, which picks the blend of blurred channels the quad samples.
    pub wave: [f32; 4],
}

impl Quad {
    pub const TEXT: f32 = -1.0;
    /// A glyph in its own colours (emoji): the texel is drawn as is, scaled by the colours' alpha.
    pub const COLOR: f32 = -2.0;
}

const FLOATS_PER_QUAD: usize = std::mem::size_of::<Quad>() / 4;

/// The quad shader, `src/shaders/quad.wgsl`, as build.rs checked and translated it to GLSL ES 3.00,
/// with the names naga gave its uniform block and sampler.
mod quad_shader {
    include!(concat!(env!("OUT_DIR"), "/quad_names.rs"));
    pub const VERTEX: &str = include_str!(concat!(env!("OUT_DIR"), "/quad.vert.glsl"));
    pub const FRAGMENT: &str = include_str!(concat!(env!("OUT_DIR"), "/quad.frag.glsl"));
}

/// `Globals` in the shader: the viewport size, then the halo split, padded to std140's 16 bytes.
const GLOBALS_FLOATS: usize = 4;

pub struct LineTexture {
    texture: WebGlTexture,
    pub width: u32,
    pub height: u32,
}

pub struct Gpu {
    pub gl: Gl,
    program: WebGlProgram,
    vao: WebGlVertexArrayObject,
    instances: WebGlBuffer,
    instance_capacity: usize,
    /// The uniform buffer behind `Globals`.
    globals: WebGlBuffer,
    viewport: (f32, f32),
    timer: Option<Timer>,
}

/// GPU time per frame, from `EXT_disjoint_timer_query_webgl2`, when profiling is on. Results arrive
/// a few frames late, so queries are kept in flight and read as they land.
struct Timer {
    pending: std::collections::VecDeque<web_sys::WebGlQuery>,
    active: Option<web_sys::WebGlQuery>,
    /// Exponential average of GPU milliseconds per frame.
    pub average_ms: f64,
}

const TIME_ELAPSED_EXT: u32 = 0x88BF;
const GPU_DISJOINT_EXT: u32 = 0x8FBB;

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
        gl.use_program(Some(&program));
        // The line texture is always on unit 0.
        for name in quad_shader::LINE_TEXTURE_SAMPLERS {
            gl.uniform1i(gl.get_uniform_location(&program, name).as_ref(), 0);
        }
        // Every stage's copy of `Globals` reads the same buffer.
        for name in quad_shader::GLOBALS_BLOCKS {
            let index = gl.get_uniform_block_index(&program, name);
            if index != Gl::INVALID_INDEX {
                gl.uniform_block_binding(&program, index, quad_shader::GLOBALS_BINDING);
            }
        }
        let globals = gl.create_buffer().ok_or("no buffer")?;
        gl.bind_buffer(Gl::UNIFORM_BUFFER, Some(&globals));
        let initial: [f32; GLOBALS_FLOATS] = [1.0, 1.0, TIGHT_HALO_FRACTION, 0.0];
        // SAFETY: the view is consumed by buffer_data before any allocation can move wasm memory.
        unsafe {
            let view = js_sys::Float32Array::view(&initial);
            gl.buffer_data_with_array_buffer_view(Gl::UNIFORM_BUFFER, &view, Gl::DYNAMIC_DRAW);
        }
        gl.bind_buffer_base(Gl::UNIFORM_BUFFER, quad_shader::GLOBALS_BINDING, Some(&globals));

        let vao = gl.create_vertex_array().ok_or("no vao")?;
        gl.bind_vertex_array(Some(&vao));

        let corners = gl.create_buffer().ok_or("no buffer")?;
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&corners));
        let corner_data: [f32; 8] = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0];
        // SAFETY: the view is consumed by buffer_data before any allocation can move wasm memory.
        unsafe {
            let view = js_sys::Float32Array::view(&corner_data);
            gl.buffer_data_with_array_buffer_view(Gl::ARRAY_BUFFER, &view, Gl::STATIC_DRAW);
        }
        gl.enable_vertex_attrib_array(0);
        gl.vertex_attrib_pointer_with_i32(0, 2, Gl::FLOAT, false, 0, 0);

        let instances = gl.create_buffer().ok_or("no buffer")?;
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&instances));

        gl.disable(Gl::DEPTH_TEST);
        gl.enable(Gl::BLEND);
        gl.blend_func(Gl::ONE, Gl::ONE_MINUS_SRC_ALPHA);
        gl.pixel_storei(Gl::UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);

        let gpu = Gpu { gl, program, vao, instances, instance_capacity: 0, globals, viewport: (1.0, 1.0), timer: None };
        gpu.point_instance_attributes(0);
        Ok(gpu)
    }

    /// Instance attributes 1 to 6, read from the instance buffer starting at `first` quads in.
    fn point_instance_attributes(&self, first: usize) {
        let gl = &self.gl;
        let stride = (FLOATS_PER_QUAD * 4) as i32;
        let base = (first * FLOATS_PER_QUAD * 4) as i32;
        // (location, float count, float offset within a quad)
        let layout: [(u32, i32, i32); 6] = [(1, 4, 0), (2, 4, 4), (3, 4, 8), (4, 4, 12), (5, 4, 16), (6, 4, 20)];
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&self.instances));
        for (location, size, offset) in layout {
            gl.enable_vertex_attrib_array(location);
            gl.vertex_attrib_pointer_with_i32(location, size, Gl::FLOAT, false, stride, base + offset * 4);
            gl.vertex_attrib_divisor(location, 1);
        }
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
        self.gl.viewport(0, 0, width as i32, height as i32);
        let viewport = (css_width.max(1.0), css_height.max(1.0));
        if viewport != self.viewport {
            self.viewport = viewport;
            let data: [f32; 2] = [viewport.0, viewport.1];
            let gl = &self.gl;
            gl.bind_buffer(Gl::UNIFORM_BUFFER, Some(&self.globals));
            // SAFETY: the view is consumed by buffer_sub_data before any allocation can move wasm memory.
            unsafe {
                let view = js_sys::Float32Array::view(&data);
                gl.buffer_sub_data_with_i32_and_array_buffer_view(Gl::UNIFORM_BUFFER, 0, &view);
            }
        }
    }

    pub fn upload_line(&self, source: &HtmlCanvasElement) -> Option<LineTexture> {
        let gl = &self.gl;
        let texture = gl.create_texture()?;
        gl.bind_texture(Gl::TEXTURE_2D, Some(&texture));
        gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MIN_FILTER, Gl::LINEAR as i32);
        gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MAG_FILTER, Gl::LINEAR as i32);
        gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_S, Gl::CLAMP_TO_EDGE as i32);
        gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_WRAP_T, Gl::CLAMP_TO_EDGE as i32);
        gl.tex_image_2d_with_u32_and_u32_and_html_canvas_element(
            Gl::TEXTURE_2D,
            0,
            Gl::RGBA as i32,
            Gl::RGBA,
            Gl::UNSIGNED_BYTE,
            source,
        )
        .ok()?;
        Some(LineTexture { texture, width: source.width(), height: source.height() })
    }

    pub fn release(&self, texture: LineTexture) {
        self.gl.delete_texture(Some(&texture.texture));
    }

    /// Turns GPU timing on or off. Returns whether the browser can time the GPU at all.
    pub fn set_profiling(&mut self, on: bool) -> bool {
        if !on {
            self.timer = None;
            return true;
        }
        let supported = self.gl.get_extension("EXT_disjoint_timer_query_webgl2").ok().flatten().is_some();
        if supported && self.timer.is_none() {
            self.timer = Some(Timer { pending: Default::default(), active: None, average_ms: 0.0 });
        }
        supported
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

    /// Ends the frame's GPU timing, if any.
    pub fn end(&mut self) {
        if let Some(timer) = self.timer.as_mut() {
            if let Some(query) = timer.active.take() {
                self.gl.end_query(TIME_ELAPSED_EXT);
                timer.pending.push_back(query);
            }
        }
    }

    /// Starts a frame: clears to transparent and uploads every quad of the frame at once.
    pub fn begin(&mut self, quads: &[Quad]) {
        self.poll_timer();
        let gl = &self.gl;
        gl.clear_color(0.0, 0.0, 0.0, 0.0);
        gl.clear(Gl::COLOR_BUFFER_BIT);
        gl.use_program(Some(&self.program));
        gl.bind_vertex_array(Some(&self.vao));
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&self.instances));
        if quads.is_empty() {
            return;
        }
        let floats = quads.len() * FLOATS_PER_QUAD;
        // SAFETY: Quad is repr(C) and made only of f32s.
        let data: &[f32] = unsafe { std::slice::from_raw_parts(quads.as_ptr() as *const f32, floats) };
        if quads.len() > self.instance_capacity {
            self.instance_capacity = quads.len().next_power_of_two().max(256);
            gl.buffer_data_with_i32(
                Gl::ARRAY_BUFFER,
                (self.instance_capacity * FLOATS_PER_QUAD * 4) as i32,
                Gl::DYNAMIC_DRAW,
            );
        }
        // SAFETY: the view is consumed by buffer_sub_data before any allocation can move wasm memory.
        unsafe {
            let view = js_sys::Float32Array::view(data);
            gl.buffer_sub_data_with_i32_and_array_buffer_view(Gl::ARRAY_BUFFER, 0, &view);
        }
    }

    /// Draws `count` quads starting at `first` from the line texture.
    pub fn draw(&self, texture: &LineTexture, first: usize, count: usize) {
        if count == 0 {
            return;
        }
        let gl = &self.gl;
        gl.active_texture(Gl::TEXTURE0);
        gl.bind_texture(Gl::TEXTURE_2D, Some(&texture.texture));
        self.point_instance_attributes(first);
        gl.draw_arrays_instanced(Gl::TRIANGLE_STRIP, 0, 4, count as i32);
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
