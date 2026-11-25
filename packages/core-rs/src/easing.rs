//! CSS timing functions, evaluated the way browsers evaluate them.

use std::cell::RefCell;

/// A `linear()` curve's (input, output) stops.
type Stops = Box<[(f32, f32)]>;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Easing {
    Linear,
    /// `cubic-bezier(x1, y1, x2, y2)`.
    Bezier(f32, f32, f32, f32),
    /// `linear(...)` with its stops, by their index in [`STOPS`], which keeps `Easing` `Copy`.
    Stops(u32),
}

thread_local! {
    /// Every distinct `linear()` curve read so far, as (input, output) stops with the inputs
    /// filled in and in order. A theme has a handful, and rereading one finds it again, so this
    /// stays small.
    static STOPS: RefCell<Vec<Stops>> = const { RefCell::new(Vec::new()) };
}

impl Easing {
    pub const EASE: Easing = Easing::Bezier(0.25, 0.1, 0.25, 1.0);
    pub const EASE_IN: Easing = Easing::Bezier(0.42, 0.0, 1.0, 1.0);
    pub const EASE_OUT: Easing = Easing::Bezier(0.0, 0.0, 0.58, 1.0);
    pub const EASE_IN_OUT: Easing = Easing::Bezier(0.42, 0.0, 0.58, 1.0);

    /// Reads a CSS timing function. Anything it does not understand is `ease`, which is what the
    /// browser would fall back to for an invalid value too.
    pub fn parse(text: &str) -> Easing {
        let text = text.trim();
        match text {
            "linear" => return Easing::Linear,
            "ease" | "" => return Easing::EASE,
            "ease-in" => return Easing::EASE_IN,
            "ease-out" => return Easing::EASE_OUT,
            "ease-in-out" => return Easing::EASE_IN_OUT,
            _ => {}
        }
        if let Some(args) = text.strip_prefix("linear(").and_then(|rest| rest.strip_suffix(')')) {
            return linear_stops(args).map(intern).unwrap_or(Easing::EASE);
        }
        if let Some(args) = text.strip_prefix("cubic-bezier(").and_then(|rest| rest.strip_suffix(')')) {
            let numbers: Vec<f32> = args.split(',').filter_map(|n| n.trim().parse().ok()).collect();
            if numbers.len() == 4 {
                return Easing::Bezier(numbers[0].clamp(0.0, 1.0), numbers[1], numbers[2].clamp(0.0, 1.0), numbers[3]);
            }
        }
        Easing::EASE
    }

    /// Eased progress for linear progress `t`, clamped to 0..1 on the way in.
    pub fn at(self, t: f32) -> f32 {
        let t = t.clamp(0.0, 1.0);
        match self {
            Easing::Linear => t,
            Easing::Bezier(x1, y1, x2, y2) => {
                if t == 0.0 || t == 1.0 {
                    return t;
                }
                let s = solve_bezier_x(t, x1, x2);
                bezier(s, y1, y2)
            }
            Easing::Stops(index) => STOPS.with(|all| {
                let all = all.borrow();
                let Some(stops) = all.get(index as usize) else { return t };
                // As CSS does: the segment from the last stop at or before `t`, the first or last
                // segment carried on outside the stops (at 0 and 1 too, as an animation that fills
                // forwards holds it), and a jump's later value at a repeated input.
                let a = stops.partition_point(|&(x, _)| x <= t).saturating_sub(1).min(stops.len() - 2);
                let ((x0, y0), (x1, y1)) = (stops[a], stops[a + 1]);
                if x1 == x0 {
                    return y1;
                }
                y0 + (y1 - y0) * (t - x0) / (x1 - x0)
            }),
        }
    }
}

fn intern(stops: Vec<(f32, f32)>) -> Easing {
    STOPS.with(|all| {
        let mut all = all.borrow_mut();
        let index = all.iter().position(|known| **known == stops[..]).unwrap_or_else(|| {
            all.push(stops.into());
            all.len() - 1
        });
        Easing::Stops(index as u32)
    })
}

/// The stops of `linear(args)`, with their inputs as CSS fills them in: a stop with two
/// percentages is two stops, the first and last default to 0% and 100%, an input below an earlier
/// one is raised to it, and the inputs still missing are spread evenly between their neighbours.
fn linear_stops(args: &str) -> Option<Vec<(f32, f32)>> {
    let mut stops: Vec<(f32, Option<f32>)> = Vec::new();
    for arg in args.split(',') {
        let mut output = None;
        let mut inputs = Vec::new();
        for token in arg.split_whitespace() {
            if let Some(percent) = token.strip_suffix('%') {
                inputs.push(percent.parse::<f32>().ok().filter(|v| v.is_finite())? / 100.0);
            } else if output.is_none() {
                output = Some(token.parse::<f32>().ok().filter(|v| v.is_finite())?);
            } else {
                return None;
            }
        }
        let output = output?;
        match inputs[..] {
            [] => stops.push((output, None)),
            [x] => stops.push((output, Some(x))),
            [a, b] => stops.extend([(output, Some(a)), (output, Some(b))]),
            _ => return None,
        }
    }
    if stops.len() < 2 {
        return None;
    }
    let last = stops.len() - 1;
    stops[0].1.get_or_insert(0.0);
    stops[last].1.get_or_insert(1.0);
    let mut highest = f32::NEG_INFINITY;
    for stop in &mut stops {
        if let Some(x) = &mut stop.1 {
            *x = x.max(highest);
            highest = *x;
        }
    }
    let mut i = 0;
    while i < last {
        let start = i;
        i += 1;
        while stops[i].1.is_none() {
            i += 1;
        }
        let (from, to) = (stops[start].1.unwrap_or(0.0), stops[i].1.unwrap_or(1.0));
        let gap = (i - start) as f32;
        for (k, stop) in stops[start + 1..i].iter_mut().enumerate() {
            stop.1 = Some(from + (to - from) * (k + 1) as f32 / gap);
        }
    }
    Some(stops.into_iter().map(|(y, x)| (x.unwrap_or(0.0), y)).collect())
}

fn bezier(s: f32, p1: f32, p2: f32) -> f32 {
    let inv = 1.0 - s;
    3.0 * inv * inv * s * p1 + 3.0 * inv * s * s * p2 + s * s * s
}

fn bezier_slope(s: f32, p1: f32, p2: f32) -> f32 {
    let inv = 1.0 - s;
    3.0 * inv * inv * p1 + 6.0 * inv * s * (p2 - p1) + 3.0 * s * s * (1.0 - p2)
}

/// The curve parameter whose x is `x`: Newton's method, falling back to bisection where the slope
/// flattens out.
fn solve_bezier_x(x: f32, x1: f32, x2: f32) -> f32 {
    let mut s = x;
    for _ in 0..8 {
        let error = bezier(s, x1, x2) - x;
        if error.abs() < 1e-5 {
            return s;
        }
        let slope = bezier_slope(s, x1, x2);
        if slope.abs() < 1e-6 {
            break;
        }
        s -= error / slope;
    }
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    s = x;
    for _ in 0..24 {
        let value = bezier(s, x1, x2);
        if (value - x).abs() < 1e-5 {
            break;
        }
        if value < x {
            lo = s;
        } else {
            hi = s;
        }
        s = (lo + hi) * 0.5;
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ease_matches_reference_points() {
        // Reference values from the CSS cubic-bezier(0.25, 0.1, 0.25, 1) at x = 0.5.
        assert!((Easing::EASE.at(0.5) - 0.8024).abs() < 1e-3);
        assert_eq!(Easing::EASE.at(0.0), 0.0);
        assert_eq!(Easing::EASE.at(1.0), 1.0);
        assert_eq!(Easing::Linear.at(0.3), 0.3);
    }

    #[test]
    fn parses_cubic_bezier() {
        assert_eq!(Easing::parse("cubic-bezier(0.86, 0, 0.2, 1)"), Easing::Bezier(0.86, 0.0, 0.2, 1.0));
        assert_eq!(Easing::parse("nonsense"), Easing::EASE);
    }

    #[test]
    fn linear_fills_in_its_stops_like_css() {
        let close = |a: f32, b: f32| (a - b).abs() < 1e-5;
        // Evenly spread inputs, and a value past 1 for an overshoot.
        let spring = Easing::parse("linear(0, 1.2, 1)");
        assert!(close(spring.at(0.25), 0.6) && close(spring.at(0.5), 1.2) && close(spring.at(0.75), 1.1));
        // A stop with two percentages holds its value between them.
        let hold = Easing::parse("linear(0, 0.5 25% 75%, 1)");
        assert!(close(hold.at(0.5), 0.5) && close(hold.at(0.125), 0.25) && close(hold.at(0.875), 0.75));
        // An input below an earlier one is raised to it: a jump.
        let jump = Easing::parse("linear(0, 0 50%, 1 20%, 1)");
        assert!(close(jump.at(0.49), 0.0) && close(jump.at(0.5), 1.0));
        // The missing input between 0% and 80% lands halfway.
        let gap = Easing::parse("linear(0, 0.5, 1 80%, 1)");
        assert!(close(gap.at(0.4), 0.5) && close(gap.at(0.9), 1.0));
        // Outside its first and last stops, the curve carries on along its end segments.
        let inset = Easing::parse("linear(0 20%, 1 80%)");
        assert!(close(inset.at(0.1), -1.0 / 6.0) && close(inset.at(0.9), 7.0 / 6.0) && close(inset.at(0.5), 0.5));
        // ...as Chrome gives it at the ends too.
        assert!(close(inset.at(0.0), -1.0 / 3.0) && close(inset.at(1.0), 4.0 / 3.0));
        // Rereading a curve finds the same one; nonsense is ease.
        assert_eq!(Easing::parse("linear(0, 1.2, 1)"), spring);
        assert_eq!(Easing::parse("linear(1)"), Easing::EASE);
        assert_eq!(Easing::parse("linear(0, x, 1)"), Easing::EASE);
    }
}
