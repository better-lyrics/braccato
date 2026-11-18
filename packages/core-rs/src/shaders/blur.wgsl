// One direction of a Gaussian blur over regions of the blur atlas (see `gpu.rs`).
//
// Each instance is a region: what was drawn there (a glowing word's lit letters, the note's filled
// part, a line) at a coarse scale, where sigma is between 1.5 and 3 texels. The pass blurs across,
// the next down. Texels are read exactly (no filtering), and only from inside the region, so regions
// packed side by side never bleed into one another.
//
// build.rs checks this file and translates it to GLSL ES 3.00 for WebGL2. The instance layout must
// match `BlurInstance` in gpu.rs.

struct Globals {
    // The atlas size in texels, which region rectangles are given in.
    viewport: vec2<f32>,
}

@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var source: texture_2d<f32>;

struct Instance {
    // The quad's corner, 0 or 1 on each axis.
    @location(0) corner: vec2<f32>,
    // x, y, width, height of the region, in atlas texels.
    @location(1) rect: vec4<f32>,
    // sigma in texels, then the direction: (1, 0) across or (0, 1) down.
    @location(2) params: vec4<f32>,
}

struct Varyings {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(flat) rect: vec4<f32>,
    @location(1) @interpolate(flat) params: vec4<f32>,
}

@vertex
fn vs_main(instance: Instance) -> Varyings {
    var out: Varyings;
    let pos = instance.rect.xy + instance.corner * instance.rect.zw;
    // Atlas texels to clip space. The atlas is a framebuffer, so its rows run bottom up, like clip space.
    let clip = pos / globals.viewport * 2.0 - 1.0;
    out.position = vec4<f32>(clip, 0.0, 1.0);
    out.rect = instance.rect;
    out.params = instance.params;
    return out;
}

// Beyond three sigma a Gaussian's weight is below 1%, and sigma is at most 3 texels here.
const MAX_REACH: i32 = 12;

@fragment
fn fs_main(in: Varyings) -> @location(0) vec4<f32> {
    let sigma = max(in.params.x, 0.01);
    let dir = vec2<i32>(i32(in.params.y), i32(in.params.z));
    let here = vec2<i32>(in.position.xy);
    let low = vec2<i32>(in.rect.xy);
    let high = vec2<i32>(in.rect.xy + in.rect.zw) - vec2<i32>(1, 1);
    let reach = min(i32(ceil(3.0 * sigma)), MAX_REACH);
    var sum = vec4<f32>(0.0);
    var total = 0.0;
    for (var k = -MAX_REACH; k <= MAX_REACH; k++) {
        if k < -reach || k > reach {
            continue;
        }
        let at = here + dir * k;
        let weight = exp(-f32(k * k) / (2.0 * sigma * sigma));
        total += weight;
        // Outside the region counts as empty.
        if all(at >= low) && all(at <= high) {
            sum += weight * textureLoad(source, at, 0);
        }
    }
    return sum / total;
}
