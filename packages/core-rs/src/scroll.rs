//! Autoscroll, as the DOM renderer did it: the scroll position jumps straight to its target and
//! every line in view glides from where it was drawn before the jump, each over a slightly different
//! time so the lines spread and settle like a list being pulled.

use crate::easing::Easing;

/// What autoscroll needs to know about one line.
#[derive(Clone, Copy, Debug)]
pub struct ScrollLine {
    pub start_s: f32,
    pub duration_s: f32,
    /// Top and height in scroll content coordinates.
    pub top: f32,
    pub height: f32,
    /// An instrumental break, which the credits do not wait for.
    pub instrumental: bool,
}

impl ScrollLine {
    fn end_s(&self) -> f32 {
        self.start_s + self.duration_s
    }
    fn centre(&self) -> f32 {
        self.top + self.height / 2.0
    }
}

/// A line's offset easing from `from` px back to zero.
#[derive(Clone, Copy, Debug)]
pub struct Curve {
    pub from: f32,
    pub start_ms: f64,
    pub duration_ms: f64,
    pub easing: Easing,
}

impl Curve {
    pub fn value(&self, now_ms: f64) -> f32 {
        let progress = ((now_ms - self.start_ms) / self.duration_ms).clamp(0.0, 1.0) as f32;
        self.from * (1.0 - self.easing.at(progress))
    }

    pub fn done(&self, now_ms: f64) -> bool {
        now_ms >= self.start_ms + self.duration_ms
    }
}

/// The sum of a line's running curves; finished ones are dropped.
pub fn offset(curves: &mut Vec<Curve>, now_ms: f64) -> f32 {
    curves.retain(|curve| !curve.done(now_ms));
    curves.iter().map(|curve| curve.value(now_ms)).sum()
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Viewport {
    pub height: f32,
    /// `scroll-padding` insets: the band active lines are kept inside.
    pub inset_top: f32,
    pub inset_bottom: f32,
    pub max_scroll: f32,
}

pub struct ScrollParams {
    pub ratio: f32,
    pub early_consider_s: f32,
    pub ending_threshold_s: f32,
}

#[derive(Default)]
pub struct AutoScroll {
    /// The lines the last committed scroll followed.
    committed: Vec<usize>,
    pinned: Option<usize>,
    credits_focused: bool,
    /// Set by anything that should re-target on the next tick: a relayout, a resume.
    pub force: bool,
    /// The scroll position autoscroll last wrote, so a reader's scroll can be told apart.
    pub last_written: Option<f32>,
}

pub struct Plan {
    pub to: f32,
    /// The line the scroll is centred on, which the stagger counts out from.
    pub lead: usize,
    /// Whether this scroll carries on from the previous one, which keeps the full stagger.
    pub continues: bool,
}

impl AutoScroll {
    pub fn reset(&mut self) {
        *self = AutoScroll { force: true, ..AutoScroll::default() };
    }

    /// The first line the last scroll followed.
    pub fn followed(&self) -> Option<usize> {
        self.committed.first().copied()
    }

    /// The first and last lines the last scroll followed.
    pub fn followed_range(&self) -> Option<(usize, usize)> {
        Some((*self.committed.iter().min()?, *self.committed.iter().max()?))
    }

    /// Carries the lines being followed over a swap, given where each old line went.
    pub fn remap(&mut self, new_index: impl Fn(usize) -> Option<usize>) {
        self.committed = self.committed.iter().filter_map(|&i| new_index(i)).collect();
        self.pinned = self.pinned.and_then(&new_index);
    }

    /// Lines in focus at scroll time `s`: from `early` before their start until the next line
    /// starts or they end, whichever is later.
    pub fn focused(lines: &[ScrollLine], s: f32, early: f32) -> Vec<usize> {
        (0..lines.len())
            .filter(|&i| {
                let line = &lines[i];
                let next_start = lines.get(i + 1).map(|n| n.start_s).unwrap_or(f32::INFINITY);
                s >= line.start_s - early && (s < next_start || s < line.end_s())
            })
            .collect()
    }

    /// Decides whether to scroll this tick and where to.
    #[allow(clippy::too_many_arguments)]
    pub fn tick(
        &mut self,
        lines: &[ScrollLine],
        credits: Option<ScrollLine>,
        s: f32,
        params: &ScrollParams,
        view: Viewport,
        scroll_top: f32,
        jumped: bool,
    ) -> Option<Plan> {
        if lines.is_empty() {
            return None;
        }
        let focused = Self::focused(lines, s, params.early_consider_s);
        let reached_new = focused.iter().any(|&i| s >= lines[i].start_s && !self.committed.contains(&i));
        let followed: Vec<usize> = if focused.is_empty() { vec![0] } else { focused };
        let lead = *followed.last().unwrap();

        // The credits take the focus once the last line with words is over, during any closing
        // instrumental, as the DOM renderer did.
        let last_sung = lines.iter().rposition(|l| !l.instrumental);
        let credits_focused =
            credits.is_some_and(|c| c.height > 0.0) && last_sung.is_some_and(|i| s >= lines[i].end_s());
        let credits_changed = credits_focused != self.credits_focused;

        let sung: Vec<usize> = followed
            .iter()
            .copied()
            .filter(|&i| i == lead || s < lines[i].end_s() - params.ending_threshold_s)
            .collect();
        let pinned_finished = self.pinned.is_some_and(|p| !sung.contains(&p) || s >= lines[p].end_s());

        let must_commit = jumped || reached_new || credits_changed || pinned_finished || self.force;
        if !must_commit {
            return None;
        }
        self.force = false;
        self.credits_focused = credits_focused;
        self.committed = followed.clone();

        let target_offset = view.height * params.ratio;
        let visible_bottom = view.height - view.inset_bottom;
        let clamp_to = |scroll: f32, line: &ScrollLine| {
            scroll.max(line.top + line.height - visible_bottom).min(line.top - view.inset_top)
        };
        let anchor = sung
            .iter()
            .rev()
            .copied()
            .find(|&i| lines[i].start_s <= s && s < lines[i].end_s())
            .or_else(|| sung.iter().rev().copied().find(|&i| lines[i].start_s <= s))
            .unwrap_or(sung[0]);
        let first = &lines[sung[0]];
        let last = &lines[*sung.last().unwrap()];
        let average = sung.iter().map(|&i| lines[i].centre()).sum::<f32>() / sung.len() as f32;
        let mut target = clamp_to(average - target_offset, last);
        target = target.min(first.top - view.inset_top);
        target = clamp_to(target, &lines[anchor]);
        let overflows = last.top + last.height - first.top > visible_bottom - view.inset_top;
        self.pinned = overflows.then_some(anchor);
        if let (true, Some(credits)) = (credits_focused, credits) {
            let last_top = last_sung.map(|i| lines[i].top).unwrap_or(credits.top);
            target = (credits.centre() - target_offset).min(last_top - view.inset_top);
        }
        let to = target.clamp(0.0, view.max_scroll.max(0.0));
        let continues = !jumped && self.last_written.is_some_and(|w| (w - scroll_top).abs() <= 2.0);
        if (to - scroll_top).abs() <= 2.0 {
            return None;
        }
        Some(Plan { to, lead, continues })
    }
}

/// How long line `index` takes to settle, counted from the lead line. Lines ahead of the motion move
/// a little faster than the lead, lines behind it a little slower, so they drift apart and settle.
pub fn line_duration_ms(index: usize, lead: usize, delta: f32, differential: bool) -> f64 {
    let r = index as i64 - lead as i64;
    let k = r.unsigned_abs() as f64;
    let shared = |k: f64| 750.0 + (k + 2.0).ln() * 80.0 + (k + 1.0) * 20.0;
    if r == 0 || !differential {
        return shared(k);
    }
    let ahead = (r < 0) == (delta > 0.0);
    if ahead {
        750.0 + k.min(6.0) * 20.0
    } else {
        shared(k)
    }
}

/// Adds a glide to every line the scroll moves through view. `tops` are scroll content positions.
#[allow(clippy::too_many_arguments)]
pub fn start_glides(
    curves: &mut [Vec<Curve>],
    tops: &[(f32, f32)],
    plan: &Plan,
    from: f32,
    view_height: f32,
    now_ms: f64,
    easing: Easing,
    differential: bool,
) {
    let delta = plan.to - from;
    let band_top = from.min(plan.to);
    let band_bottom = from.max(plan.to) + view_height;
    let active = line_duration_ms(plan.lead, plan.lead, delta, differential);
    // A big jump squeezes every duration toward the lead's so lines do not overtake each other.
    let squeeze = if plan.continues {
        1.0
    } else {
        let lead_top = tops.get(plan.lead).map(|t| t.0).unwrap_or(0.0);
        let neighbours = [plan.lead.checked_sub(1), Some(plan.lead + 1)];
        let step = neighbours
            .iter()
            .flatten()
            .filter_map(|&i| tops.get(i))
            .map(|t| (t.0 - lead_top).abs())
            .fold(f32::INFINITY, f32::min);
        let step = if step.is_finite() { step } else { tops.get(plan.lead).map(|t| t.1).unwrap_or(1.0) };
        (step / delta.abs().max(1e-3)).min(1.0) as f64
    };
    for (index, (top, height)) in tops.iter().enumerate() {
        if top + height < band_top || *top > band_bottom {
            continue;
        }
        let own = line_duration_ms(index, plan.lead, delta, differential);
        let duration = active + (own - active) * squeeze;
        curves[index].push(Curve { from: delta, start_ms: now_ms, duration_ms: duration.max(1.0), easing });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(start: f32, top: f32) -> ScrollLine {
        ScrollLine { start_s: start, duration_s: 2.0, top, height: 100.0, instrumental: false }
    }

    #[test]
    fn durations_match_the_dom_renderer() {
        assert!((line_duration_ms(5, 5, 100.0, true) - 825.45).abs() < 0.01);
        assert!((line_duration_ms(6, 5, 100.0, true) - 877.89).abs() < 0.01);
        assert_eq!(line_duration_ms(4, 5, 100.0, true), 770.0);
        assert_eq!(line_duration_ms(0, 8, 100.0, true), 870.0);
    }

    #[test]
    fn one_line_lands_on_the_target_ratio() {
        let lines = [line(0.0, 0.0), line(2.0, 100.0), line(4.0, 200.0), line(6.0, 300.0)];
        let mut scroll = AutoScroll::default();
        let params = ScrollParams { ratio: 0.5, early_consider_s: 0.54, ending_threshold_s: 0.5 };
        let view = Viewport { height: 200.0, inset_top: 0.0, inset_bottom: 0.0, max_scroll: 1000.0 };
        let plan = scroll.tick(&lines, None, 4.0, &params, view, 0.0, false).expect("scrolls");
        // Line 2's centre (250) lands at half the view (100).
        assert_eq!(plan.to, 150.0);
        assert_eq!(plan.lead, 2);
        // Nothing new: no second scroll.
        assert!(scroll.tick(&lines, None, 4.1, &params, view, 150.0, false).is_none());
    }

    #[test]
    fn credits_take_the_focus_during_a_closing_instrumental() {
        let outro = ScrollLine { start_s: 2.0, duration_s: 6.0, top: 100.0, height: 100.0, instrumental: true };
        let lines = [line(0.0, 0.0), outro];
        let credits =
            ScrollLine { start_s: f32::INFINITY, duration_s: 0.0, top: 400.0, height: 100.0, instrumental: false };
        let params = ScrollParams { ratio: 0.5, early_consider_s: 0.54, ending_threshold_s: 0.5 };
        let view = Viewport { height: 200.0, inset_top: 0.0, inset_bottom: 0.0, max_scroll: 1000.0 };
        // The last line with words ended at 2s and the instrumental runs to 8s, but the credits lead,
        // held so the last sung line keeps its top in view.
        let mut far = AutoScroll::default();
        let lines = [ScrollLine { top: 500.0, ..lines[0] }, ScrollLine { top: 600.0, ..lines[1] }];
        let credits = ScrollLine { top: 900.0, ..credits };
        let plan = far.tick(&lines, Some(credits), 3.0, &params, view, 0.0, false).expect("scrolls");
        assert_eq!(plan.to, 500.0, "credits centred would be 850, held at the last sung line's top");
    }

    #[test]
    fn curves_add_and_expire() {
        let mut curves = vec![
            Curve { from: 100.0, start_ms: 0.0, duration_ms: 100.0, easing: Easing::Linear },
            Curve { from: 50.0, start_ms: 50.0, duration_ms: 100.0, easing: Easing::Linear },
        ];
        assert_eq!(offset(&mut curves, 50.0), 100.0);
        assert_eq!(offset(&mut curves, 200.0), 0.0);
        assert!(curves.is_empty());
    }
}
