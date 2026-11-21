//! The stage layout: only what is being sung, bottom-anchored, for subtitles over video.
//!
//! The current line sits on the floor of the stage. A line it overlaps stays visible above it until
//! it ends, and the next line rises from just below the floor when its turn comes.

use crate::easing::Easing;

const LEAD_S: f32 = 0.5;
const HANDOFF_S: f32 = 0.12;
const OVERLAP_S: f32 = 0.15;
/// The gap between stacked lines, in container font sizes.
pub const GAP_EM: f32 = 0.32;
pub const MOVE_MS: f64 = 380.0;
pub const MOVE_EASING: Easing = Easing::Bezier(0.2, 0.0, 0.0, 1.0);
pub const SHOW_MS: f64 = 300.0;
pub const SHOW_DELAY_MS: f64 = 70.0;
pub const HIDE_MS: f64 = 220.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Line,
    Instrumental,
    Blank,
    Credits,
}

#[derive(Clone, Copy, Debug)]
pub struct Item {
    pub kind: Kind,
    pub start: f32,
    pub end: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Gone,
    Previous,
    Current,
    Queued,
}

fn overlaps_previous(items: &[Item], i: usize) -> bool {
    i > 0
        && items[i - 1].kind == Kind::Line
        && items[i].kind != Kind::Blank
        && items[i].start < items[i - 1].end - OVERLAP_S
}

/// When item `i` takes the stage.
fn enter(items: &[Item], i: usize) -> f32 {
    let item = items[i];
    let prev = i.checked_sub(1).map(|p| items[p]);
    match prev {
        Some(p) if item.kind == Kind::Credits && p.kind == Kind::Instrumental => (p.start + p.end) / 2.0,
        Some(p) if p.kind == Kind::Line && !overlaps_previous(items, i) => {
            (item.start - LEAD_S).max(p.end.min(item.start) - HANDOFF_S)
        }
        _ => item.start - LEAD_S,
    }
}

/// Every item's role at lyric time `t`.
pub fn roles(items: &[Item], t: f32) -> Vec<Role> {
    let current = (0..items.len()).rev().find(|&i| enter(items, i) <= t);
    (0..items.len())
        .map(|i| match current {
            None => Role::Queued,
            Some(c) if i < c => {
                let prev_still_sung =
                    i + 1 == c && items[i].kind == Kind::Line && overlaps_previous(items, c) && t < items[i].end;
                if prev_still_sung {
                    Role::Previous
                } else {
                    Role::Gone
                }
            }
            Some(c) if i > c => Role::Queued,
            _ => Role::Current,
        })
        .collect()
}

/// Where each item rests for its role: (y, visible).
pub fn targets(roles: &[Role], heights: &[f32], stage_height: f32, gap: f32, last_y: &[f32]) -> Vec<(f32, bool)> {
    let current = roles.iter().position(|r| *r == Role::Current);
    let current_y = current.map(|c| stage_height - heights[c]).unwrap_or(stage_height);
    roles
        .iter()
        .enumerate()
        .map(|(i, role)| match role {
            Role::Current => (current_y, true),
            Role::Previous => (current_y - gap - heights[i], true),
            Role::Queued => (stage_height - heights[i] + gap, false),
            Role::Gone => (last_y.get(i).copied().unwrap_or(current_y), false),
        })
        .collect()
}

/// A line's motion on the stage: an eased move between rests and a fade.
#[derive(Clone, Copy, Debug)]
pub struct Motion {
    pub from_y: f32,
    pub to_y: f32,
    pub moved_ms: f64,
    pub visible: bool,
    pub from_opacity: f32,
    pub faded_ms: f64,
}

impl Motion {
    pub fn at_rest(y: f32, visible: bool) -> Motion {
        Motion {
            from_y: y,
            to_y: y,
            moved_ms: f64::NEG_INFINITY,
            visible,
            from_opacity: if visible { 1.0 } else { 0.0 },
            faded_ms: f64::NEG_INFINITY,
        }
    }

    pub fn y(&self, now_ms: f64) -> f32 {
        let t = ((now_ms - self.moved_ms) / MOVE_MS) as f32;
        self.from_y + (self.to_y - self.from_y) * MOVE_EASING.at(t)
    }

    pub fn opacity(&self, now_ms: f64) -> f32 {
        if self.visible {
            let t = ((now_ms - self.faded_ms - SHOW_DELAY_MS) / SHOW_MS) as f32;
            self.from_opacity + (1.0 - self.from_opacity) * Easing::EASE_OUT.at(t)
        } else {
            let t = ((now_ms - self.faded_ms) / HIDE_MS) as f32;
            self.from_opacity * (1.0 - Easing::EASE.at(t))
        }
    }

    pub fn moving(&self, now_ms: f64) -> bool {
        now_ms - self.moved_ms < MOVE_MS || now_ms - self.faded_ms < SHOW_DELAY_MS + SHOW_MS
    }

    /// Heads for a new rest. A line coming into view rises from where it was queued; `instant`
    /// (a seek, reduced motion) skips the motion.
    pub fn retarget(&mut self, y: f32, visible: bool, now_ms: f64, instant: bool) {
        if instant {
            *self = Motion::at_rest(y, visible);
            return;
        }
        if (y - self.to_y).abs() > 0.01 {
            self.from_y = self.y(now_ms);
            self.to_y = y;
            self.moved_ms = now_ms;
        }
        if visible != self.visible {
            self.from_opacity = self.opacity(now_ms);
            self.visible = visible;
            self.faded_ms = now_ms;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(start: f32, end: f32) -> Item {
        Item { kind: Kind::Line, start, end }
    }

    #[test]
    fn the_next_line_takes_over_half_a_second_early() {
        let items = [line(0.0, 2.0), line(2.0, 4.0)];
        assert_eq!(roles(&items, 1.0), [Role::Current, Role::Queued]);
        assert_eq!(roles(&items, 1.9), [Role::Gone, Role::Current]);
    }

    #[test]
    fn an_overlapped_line_stays_above_until_it_ends() {
        let items = [line(0.0, 3.0), line(2.0, 4.0)];
        assert_eq!(roles(&items, 2.5), [Role::Previous, Role::Current]);
        assert_eq!(roles(&items, 3.1), [Role::Gone, Role::Current]);
        let rests = targets(&roles(&items, 2.5), &[50.0, 40.0], 200.0, 10.0, &[]);
        assert_eq!(rests, [(100.0, true), (160.0, true)]);
    }
}
