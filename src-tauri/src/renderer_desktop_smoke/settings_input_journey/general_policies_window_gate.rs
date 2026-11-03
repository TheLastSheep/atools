use serde_json::Value;

pub(super) fn passed(value: &Value) -> bool {
    let ui = &value["windowUi"];
    let initial_strategy = ui["initialStoredStrategy"].as_str().unwrap_or("remember");
    ui["initialUiStrategy"].as_str() == Some(initial_strategy)
        && ["cursor", "primary", "lastActive", "remember"]
            .iter()
            .all(|key| {
                ui[*key]["uiSelected"].as_bool() == Some(true)
                    && ui[*key]["storedStrategy"].as_str() == Some(*key)
            })
        && ui["reopened"]["freshSession"].as_bool() == Some(true)
        && ui["reopened"]["uiStrategy"].as_str() == Some("remember")
        && ui["reopened"]["storedStrategy"].as_str() == Some("remember")
        && ui["restored"]["uiStrategy"].as_str() == Some(initial_strategy)
        && ui["restored"]["storedStrategy"].as_str() == Some(initial_strategy)
        && ui["unrelatedSettingsPreserved"].as_bool() == Some(true)
        && centered(&value["geometry"]["cursor"], false, true)
        && centered(&value["geometry"]["primary"], true, false)
        && value["geometry"]["lastActiveFallback"]["externalWindowAvailable"].as_bool()
            == Some(false)
        && value["geometry"]["lastActiveFallback"]["position"]["monitor"]
            == value["geometry"]["cursor"]["monitor"]
        && centered(
            &value["geometry"]["lastActiveFallback"]["position"],
            false,
            true,
        )
        && remember_matches(&value["geometry"]["remember"], &value["geometry"]["cursor"])
}

fn centered(sample: &Value, require_primary: bool, require_cursor_inside: bool) -> bool {
    let monitor = &sample["monitor"];
    let window = &sample["window"];
    let cursor = &sample["cursor"];
    let (
        Some(mx),
        Some(my),
        Some(mw),
        Some(mh),
        Some(wx),
        Some(wy),
        Some(ww),
        Some(wh),
        Some(scale),
    ) = (
        monitor["x"].as_i64(),
        monitor["y"].as_i64(),
        monitor["width"].as_u64(),
        monitor["height"].as_u64(),
        monitor["workX"].as_i64(),
        monitor["workY"].as_i64(),
        monitor["workWidth"].as_u64(),
        monitor["workHeight"].as_u64(),
        monitor["scaleFactor"].as_f64(),
    )
    else {
        return false;
    };
    let (Some(cx), Some(cy), Some(x), Some(y), Some(actual_w), Some(actual_h)) = (
        cursor["x"].as_i64(),
        cursor["y"].as_i64(),
        window["x"].as_i64(),
        window["y"].as_i64(),
        window["width"].as_u64(),
        window["height"].as_u64(),
    ) else {
        return false;
    };
    if require_primary && monitor["isPrimary"].as_bool() != Some(true) {
        return false;
    }
    if require_cursor_inside
        && (cx < mx
            || cy < my
            || cx as i128 >= mx as i128 + mw as i128
            || cy as i128 >= my as i128 + mh as i128)
    {
        return false;
    }
    let Some(centered_x) = centered_origin(wx, ww, 800.0, scale) else {
        return false;
    };
    let Some(centered_y) = centered_origin(wy, wh, 600.0, scale) else {
        return false;
    };
    x == clamp_position(centered_x, wx, ww, actual_w)
        && y == clamp_position(centered_y, wy, wh, actual_h)
}

fn centered_origin(origin: i64, work_extent: u64, logical_anchor: f64, scale: f64) -> Option<i64> {
    if !scale.is_finite() || scale <= 0.0 || !logical_anchor.is_finite() || logical_anchor < 0.0 {
        return None;
    }
    let logical_offset = ((work_extent as f64 / scale - logical_anchor).max(0.0) / 2.0).floor();
    let physical_offset = (logical_offset * scale).round();
    if !physical_offset.is_finite() || physical_offset < 0.0 || physical_offset > i64::MAX as f64 {
        return None;
    }
    Some(origin.saturating_add(physical_offset as i64))
}

fn clamp_position(position: i64, origin: i64, work_extent: u64, actual_extent: u64) -> i64 {
    let max = origin.saturating_add(
        work_extent
            .saturating_sub(actual_extent)
            .min(i64::MAX as u64) as i64,
    );
    position.max(origin).min(max.max(origin))
}

#[cfg(test)]
mod tests {
    use super::{centered, remember_matches};
    use serde_json::json;

    fn samples(
        saved: (i64, i64),
        moved: (i64, i64),
        restored: (i64, i64),
    ) -> (serde_json::Value, serde_json::Value) {
        let monitor = json!({
            "x": 0, "y": 0, "width": 1440, "height": 900,
            "workX": 0, "workY": 24, "workWidth": 1440, "workHeight": 876,
            "scaleFactor": 1, "isPrimary": true,
        });
        let cursor = json!({
            "cursor": {"x": 500, "y": 400},
            "monitor": monitor,
            "window": {"x": 320, "y": 162, "width": 800, "height": 600},
        });
        let remembered = json!({
            "monitor": monitor,
            "windowSize": {"width": 800, "height": 600},
            "saved": {"x": saved.0, "y": saved.1},
            "moved": {"x": moved.0, "y": moved.1},
            "restored": {"x": restored.0, "y": restored.1},
        });
        (remembered, cursor)
    }

    #[test]
    fn remember_requires_a_saved_location_off_the_default_center() {
        let (remembered, cursor) = samples((120, 80), (184, 144), (120, 80));
        assert!(remember_matches(&remembered, &cursor));

        let (centered, cursor) = samples((320, 162), (384, 226), (320, 162));
        assert!(!remember_matches(&centered, &cursor));
    }

    #[test]
    fn high_dpi_centering_uses_logical_first_rounding_and_actual_extent_clamp() {
        let monitor = json!({
            "x": 0, "y": 0, "width": 3024, "height": 2016,
            "workX": 0, "workY": 66, "workWidth": 3024, "workHeight": 1898,
            "scaleFactor": 2, "isPrimary": true,
        });
        let sample = |cursor: (i64, i64), x: i64, y: i64, height: u64| {
            json!({
                "cursor": {"x": cursor.0, "y": cursor.1},
                "monitor": monitor,
                "window": {"x": x, "y": y, "width": 1200, "height": height},
            })
        };
        let cursor = sample((100, 100), 712, 414, 1300);
        assert!(centered(&cursor, false, true));
        for old_y in [415, 416] {
            let wrong = sample((100, 100), 712, old_y, 1300);
            assert!(!centered(&wrong, false, true), "y={old_y} must be rejected");
        }

        let primary = sample((4000, 100), 712, 414, 1300);
        assert!(centered(&primary, true, false));
        assert!(!centered(&primary, false, true));

        let negative_monitor = json!({
            "x": -1920, "y": -1080, "width": 3024, "height": 2016,
            "workX": -1920, "workY": -1014, "workWidth": 3024, "workHeight": 1898,
            "scaleFactor": 2, "isPrimary": true,
        });
        let negative = json!({
            "cursor": {"x": -1000, "y": -500}, "monitor": negative_monitor,
            "window": {"x": -1208, "y": -666, "width": 1200, "height": 1300},
        });
        assert!(centered(&negative, false, true));

        let compact = sample((100, 100), 712, 164, 1800);
        assert!(centered(&compact, false, true));
        assert!(!centered(&sample((100, 100), 712, 414, 1800), false, true));

        let remembered = json!({
            "monitor": monitor,
            "windowSize": {"width": 1200, "height": 1300},
            "saved": {"x": 800, "y": 500},
            "moved": {"x": 864, "y": 564},
            "restored": {"x": 800, "y": 500},
        });
        assert!(remember_matches(&remembered, &cursor));
        let default_saved = json!({
            "monitor": monitor,
            "windowSize": {"width": 1200, "height": 1300},
            "saved": {"x": 712, "y": 414},
            "moved": {"x": 776, "y": 478},
            "restored": {"x": 712, "y": 414},
        });
        assert!(!remember_matches(&default_saved, &cursor));
    }
}

fn remember_matches(value: &Value, cursor_sample: &Value) -> bool {
    let monitor = &value["monitor"];
    let cursor_monitor = &cursor_sample["monitor"];
    let (
        Some(work_x),
        Some(work_y),
        Some(work_w),
        Some(work_h),
        Some(scale),
        Some(width),
        Some(height),
        Some(saved_x),
        Some(saved_y),
        Some(moved_x),
        Some(moved_y),
        Some(restored_x),
        Some(restored_y),
        Some(cursor_w),
        Some(cursor_h),
    ) = (
        monitor["workX"].as_i64(),
        monitor["workY"].as_i64(),
        monitor["workWidth"].as_u64(),
        monitor["workHeight"].as_u64(),
        monitor["scaleFactor"].as_f64(),
        value["windowSize"]["width"].as_u64(),
        value["windowSize"]["height"].as_u64(),
        value["saved"]["x"].as_i64(),
        value["saved"]["y"].as_i64(),
        value["moved"]["x"].as_i64(),
        value["moved"]["y"].as_i64(),
        value["restored"]["x"].as_i64(),
        value["restored"]["y"].as_i64(),
        cursor_sample["window"]["width"].as_u64(),
        cursor_sample["window"]["height"].as_u64(),
    )
    else {
        return false;
    };
    if monitor != cursor_monitor
        || width != cursor_w
        || height != cursor_h
        || saved_x == moved_x && saved_y == moved_y
    {
        return false;
    }
    let inside = |x: i64, y: i64| {
        x >= work_x
            && y >= work_y
            && x as i128 + width as i128 <= work_x as i128 + work_w as i128
            && y as i128 + height as i128 <= work_y as i128 + work_h as i128
    };
    let expected_x = clamp_position(saved_x, work_x, work_w, width);
    let expected_y = clamp_position(saved_y, work_y, work_h, height);
    let (Some(default_x), Some(default_y)) = (
        centered_origin(work_x, work_w, 800.0, scale),
        centered_origin(work_y, work_h, 600.0, scale),
    ) else {
        return false;
    };
    let default_x = clamp_position(default_x, work_x, work_w, width);
    let default_y = clamp_position(default_y, work_y, work_h, height);
    inside(saved_x, saved_y)
        && inside(moved_x, moved_y)
        && (saved_x != default_x || saved_y != default_y)
        && restored_x == expected_x
        && restored_y == expected_y
}
