//! Per-frame timings, split by what the frame was doing, recorded while profiling.
//!
//! `Renderer.takeProfile()` hands them out, and `tooling/bench-core-rs.ts` turns them into
//! percentiles. Off, which is the default, a lap is one branch.

use web_sys::Performance;

/// What a frame spends its time on, in the order it does it.
#[derive(Clone, Copy)]
pub enum Phase {
    /// Building lines, measuring them, and anything else queued for the next frame.
    Prepare,
    /// The clock, line states, autoscroll and the stage.
    Update,
    /// Drawing lines into textures and uploading them, when they come into view.
    Raster,
    /// Working out each visible line's quads.
    Paint,
    /// Moving the host's elements that ride along with the lines.
    Riders,
    /// Uploading the quads and issuing the draws: blur jobs, then the canvas.
    Submit,
    /// The rest: the frame's bookkeeping and the host's event listeners.
    Other,
}

pub const PHASES: [&str; 7] = ["prepare", "update", "raster", "paint", "riders", "submit", "other"];

/// About eighteen minutes at 60 Hz. Past it, frames are dropped until the profile is taken.
const MAX_FRAMES: usize = 1 << 16;

#[derive(Default)]
pub struct Profile {
    perf: Option<Performance>,
    start: f64,
    last: f64,
    current: [f64; PHASES.len()],
    /// Per frame, the total and then each phase, in milliseconds.
    frames: Vec<f32>,
}

impl Profile {
    pub fn set(&mut self, perf: Option<Performance>) {
        self.perf = perf;
        self.frames.clear();
    }

    pub fn begin(&mut self) {
        if let Some(perf) = &self.perf {
            let now = perf.now();
            self.start = now;
            self.last = now;
            self.current = [0.0; PHASES.len()];
        }
    }

    /// Charges the time since the last lap to `phase`.
    #[inline]
    pub fn lap(&mut self, phase: Phase) {
        if let Some(perf) = &self.perf {
            let now = perf.now();
            self.current[phase as usize] += now - self.last;
            self.last = now;
        }
    }

    pub fn end(&mut self) {
        if self.perf.is_none() {
            return;
        }
        self.lap(Phase::Other);
        if self.frames.len() < MAX_FRAMES * (PHASES.len() + 1) {
            self.frames.push((self.last - self.start) as f32);
            self.frames.extend(self.current.iter().map(|&ms| ms as f32));
        }
    }

    pub fn take(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.frames)
    }
}
