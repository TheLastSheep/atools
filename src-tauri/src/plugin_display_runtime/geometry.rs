//! AppKit global points are already logical points, independently of each screen's scale.
use serde::Serialize;
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub(super) struct Point {
    pub x: f64,
    pub y: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub(super) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub(super) struct Size {
    pub width: f64,
    pub height: f64,
}
impl Rect {
    pub fn validate(self) -> Result<Self, String> {
        if ![
            self.x,
            self.y,
            self.width,
            self.height,
            self.x + self.width,
            self.y + self.height,
        ]
        .into_iter()
        .all(f64::is_finite)
            || self.width <= 0.0
            || self.height <= 0.0
        {
            return Err("Invalid native display geometry".into());
        }
        Ok(self)
    }
    pub fn size(self) -> Size {
        Size {
            width: self.width,
            height: self.height,
        }
    }
}
pub(super) fn top_left_rect(cocoa: Rect, primary_top: f64) -> Result<Rect, String> {
    cocoa.validate()?;
    Rect {
        x: cocoa.x,
        y: primary_top - cocoa.y - cocoa.height,
        ..cocoa
    }
    .validate()
}
pub(super) fn top_left_point(cocoa: Point, primary_top: f64) -> Result<Point, String> {
    let point = Point {
        x: cocoa.x,
        y: primary_top - cocoa.y,
    };
    if !point.x.is_finite() || !point.y.is_finite() {
        return Err("Invalid native cursor point".into());
    }
    Ok(point)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn top_left_preserves_negative_origins_and_does_not_apply_a_scale() {
        let primary_top = 900.0;
        let primary = Rect {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        };
        assert_eq!(top_left_rect(primary, primary_top).unwrap(), primary);
        let left = Rect {
            x: -1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        assert_eq!(
            top_left_rect(left, primary_top).unwrap(),
            Rect {
                x: -1920.0,
                y: -180.0,
                ..left
            }
        );
        let above = Rect {
            x: 200.0,
            y: 900.0,
            width: 1080.0,
            height: 1920.0,
        };
        assert_eq!(
            top_left_rect(above, primary_top).unwrap(),
            Rect {
                y: -1920.0,
                ..above
            }
        );
        assert_eq!(
            top_left_point(
                Point {
                    x: -1700.0,
                    y: 950.0
                },
                primary_top
            )
            .unwrap(),
            Point {
                x: -1700.0,
                y: -50.0
            }
        );
    }
    #[test]
    fn work_area_preserves_dock_menu_insets_and_rotated_dimensions() {
        let work = Rect {
            x: -1080.0,
            y: 48.0,
            width: 1080.0,
            height: 1847.0,
        };
        assert_eq!(
            top_left_rect(work, 900.0).unwrap(),
            Rect { y: -995.0, ..work }
        );
        assert_eq!(
            work.size(),
            Size {
                width: 1080.0,
                height: 1847.0
            }
        );
    }
    #[test]
    fn nonfinite_and_empty_native_geometry_is_rejected() {
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(top_left_rect(
                Rect {
                    x: value,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0
                },
                900.0
            )
            .is_err());
            assert!(top_left_point(Point { x: 0.0, y: value }, 900.0).is_err());
        }
        assert!(top_left_rect(
            Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 1.0
            },
            900.0
        )
        .is_err());
        assert!(top_left_rect(
            Rect {
                x: f64::MAX,
                y: 0.0,
                width: f64::MAX,
                height: 1.0
            },
            900.0
        )
        .is_err());
        assert!(top_left_point(Point { x: 0.0, y: 0.0 }, f64::NAN).is_err());
    }
}
