//! Explicit Settings layout projection; desired persistence/cache values stay untouched.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Projection {
    pub logical_content: f64,
    pub physical_content: u32,
}
fn checked_pixel(value: f64) -> Result<u32, String> {
    if !value.is_finite() || value.round() < 1.0 || value.round() > f64::from(i32::MAX) {
        return Err("Settings requested content height exceeds native geometry limits".into());
    }
    Ok(value.round() as u32)
}
pub(super) fn project(desired: f64, scale: f64) -> Result<Projection, String> {
    project_for_platform(desired, scale, cfg!(target_os = "macos"))
}
fn project_for_platform(
    desired: f64,
    scale: f64,
    whole_logical: bool,
) -> Result<Projection, String> {
    if !desired.is_finite() || desired < 200.0 || !scale.is_finite() || scale <= 0.0 {
        return Err("Settings requested content height exceeds native geometry limits".into());
    }
    let pixels = checked_pixel(desired * scale)?;
    if !whole_logical {
        return Ok(Projection {
            logical_content: desired,
            physical_content: pixels,
        });
    }
    // Locked Wry macOS create(u32)/set_bounds(i32) both use integer logical dimensions.
    let logical = (f64::from(pixels) / scale).round();
    if !logical.is_finite() || logical < 1.0 || logical > f64::from(i32::MAX) {
        return Err(
            "Settings projected logical content height exceeds native geometry limits".into(),
        );
    }
    Ok(Projection {
        logical_content: logical,
        physical_content: checked_pixel(logical * scale)?,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mac_fractional_and_default_layouts_have_exact_representable_targets() {
        for (d, s, q, p) in [
            (200.5, 2.0, 201.0, 402),
            (200.5, 1.5, 201.0, 302),
            (541.0, 2.0, 541.0, 1082),
            (542.0, 2.0, 542.0, 1084),
            (2001.0, 1.5, 2001.0, 3002),
            (2001.0, 2.0, 2001.0, 4002),
        ] {
            assert_eq!(
                project_for_platform(d, s, true).unwrap(),
                Projection {
                    logical_content: q,
                    physical_content: p
                }
            );
        }
        assert_eq!(
            project_for_platform(200.5, 2.0, false).unwrap(),
            Projection {
                logical_content: 200.5,
                physical_content: 401
            }
        );
    }
    #[test]
    fn all_projection_stages_reject_nonfinite_or_unrepresentable_values() {
        for (d, s) in [
            (199.9, 2.0),
            (f64::NAN, 1.0),
            (200.0, 0.0),
            (200.0, -1.0),
            (200.0, f64::INFINITY),
            (f64::MAX, 2.0),
            (f64::from(i32::MAX), 2.0),
            (f64::from(i32::MAX) * 2.0, 0.25),
            (200.51, 10_710_000.0),
        ] {
            assert!(project_for_platform(d, s, true).is_err(), "{d}/{s}");
        }
    }
}
