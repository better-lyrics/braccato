// The one shader the renderer draws with: an instanced quad cut out of a line texture.
//
// The texture's red channel holds the text, green the text blurred to the glow's full radius, blue
// blurred to `globals.tight` of it (see raster.rs). What a quad shows is decided per fragment from
// four numbers: the colour where it is unlit, the colour where it is lit, a ramp across the texture
// that says how lit each texel is, and for glow quads how far the blur has shrunk.
//
// build.rs checks this file and translates it to GLSL ES 3.00 for WebGL2. The instance layout must
// match `Quad` in gpu.rs, attribute for attribute.

struct Globals {
    // The canvas size in CSS pixels, which quad rectangles are given in.
    viewport: vec2<f32>,
    // Where the halo blend switches from text-to-tight to tight-to-wide, as a fraction of the full
    // glow radius. Written once, from `TIGHT_HALO_FRACTION`.
    tight: f32,
}

@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var line_texture: texture_2d<f32>;
@group(0) @binding(2) var line_sampler: sampler;

struct Instance {
    // The quad's corner, 0 or 1 on each axis, from the shared corner buffer.
    @location(0) corner: vec2<f32>,
    // x, y, width, height in canvas CSS pixels.
    @location(1) rect: vec4<f32>,
    // u0, v0, u1, v1 in texels of the line texture.
    @location(2) uv: vec4<f32>,
    // Premultiplied colours where the ramp is 0 and where it is 1.
    @location(3) unlit: vec4<f32>,
    @location(4) lit: vec4<f32>,
    // lit = clamp(u * ramp.x + v * ramp.y + ramp.z + ramp.w * sin(u * wave.x + wave.y), 0, 1)
    @location(5) ramp: vec4<f32>,
    // wave.z: -1 for text, -2 for a glyph in its own colours, otherwise the glow radius as a
    // fraction of the full radius.
    @location(6) wave: vec4<f32>,
}

struct Varyings {
    @builtin(position) position: vec4<f32>,
    // The fragment's position in texels of the line texture.
    @location(0) texel: vec2<f32>,
    @location(1) unlit: vec4<f32>,
    @location(2) lit: vec4<f32>,
    @location(3) ramp: vec4<f32>,
    @location(4) wave: vec3<f32>,
}

@vertex
fn vs_main(instance: Instance) -> Varyings {
    var out: Varyings;
    let pos = instance.rect.xy + instance.corner * instance.rect.zw;
    out.texel = mix(instance.uv.xy, instance.uv.zw, instance.corner);
    out.unlit = instance.unlit;
    out.lit = instance.lit;
    out.ramp = instance.ramp;
    out.wave = instance.wave.xyz;
    // CSS pixels, y down, to clip space, y up.
    let clip = pos / globals.viewport * 2.0 - 1.0;
    out.position = vec4<f32>(clip.x, -clip.y, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(in: Varyings) -> @location(0) vec4<f32> {
    let size = vec2<f32>(textureDimensions(line_texture));
    let texel = textureSample(line_texture, line_sampler, in.texel / size);
    let s = texel.rgb;

    var ramp = dot(in.texel, in.ramp.xy) + in.ramp.z;
    if in.ramp.w != 0.0 {
        ramp += in.ramp.w * sin(in.texel.x * in.wave.x + in.wave.y);
    }
    let lit = clamp(ramp, 0.0, 1.0);
    let halo = in.wave.z;

    // An emoji: its own colours, faded with the line.
    if halo < -1.5 {
        return texel * mix(in.unlit.a, in.lit.a, lit);
    }

    var coverage: f32;
    if halo < 0.0 {
        coverage = s.r;
    } else if halo < globals.tight {
        // Below the tight blur the glow is between the text itself and that blur. Mixed in
        // linearly, the blur's wide tails would still show on a glow that has almost shrunk away,
        // so it comes in a little later than that.
        let t = halo / globals.tight;
        coverage = mix(s.r, s.b, pow(t, 1.5));
    } else {
        coverage = mix(s.b, s.g, (halo - globals.tight) / (1.0 - globals.tight));
    }
    return mix(in.unlit, in.lit, lit) * coverage;
}
