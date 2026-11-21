//! CSS timing functions, evaluated the way browsers evaluate them.

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Easing {
    Linear,
    /// `cubic-bezier(x1, y1, x2, y2)`.
    Bezier(f32, f32, f32, f32),
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
        }
    }
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
}
