// The shader the renderer draws with: an instanced quad cut out of a texture.
//
// A quad reads a line in the line pages, an array texture whose red channel holds the text's
// coverage (see raster.rs) and whose colour glyphs (emoji) are drawn in their own colours, or the
// blur atlas, which holds glows and blurred lines already in colour (see gpu.rs). What a quad shows
// is decided per fragment from four numbers: the colour where it is unlit, the colour where it is
// lit, a ramp across the texture that says how lit each texel is, and which kind of texel it reads.
//
// build.rs checks this file and translates it to GLSL ES 3.00 for WebGL2. The instance layout must
// match `Quad` in gpu.rs, attribute for attribute.

struct Globals {
    // The size of what is drawn into, in the units quad rectangles are given in: the canvas in CSS
    // pixels, or the blur atlas in texels.
    viewport: vec2<f32>,
}

@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var line_pages: texture_2d_array<f32>;
@group(0) @binding(2) var line_sampler: sampler;
@group(0) @binding(3) var blur_atlas: texture_2d<f32>;
@group(0) @binding(4) var blur_sampler: sampler;

struct Instance {
    // The quad's corner, 0 or 1 on each axis, from the shared corner buffer.
    @location(0) corner: vec2<f32>,
    // x, y, width, height, in the units of `globals.viewport`.
    @location(1) rect: vec4<f32>,
    // u0, v0, u1, v1 in texels of the texture: of the page, or of the atlas.
    @location(2) uv: vec4<f32>,
    // Premultiplied colours where the ramp is 0 and where it is 1.
    @location(3) unlit: vec4<f32>,
    @location(4) lit: vec4<f32>,
    // lit = clamp(u * ramp.x + v * ramp.y + ramp.z + ramp.w * sin(u * wave.x + wave.y), 0, 1)
    @location(5) ramp: vec4<f32>,
    // wave.z: what to read, layer * 4 + kind, where kind is 1 for page coverage to tint, 2 for page
    // texels in their own colours, and 3 for the blur atlas; 0 reads nothing and draws a rounded box
    // (uv: the box in pixels; ramp: half width, half height, radius, border width). wave.w: the mip level to read, 0 on the
    // canvas, coarser when drawn into the blur atlas at a fraction of the size.
    @location(6) wave: vec4<f32>,
}

struct Varyings {
    @builtin(position) position: vec4<f32>,
    // The fragment's position in texels of the texture.
    @location(0) texel: vec2<f32>,
    // The same for every fragment of a quad.
    @location(1) @interpolate(flat) unlit: vec4<f32>,
    @location(2) @interpolate(flat) lit: vec4<f32>,
    @location(3) @interpolate(flat) ramp: vec4<f32>,
    @location(4) @interpolate(flat) wave: vec4<f32>,
}

@vertex
fn vs_main(instance: Instance) -> Varyings {
    var out: Varyings;
    let pos = instance.rect.xy + instance.corner * instance.rect.zw;
    out.texel = mix(instance.uv.xy, instance.uv.zw, instance.corner);
    out.unlit = instance.unlit;
    out.lit = instance.lit;
    out.ramp = instance.ramp;
    out.wave = instance.wave;
    // y down to clip space, y up.
    let clip = pos / globals.viewport * 2.0 - 1.0;
    out.position = vec4<f32>(clip.x, -clip.y, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(in: Varyings) -> @location(0) vec4<f32> {
    if in.wave.z == 0.0 {
        let half = in.ramp.xy;
        let radius = in.ramp.z;
        let q = abs(in.texel - half) - half + vec2<f32>(radius);
        let distance = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
        let inside = clamp(0.5 - distance, 0.0, 1.0);
        let within_border = clamp(0.5 - distance - in.ramp.w, 0.0, 1.0);
        return mix(in.lit, in.unlit, within_border) * inside;
    }
    let layer = floor(in.wave.z / 4.0);
    let kind = in.wave.z - layer * 4.0;
    var texel: vec4<f32>;
    if kind > 2.5 {
        let size = vec2<f32>(textureDimensions(blur_atlas));
        texel = textureSampleLevel(blur_atlas, blur_sampler, in.texel / size, 0.0);
    } else {
        let size = vec2<f32>(textureDimensions(line_pages).xy);
        texel = textureSampleLevel(line_pages, line_sampler, in.texel / size, i32(layer), in.wave.w);
    }

    var ramp = dot(in.texel, in.ramp.xy) + in.ramp.z;
    if in.ramp.w != 0.0 {
        ramp += in.ramp.w * sin(in.texel.x * in.wave.x + in.wave.y);
    }
    let lit = clamp(ramp, 0.0, 1.0);

    // Its own colours (an emoji, the blur atlas), faded with the line.
    if kind > 1.5 {
        return texel * mix(in.unlit.a, in.lit.a, lit);
    }
    return mix(in.unlit, in.lit, lit) * texel.r;
}
