//! The WebGL2 side: two shader programs, an instance buffer, a texture per rasterized line, and an
//! atlas that blurs are drawn and blurred in.
//!
//! Every frame is a handful of instanced draws. Each instance is an axis-aligned quad cut out of a
//! texture: a line texture, whose red channel holds the text's coverage, or the blur atlas. What a
//! quad shows is decided per fragment from four numbers: the colour where it is unlit, the colour
//! where it is lit, a linear ramp across the texture that says how lit each column is, and which kind
//! of texel it reads.
//!
//! Glows, the instrumental note's glow and blurred lines are real Gaussian blurs, made each frame:
//!
//! 1. What is to be blurred (a glowing word's lit letters in the glow colour, the note's filled part,
//!    a whole line) is drawn with the ordinary quads into a region of the atlas, scaled down so its
//!    standard deviation spans 1.5 to 3 texels. The quads read the line texture's mip level for that
//!    scale, so the shrinking averages properly.
//! 2. Every region is blurred across, then down, by the blur program (`src/shaders/blur.wgsl`), one
//!    instanced draw per direction for all of them.
//! 3. Each region is drawn onto the canvas as one quad, scaled back up with bilinear filtering.
//!
//! Sampled that finely the blur has nothing to ripple, and at that scale it costs a few texel reads
//! per covered pixel.
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

/// One instanced quad. The layout is mirrored by the attribute pointers in `Gpu::new`.
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
    /// `wave[0..2]` as above. `wave[2]` says what the texel is (`TEXT` or `COLOR`), `wave[3]` the mip
    /// level read: 0 on the canvas.
    pub wave: [f32; 4],
}

impl Quad {
    /// Coverage, tinted by the quad's colours.
    pub const TEXT: f32 = -1.0;
    /// Texels in their own colours (emoji, the blur atlas), scaled by the colours' alpha.
    pub const COLOR: f32 = -2.0;
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

pub struct LineTexture {
    texture: WebGlTexture,
    pub width: u32,
    pub height: u32,
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

pub struct Gpu {
    pub gl: Gl,
    program: WebGlProgram,
    vao: WebGlVertexArrayObject,
    instances: WebGlBuffer,
    instance_capacity: usize,
    blur_program: WebGlProgram,
    blur_vao: WebGlVertexArrayObject,
    blur_instances: WebGlBuffer,
    blur_capacity: usize,
    canvas_globals: Globals,
    atlas_globals: Globals,
    /// The canvas's size in device pixels, for the viewport.
    canvas_px: (i32, i32),
    atlas: Option<Atlas>,
    /// Whether the atlas can be half floats, so faint glows do not band.
    half_float: bool,
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
            quad_shader::LINE_TEXTURE_SAMPLERS,
            quad_shader::GLOBALS_BLOCKS,
            quad_shader::GLOBALS_BINDING,
        );
        let blur_program = link(&gl, blur_shader::VERTEX, blur_shader::FRAGMENT)?;
        bind_resources(
            &gl,
            &blur_program,
            blur_shader::SOURCE_SAMPLERS,
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
        // Both programs read the shared corner at location 0 and their instances after it.
        let vertex_array = |instances: &WebGlBuffer| -> Result<WebGlVertexArrayObject, String> {
            let vao = gl.create_vertex_array().ok_or("no vao")?;
            gl.bind_vertex_array(Some(&vao));
            gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&corners));
            gl.enable_vertex_attrib_array(0);
            gl.vertex_attrib_pointer_with_i32(0, 2, Gl::FLOAT, false, 0, 0);
            gl.bind_buffer(Gl::ARRAY_BUFFER, Some(instances));
            Ok(vao)
        };
        let blur_instances = gl.create_buffer().ok_or("no buffer")?;
        let blur_vao = vertex_array(&blur_instances)?;
        let stride = (FLOATS_PER_REGION * 4) as i32;
        for (location, offset) in [(1u32, 0i32), (2, 16)] {
            gl.enable_vertex_attrib_array(location);
            gl.vertex_attrib_pointer_with_i32(location, 4, Gl::FLOAT, false, stride, offset);
            gl.vertex_attrib_divisor(location, 1);
        }
        let instances = gl.create_buffer().ok_or("no buffer")?;
        let vao = vertex_array(&instances)?;

        gl.disable(Gl::DEPTH_TEST);
        gl.enable(Gl::BLEND);
        gl.blend_func(Gl::ONE, Gl::ONE_MINUS_SRC_ALPHA);
        gl.pixel_storei(Gl::UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
        let half_float = gl.get_extension("EXT_color_buffer_float").ok().flatten().is_some();

        let gpu = Gpu {
            gl,
            program,
            vao,
            instances,
            instance_capacity: 0,
            blur_program,
            blur_vao,
            blur_instances,
            blur_capacity: 0,
            canvas_globals,
            atlas_globals,
            canvas_px: (1, 1),
            atlas: None,
            half_float,
            timer: None,
        };
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
        self.canvas_px = (width as i32, height as i32);
        write_globals(&self.gl, &mut self.canvas_globals, (css_width.max(1.0), css_height.max(1.0)));
    }

    pub fn upload_line(&self, source: &HtmlCanvasElement) -> Option<LineTexture> {
        let gl = &self.gl;
        let texture = gl.create_texture()?;
        gl.bind_texture(Gl::TEXTURE_2D, Some(&texture));
        gl.tex_parameteri(Gl::TEXTURE_2D, Gl::TEXTURE_MIN_FILTER, Gl::LINEAR_MIPMAP_LINEAR as i32);
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
        // Read when the line is drawn into the blur atlas at a fraction of its size.
        gl.generate_mipmap(Gl::TEXTURE_2D);
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

    /// Ends the frame's GPU timing, if any.
    pub fn end(&mut self) {
        if let Some(timer) = self.timer.as_mut() {
            if let Some(query) = timer.active.take() {
                self.gl.end_query(TIME_ELAPSED_EXT);
                timer.pending.push_back(query);
            }
        }
    }

    /// Starts a frame: uploads every quad of the frame at once, the atlas's and the canvas's.
    pub fn begin(&mut self, quads: &[Quad]) {
        self.poll_timer();
        let gl = &self.gl;
        gl.use_program(Some(&self.program));
        gl.bind_vertex_array(Some(&self.vao));
        if quads.is_empty() {
            return;
        }
        // SAFETY: Quad is repr(C) and made only of f32s.
        let data: &[f32] =
            unsafe { std::slice::from_raw_parts(quads.as_ptr() as *const f32, quads.len() * FLOATS_PER_QUAD) };
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&self.instances));
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

    /// The atlas size that holds `width` x `height` texels, never smaller than it already is.
    pub fn atlas_size_for(&self, width: u32, height: u32) -> (u32, u32) {
        let (w0, h0) = self.atlas.as_ref().map(|a| (a.width, a.height)).unwrap_or((256, 256));
        (w0.max(width.next_power_of_two()).min(MAX_ATLAS), h0.max(height.next_power_of_two()).min(MAX_ATLAS))
    }

    /// Draws into the atlas from here on, cleared, sized at least `width` x `height`.
    pub fn begin_atlas(&mut self, width: u32, height: u32) -> bool {
        let (width, height) = self.atlas_size_for(width, height);
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
                None => return false,
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
        true
    }

    fn create_atlas(&self, width: u32, height: u32) -> Option<Atlas> {
        let gl = &self.gl;
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
    /// where `draw_atlas` reads it.
    pub fn blur(&mut self, regions: &mut [BlurRegion]) {
        let Some(atlas) = self.atlas.as_ref() else { return };
        if regions.is_empty() {
            return;
        }
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
        gl.active_texture(Gl::TEXTURE0);
        for (pass, (from, to), dir) in [(0, (0usize, 1usize), (1.0, 0.0)), (1, (1, 0), (0.0, 1.0))] {
            for region in regions.iter_mut() {
                region.params[1] = dir.0;
                region.params[2] = dir.1;
            }
            // SAFETY: BlurRegion is repr(C) and made only of f32s; the view is consumed at once.
            unsafe {
                let data =
                    std::slice::from_raw_parts(regions.as_ptr() as *const f32, regions.len() * FLOATS_PER_REGION);
                let view = js_sys::Float32Array::view(data);
                gl.buffer_sub_data_with_i32_and_array_buffer_view(Gl::ARRAY_BUFFER, 0, &view);
            }
            let _ = pass;
            gl.bind_framebuffer(Gl::FRAMEBUFFER, Some(&atlas.framebuffers[to]));
            gl.bind_texture(Gl::TEXTURE_2D, Some(&atlas.textures[from]));
            gl.draw_arrays_instanced(Gl::TRIANGLE_STRIP, 0, 4, regions.len() as i32);
        }
        gl.enable(Gl::BLEND);
        gl.use_program(Some(&self.program));
        gl.bind_vertex_array(Some(&self.vao));
    }

    /// Draws onto the canvas from here on, cleared.
    pub fn begin_canvas(&mut self) {
        let gl = &self.gl;
        gl.bind_framebuffer(Gl::FRAMEBUFFER, None);
        gl.viewport(0, 0, self.canvas_px.0, self.canvas_px.1);
        gl.bind_buffer_base(Gl::UNIFORM_BUFFER, quad_shader::GLOBALS_BINDING, Some(&self.canvas_globals.buffer));
        gl.clear_color(0.0, 0.0, 0.0, 0.0);
        gl.clear(Gl::COLOR_BUFFER_BIT);
    }

    /// Draws `count` quads starting at `first` from the line texture.
    pub fn draw(&self, texture: &LineTexture, first: usize, count: usize) {
        self.draw_from(&texture.texture, first, count);
    }

    /// Draws `count` quads starting at `first` from the blurred atlas.
    pub fn draw_atlas(&self, first: usize, count: usize) {
        if let Some(atlas) = &self.atlas {
            self.draw_from(&atlas.textures[0], first, count);
        }
    }

    fn draw_from(&self, texture: &WebGlTexture, first: usize, count: usize) {
        if count == 0 {
            return;
        }
        let gl = &self.gl;
        gl.active_texture(Gl::TEXTURE0);
        gl.bind_texture(Gl::TEXTURE_2D, Some(texture));
        self.point_instance_attributes(first);
        gl.draw_arrays_instanced(Gl::TRIANGLE_STRIP, 0, 4, count as i32);
    }
}

/// Points a program's texture at unit 0 and every stage's copy of `Globals` at its binding.
fn bind_resources(gl: &Gl, program: &WebGlProgram, samplers: &[&str], blocks: &[&str], binding: u32) {
    gl.use_program(Some(program));
    for name in samplers {
        gl.uniform1i(gl.get_uniform_location(program, name).as_ref(), 0);
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
