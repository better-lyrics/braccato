//! Turns a coarse, jittery playback position into one that advances smoothly every frame.
//!
//! Media elements report `currentTime` at the audio pipeline's pace, which on some engines is every
//! 10 to 20 ms and on others drifts against the display. Drawn at 240 Hz that jitter would make the
//! sweep shudder. The clock instead runs on the frame timestamps at the playback rate and is nudged
//! toward each new report, snapping only when they disagree by more than a seek would.

/// A disagreement larger than this is a seek, not drift.
const JUMP_S: f64 = 0.5;
/// How much of the remaining error each new report removes.
const CORRECTION: f64 = 0.15;
/// A stale report is carried forward at most this far.
const MAX_CARRY_S: f64 = 0.25;

#[derive(Default)]
pub struct Clock {
    smoothed: f64,
    last_frame_ms: Option<f64>,
    last_report: f64,
    last_report_ms: f64,
    was_playing: bool,
}

pub struct Reading {
    pub time_s: f64,
    /// The time moved further than playback could have carried it: a seek.
    pub jumped: bool,
}

impl Clock {
    /// Advances to frame time `now_ms` given the latest report.
    pub fn sample(&mut self, reported_s: f64, playing: bool, rate: f64, now_ms: f64) -> Reading {
        let rate = if rate.is_finite() && rate > 0.0 { rate } else { 1.0 };
        let primed = self.last_frame_ms.is_some();
        let elapsed_s = self.last_frame_ms.map(|last| ((now_ms - last) / 1000.0).max(0.0)).unwrap_or(0.0);
        self.last_frame_ms = Some(now_ms);

        let changed = reported_s != self.last_report;
        let mut jumped = false;
        if !playing || !self.was_playing {
            jumped = primed && (reported_s - self.smoothed).abs() > JUMP_S;
            self.smoothed = reported_s;
        } else {
            let predicted = self.smoothed + elapsed_s * rate;
            if changed {
                // Where the report would be now, had it been read this instant.
                let error = reported_s - predicted;
                if error.abs() > JUMP_S {
                    jumped = true;
                    self.smoothed = reported_s;
                } else {
                    self.smoothed = predicted + error * CORRECTION;
                }
            } else {
                // No new report: keep running, but not unboundedly past the last one.
                let limit =
                    self.last_report + ((now_ms - self.last_report_ms) / 1000.0).min(MAX_CARRY_S) * rate + MAX_CARRY_S;
                self.smoothed = predicted.min(limit);
            }
        }
        if changed {
            self.last_report = reported_s;
            self.last_report_ms = now_ms;
        }
        self.was_playing = playing;
        Reading { time_s: self.smoothed, jumped }
    }

    pub fn reset(&mut self) {
        *self = Clock::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_smoothly_between_coarse_reports() {
        let mut clock = Clock::default();
        clock.sample(10.0, true, 1.0, 0.0);
        clock.sample(10.0, true, 1.0, 0.0);
        // Reports every 20ms, frames every ~4ms.
        let mut last = 10.0;
        for frame in 1..100 {
            let now = frame as f64 * 4.166;
            let report = 10.0 + ((now / 20.0).floor() * 20.0) / 1000.0;
            let reading = clock.sample(report, true, 1.0, now);
            assert!(reading.time_s >= last, "never runs backwards");
            assert!(!reading.jumped);
            last = reading.time_s;
        }
        assert!((last - (10.0 + 99.0 * 4.166 / 1000.0)).abs() < 0.03);
    }

    #[test]
    fn a_seek_snaps() {
        let mut clock = Clock::default();
        clock.sample(10.0, true, 1.0, 0.0);
        clock.sample(10.0, true, 1.0, 16.0);
        let reading = clock.sample(40.0, true, 1.0, 32.0);
        assert!(reading.jumped);
        assert_eq!(reading.time_s, 40.0);
    }
}
