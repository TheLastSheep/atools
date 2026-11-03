//! Native requested-content geometry; passive viewport clipping never changes the request.
use tauri::{AppHandle, PhysicalPosition, PhysicalSize};

pub(super) fn requested_pixels(desired: f64, scale: f64) -> Result<u32, String> {
    super::settings_height_geometry::project(desired, scale).map(|value| value.physical_content)
}

/// Both creation and lease reflow use these already-physical, checked bounds.
pub(crate) fn settings_child_bounds(
    parent: PhysicalSize<u32>,
    scale: f64,
    header: u32,
    desired: f64,
) -> Result<(PhysicalPosition<i32>, PhysicalSize<u32>), String> {
    let height = requested_pixels(desired, scale)?;
    let top = (f64::from(header) * scale).round();
    if parent.width == 0
        || parent.width > i32::MAX as u32
        || !top.is_finite()
        || top < 1.0
        || top > f64::from(i32::MAX)
        || f64::from(parent.height) <= top
    {
        return Err("Settings child bounds exceed native geometry limits".into());
    }
    Ok((
        PhysicalPosition::new(0, top as i32),
        PhysicalSize::new(parent.width, height),
    ))
}

/// Validate representability before native create; locked Wry roundtrip preserves this target.
pub(crate) fn create_settings_child<T>(
    parent: PhysicalSize<u32>,
    scale: f64,
    header: u32,
    desired: f64,
    create: impl FnOnce(PhysicalPosition<i32>, PhysicalSize<u32>) -> Result<T, String>,
) -> Result<T, String> {
    let (position, size) = settings_child_bounds(parent, scale, header, desired)?;
    create(position, size)
}

pub(crate) fn validate_settings_content(app: &AppHandle, desired: f64) -> Result<(), String> {
    let scale = super::main_window(app)
        .map_err(|error| error.to_string())?
        .scale_factor()
        .map_err(|error| error.to_string())?;
    requested_pixels(desired, scale).map(|_| ())
}

pub(super) fn parent_request(desired: f64, scale: f64) -> Result<f64, String> {
    super::settings_height_geometry::project(desired, scale)
        .map(|value| value.logical_content + 58.0)
}

pub(crate) fn resize_settings_content(app: &AppHandle, desired: f64) -> Result<(), String> {
    // Resolve the projection using the scale read inside the actual parent resize plan.
    super::resize_main_window_height(app, super::HeightRequest::SettingsContent(desired))
        .map_err(|error| error.to_string())
}

pub(crate) fn resize_settings_content_on_window(
    app: &AppHandle,
    window: &tauri::Window,
    desired: f64,
) -> Result<(), String> {
    super::resize_window_height(app, window, super::HeightRequest::SettingsContent(desired))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requested_content_keeps_fractional_intent_and_rejects_overflow() {
        assert_eq!(
            requested_pixels(200.5, 2.0).unwrap(),
            if cfg!(target_os = "macos") { 402 } else { 401 }
        );
        assert_eq!(requested_pixels(2001.0, 1.0).unwrap(), 2001);
        for (height, scale) in [
            (f64::NAN, 1.0),
            (200.0, f64::INFINITY),
            (200.0, 0.0),
            (f64::MAX, 2.0),
            (f64::from(i32::MAX), 2.0),
        ] {
            assert!(requested_pixels(height, scale).is_err());
        }
    }
    #[test]
    fn physical_creation_has_one_checked_conversion_and_checks_width_and_header() {
        let parent = PhysicalSize::new(1000, 800);
        let mut creates = 0;
        let (position, size) = create_settings_child(parent, 1.5, 58, 2001.5, |position, size| {
            creates += 1;
            Ok((position, size))
        })
        .unwrap();
        assert_eq!(creates, 1);
        assert_eq!(position, PhysicalPosition::new(0, 87));
        assert_eq!(size, PhysicalSize::new(1000, 3002));
        for (width, scale, header) in [
            (u32::MAX, 1.0, 58),
            (1000, f64::MAX, 58),
            (1000, 1.0, u32::MAX),
        ] {
            assert!(create_settings_child(
                PhysicalSize::new(width, 800),
                scale,
                header,
                2001.5,
                |_, _| {
                    creates += 1;
                    Ok(())
                }
            )
            .is_err());
        }
        assert_eq!(creates, 1);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn mac_actual_creation_caller_must_request_representable_child_bounds() {
        let (_, size) = create_settings_child(
            PhysicalSize::new(1600, 518),
            2.0,
            58,
            200.5,
            |position, size| Ok((position, size)),
        )
        .unwrap();
        assert_eq!(size.height, 402);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn mac_actual_parent_request_must_match_projected_child_plus_header() {
        assert_eq!(parent_request(200.5, 2.0).unwrap(), 259.0);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn projected_logical_or_second_physical_overflow_is_rejected_before_native_create() {
        let mut creates = 0;
        for (desired, scale) in [(f64::from(i32::MAX) * 2.0, 0.25), (200.51, 10_710_000.0)] {
            assert!(create_settings_child(
                PhysicalSize::new(1000, i32::MAX as u32),
                scale,
                58,
                desired,
                |_, _| {
                    creates += 1;
                    Ok(())
                }
            )
            .is_err());
        }
        assert_eq!(creates, 0);
    }
}
