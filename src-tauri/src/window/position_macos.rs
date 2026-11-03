use std::collections::HashSet;

use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::display::{CGDirectDisplayID, CGDisplay};
use core_graphics::window::{
    copy_window_info, kCGNullWindowID, kCGWindowAlpha, kCGWindowBounds, kCGWindowLayer,
    kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowOwnerPID,
};
use objc2::rc::autoreleasepool;
use objc2_app_kit::NSWorkspace;
use tauri::{AppHandle, Monitor, PhysicalPosition};

const MAX_DISPLAY_COUNT: usize = 32;
const MAX_WINDOW_SCAN_COUNT: isize = 4096;

#[derive(Clone, Copy)]
struct DisplayGeometry {
    display_id: CGDirectDisplayID,
    bounds: LogicalBounds,
}

#[derive(Clone, Copy)]
struct LogicalBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl LogicalBounds {
    fn contains(self, point: LogicalPoint) -> bool {
        point.x >= self.x
            && point.y >= self.y
            && point.x < self.x + self.width
            && point.y < self.y + self.height
    }

    fn is_valid(self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
            && self.width > 0.0
            && self.height > 0.0
            && (self.x + self.width).is_finite()
            && (self.y + self.height).is_finite()
    }
}

#[derive(Clone, Copy)]
struct LogicalPoint {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy)]
struct TaoMonitorGeometry<'a> {
    name: Option<&'a str>,
    position: PhysicalPosition<i32>,
    scale_factor: f64,
}

pub(super) fn monitor_for_frontmost_external_window(app: &AppHandle) -> Option<Monitor> {
    let owner_pid = frontmost_external_pid()?;
    let center = frontmost_window_center(owner_pid)?;
    let displays = display_geometries()?;
    let display = unique_display_for_point(center, &displays)?;
    unique_tao_monitor_for_display(display, app.available_monitors().ok()?)
}

fn frontmost_external_pid() -> Option<i32> {
    autoreleasepool(|_| {
        let application = NSWorkspace::sharedWorkspace().frontmostApplication()?;
        let pid = application.processIdentifier();
        if pid <= 0 || pid as u32 == std::process::id() {
            return None;
        }
        Some(pid)
    })
}

fn frontmost_window_center(owner_pid: i32) -> Option<LogicalPoint> {
    let windows = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    )?;
    let scan_count = windows.len().min(MAX_WINDOW_SCAN_COUNT);
    if scan_count <= 0 {
        return None;
    }

    // These immutable CFStringRef symbols are CoreGraphics system constants.
    let owner_key = cf_string(unsafe { kCGWindowOwnerPID });
    let layer_key = cf_string(unsafe { kCGWindowLayer });
    let alpha_key = cf_string(unsafe { kCGWindowAlpha });
    let bounds_key = cf_string(unsafe { kCGWindowBounds });
    for index in 0..scan_count {
        let raw = *windows.get(index)?;
        if raw.is_null() {
            continue;
        }
        let item = unsafe { CFType::wrap_under_get_rule(raw as _) };
        if !item.instance_of::<CFDictionary>() {
            continue;
        }
        let window = unsafe { CFDictionary::<CFString, CFType>::wrap_under_get_rule(raw.cast()) };
        let Some(window_pid) = dictionary_i32(&window, &owner_key) else {
            continue;
        };
        let Some(layer) = dictionary_i32(&window, &layer_key) else {
            continue;
        };
        let Some(alpha) = dictionary_number(&window, &alpha_key) else {
            continue;
        };
        if window_pid != owner_pid || layer != 0 || !alpha.is_finite() || alpha <= 0.0 {
            continue;
        }
        let Some(bounds) = dictionary(&window, &bounds_key) else {
            continue;
        };
        let Some(bounds) = read_bounds(&bounds) else {
            continue;
        };
        if bounds.is_valid() {
            return Some(LogicalPoint {
                x: bounds.x + bounds.width / 2.0,
                y: bounds.y + bounds.height / 2.0,
            });
        }
    }
    None
}

fn display_geometries() -> Option<Vec<DisplayGeometry>> {
    let display_ids = CGDisplay::active_displays().ok()?;
    if display_ids.is_empty() || display_ids.len() > MAX_DISPLAY_COUNT {
        return None;
    }
    let mut seen = HashSet::with_capacity(display_ids.len());
    display_ids
        .into_iter()
        .map(|display_id| {
            if display_id == 0 || !seen.insert(display_id) {
                return None;
            }
            let display = CGDisplay::new(display_id);
            let raw = display.bounds();
            let bounds = LogicalBounds {
                x: raw.origin.x,
                y: raw.origin.y,
                width: raw.size.width,
                height: raw.size.height,
            };
            bounds
                .is_valid()
                .then_some(DisplayGeometry { display_id, bounds })
        })
        .collect()
}

fn unique_display_for_point<'a>(
    point: LogicalPoint,
    displays: &'a [DisplayGeometry],
) -> Option<&'a DisplayGeometry> {
    let mut matches = displays
        .iter()
        .filter(|display| display.bounds.contains(point));
    let display = matches.next()?;
    matches.next().is_none().then_some(display)
}

fn unique_tao_monitor_for_display(
    display: &DisplayGeometry,
    monitors: Vec<Monitor>,
) -> Option<Monitor> {
    if monitors.is_empty() || monitors.len() > MAX_DISPLAY_COUNT {
        return None;
    }
    // Tauri Monitor omits tao's native CGDirectDisplayID. tao 0.35.3 names a
    // macOS monitor from CGDisplayModelNumber and computes its physical origin
    // by scaling CGDisplayBounds.origin with that candidate monitor's own scale.
    // Match those exact facts and require uniqueness; mirrored or duplicate
    // model/origin combinations deliberately fall back instead of being guessed.
    let expected_name = format!(
        "Monitor #{}",
        CGDisplay::new(display.display_id).model_number()
    );
    let candidates = monitors
        .iter()
        .map(|monitor| TaoMonitorGeometry {
            name: monitor.name().map(String::as_str),
            position: *monitor.position(),
            scale_factor: monitor.scale_factor(),
        })
        .collect::<Vec<_>>();
    let index = unique_tao_monitor_index(display, &expected_name, &candidates)?;
    monitors.into_iter().nth(index)
}

fn unique_tao_monitor_index(
    display: &DisplayGeometry,
    expected_name: &str,
    candidates: &[TaoMonitorGeometry<'_>],
) -> Option<usize> {
    let mut matched = None;
    for (index, candidate) in candidates.iter().enumerate() {
        if tao_monitor_matches_display(display, expected_name, candidate) {
            if matched.is_some() {
                return None;
            }
            matched = Some(index);
        }
    }
    matched
}

fn tao_monitor_matches_display(
    display: &DisplayGeometry,
    expected_name: &str,
    candidate: &TaoMonitorGeometry<'_>,
) -> bool {
    if candidate.name != Some(expected_name)
        || !candidate.scale_factor.is_finite()
        || candidate.scale_factor <= 0.0
    {
        return false;
    }
    tao_physical_origin(display.bounds, candidate.scale_factor) == Some(candidate.position)
}

fn tao_physical_origin(bounds: LogicalBounds, scale_factor: f64) -> Option<PhysicalPosition<i32>> {
    Some(PhysicalPosition::new(
        tao_physical_coordinate(bounds.x, scale_factor)?,
        tao_physical_coordinate(bounds.y, scale_factor)?,
    ))
}

fn tao_physical_coordinate(logical: f64, scale_factor: f64) -> Option<i32> {
    // dpi::Pixel::from_f64, used by tao 0.35.3 for Monitor.position, rounds
    // each monitor's CG logical origin using that monitor's own scale factor.
    let scaled = (logical * scale_factor).round();
    if !scaled.is_finite() || scaled < i32::MIN as f64 || scaled > i32::MAX as f64 {
        return None;
    }
    Some(scaled as i32)
}

fn cf_string(reference: CFStringRef) -> CFString {
    unsafe { CFString::wrap_under_get_rule(reference) }
}

fn dictionary<'a>(
    source: &'a CFDictionary<CFString, CFType>,
    key: &CFString,
) -> Option<CFDictionary<CFString, CFType>> {
    let value = source.find(key)?;
    if !value.instance_of::<CFDictionary>() {
        return None;
    }
    unsafe {
        Some(CFDictionary::wrap_under_get_rule(
            value.as_CFTypeRef().cast(),
        ))
    }
}

fn dictionary_number(source: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<f64> {
    source.find(key)?.downcast::<CFNumber>()?.to_f64()
}

fn dictionary_i32(source: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<i32> {
    let number = dictionary_number(source, key)?;
    if !number.is_finite()
        || number.fract() != 0.0
        || number < i32::MIN as f64
        || number > i32::MAX as f64
    {
        return None;
    }
    Some(number as i32)
}

fn read_bounds(bounds: &CFDictionary<CFString, CFType>) -> Option<LogicalBounds> {
    let x_key = CFString::from_static_string("X");
    let y_key = CFString::from_static_string("Y");
    let width_key = CFString::from_static_string("Width");
    let height_key = CFString::from_static_string("Height");
    Some(LogicalBounds {
        x: dictionary_number(bounds, &x_key)?,
        y: dictionary_number(bounds, &y_key)?,
        width: dictionary_number(bounds, &width_key)?,
        height: dictionary_number(bounds, &height_key)?,
    })
}

#[cfg(test)]
#[path = "position_macos_tests.rs"]
mod tests;
