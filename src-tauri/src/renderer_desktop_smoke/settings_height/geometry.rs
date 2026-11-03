//! Measured Native bounds with a bounded end-of-sample identity recheck.
use super::{report, Session};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

#[derive(Clone)]
struct Sample {
    inner: PhysicalSize<u32>,
    outer: PhysicalSize<u32>,
    parent_position: PhysicalPosition<i32>,
    scale: f64,
    area: Value,
    monitor: Value,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    url: String,
    label: String,
    parent_label: String,
    parent_window_label: String,
    hidden: bool,
    unfocused: bool,
    children: Vec<String>,
    diagnostics: Value,
}
impl Sample {
    fn fingerprint(&self) -> Value {
        let mut state = serde_json::Map::new();
        for key in [
            "sessionCount",
            "phase",
            "documentAuthorized",
            "ready",
            "revoked",
            "childPresent",
            "layoutLeasePresent",
            "layoutRegistrationCount",
            "bundleRevisionPresent",
        ] {
            state.insert(key.into(), self.diagnostics[key].clone());
        }
        json!({"parentLabel":self.parent_window_label,"parentInnerPhysical":self.inner,"parentOuterPhysical":self.outer,
            "parentPositionPhysical":self.parent_position,"scale":self.scale,"monitor":self.monitor,
            "childLabel":self.label,"childUrl":self.url,"childParent":self.parent_label,
            "childPositionPhysical":self.position,"childSizePhysical":self.size,"ownedChildren":self.children,"session":state,"hidden":self.hidden,"unfocused":self.unfocused})
    }
}
fn read(app: &AppHandle, id: &str) -> Result<Sample, String> {
    super::validate(app)?;
    let parent = crate::window::main_window(app).map_err(|e| e.to_string())?;
    let label = format!("ztools-settings-{id}");
    let child = app.get_webview(&label).ok_or("height child missing")?;
    let mut children: Vec<String> = app
        .webviews()
        .keys()
        .filter(|label| label.starts_with("ztools-settings-"))
        .cloned()
        .collect();
    children.sort();
    if children != vec![label.clone()] {
        return Err("height unique current child identity changed".into());
    }
    let inner = parent.inner_size().map_err(|e| e.to_string())?;
    let outer = parent.outer_size().map_err(|e| e.to_string())?;
    let parent_position = parent.outer_position().map_err(|e| e.to_string())?;
    let scale = parent.scale_factor().map_err(|e| e.to_string())?;
    if !scale.is_finite() || scale <= 0.0 {
        return Err("height invalid scale".into());
    }
    let monitor = parent
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("height monitor missing")?;
    let area = json!(monitor.work_area());
    let monitor = json!({"name":monitor.name(),"position":monitor.position(),"size":monitor.size(),"scale":monitor.scale_factor(),"workArea":area});
    Ok(Sample {
        inner,
        outer,
        parent_position,
        scale,
        area,
        monitor,
        position: child.position().map_err(|e| e.to_string())?,
        size: child.size().map_err(|e| e.to_string())?,
        url: child.url().map_err(|e| e.to_string())?.to_string(),
        label: child.label().into(),
        parent_label: child.window().label().into(),
        parent_window_label: parent.label().into(),
        hidden: !parent.is_visible().map_err(|e| e.to_string())?,
        unfocused: !parent.is_focused().map_err(|e| e.to_string())?,
        children,
        diagnostics: crate::renderer_settings_view::snapshot(app),
    })
}
fn stable_read<T>(
    mut read: impl FnMut() -> Result<T, String>,
    key: impl Fn(&T) -> Value,
) -> Result<(T, Value), String> {
    for attempt in 1..=3 {
        let before = read()?;
        let after = read()?;
        let before_key = key(&before);
        let after_key = key(&after);
        if before_key == after_key {
            return Ok((
                after,
                json!({"attempts":attempt,"before":before_key,"after":after_key}),
            ));
        }
    }
    Err("height scale/monitor/session/lease or geometry changed during all samples".into())
}
pub(super) fn observe(app: &AppHandle, id: &str, stage: &str) -> Result<Value, String> {
    let (sample, stability) = stable_read(|| read(app, id), Sample::fingerprint)?;
    let Sample {
        inner,
        outer,
        parent_position,
        scale,
        area,
        position,
        size,
        url,
        label,
        parent_label,
        diagnostics,
        hidden,
        unfocused,
        ..
    } = sample;
    let session = app.state::<Session>();
    let case = session.profile.settings_height_case.unwrap();
    let frame = outer
        .height
        .checked_sub(inner.height)
        .ok_or("height invalid parent frame")?;
    let area_height = area["size"]["height"]
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or("height invalid workarea")?;
    let available = area_height
        .checked_sub(frame)
        .ok_or("height invalid workarea/frame")?;
    let desired = case.desired();
    let (requested_parent, expected_parent, expected_child, expected_header) =
        targets(desired, scale, available);
    let checks = json!({"identity":parent_label=="main" && label==format!("ztools-settings-{id}") && url==format!("atools-settings://{id}.localhost/index.html#/generalSetting"),
        "ready":diagnostics["ready"]==true && diagnostics["documentAuthorized"]==true,
        "registration":diagnostics["sessionCount"]==1 && diagnostics["layoutLeasePresent"]==true && diagnostics["layoutRegistrationCount"]==1,
        "parentHeight":f64::from(inner.height)==expected_parent,"parentWidthPositive":inner.width>0,
        "childHeight":f64::from(size.height)==expected_child,"childHeader":f64::from(position.y)==expected_header && position.x==0,
        "childWidth":size.width==inner.width,"hidden":hidden,"unfocused":unfocused});
    let behavior = match stage {
        "initial" => "initial-native-geometry",
        "after-write" => "committed-raw-changed-geometry-unchanged",
        _ => "new-session-reused-height",
    };
    let source = if stage != "initial" {
        "runtime-cache"
    } else if case == super::super::profile::HeightCase::A {
        "raw-absent"
    } else {
        "raw-value"
    };
    Ok(
        json!({"stage":stage,"sessionId":id,"bundleRevision":session.sources.revision(),"expectedDesired":desired,"expectedSource":source,
        "observedBehavior":behavior,"parent":{"innerPhysical":inner,"outerPhysical":outer,"positionPhysical":parent_position,"scale":scale,"workArea":area},
        "child":{"label":label,"url":url,"positionPhysical":position,"sizePhysical":size,"logicalHeight":f64::from(size.height)/scale},
        "diagnostics":diagnostics,"hidden":hidden,"unfocused":unfocused,"parentClipped":f64::from(inner.height)<requested_parent,"checks":checks,"stability":stability}),
    )
}
pub(super) fn append(app: &AppHandle, value: Value) {
    report::update(app, |report| {
        report["openings"].as_array_mut().unwrap().push(value)
    });
}

// Independent exact contract projection; no tolerance or inference from Cocoa observations.
fn targets(desired: f64, scale: f64, available: u32) -> (f64, f64, f64, f64) {
    let initial_pixels = (desired * scale).round();
    let layout_content = if cfg!(target_os = "macos") {
        (initial_pixels / scale).round()
    } else {
        desired
    };
    let requested = ((layout_content + 58.0) * scale).ceil();
    (
        requested,
        requested.min(f64::from(available)),
        (layout_content * scale).round(),
        (58.0 * scale).round(),
    )
}
/// Compare measured values only, excluding the new session's label and URL.
pub(super) fn same_geometry(left: &Value, right: &Value) -> bool {
    left["parent"] == right["parent"]
        && ["positionPhysical", "sizePhysical", "logicalHeight"]
            .iter()
            .all(|key| left["child"][*key] == right["child"][*key])
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_six_hundred_cannot_pass_explicit_541_and_fractional_conversion_is_explicit() {
        assert_eq!(targets(542.0, 1.0, 1000), (600.0, 600.0, 542.0, 58.0));
        let explicit = targets(541.0, 1.0, 1000);
        assert_eq!(explicit, (599.0, 599.0, 541.0, 58.0));
        assert_ne!(600.0, explicit.1);
        assert_eq!(targets(200.5, 1.0, 1000), (259.0, 259.0, 201.0, 58.0));
        if cfg!(target_os = "macos") {
            assert_eq!(targets(200.5, 2.0, 1898), (518.0, 518.0, 402.0, 116.0));
            assert_eq!(targets(200.5, 1.5, 1898), (389.0, 389.0, 302.0, 87.0));
        }
        assert_eq!(targets(2001.0, 2.0, 1799), (4118.0, 1799.0, 4002.0, 116.0));
    }
    #[test]
    fn cached_reopen_and_default_write_require_exact_actual_geometry() {
        let first = json!({"parent":{"innerPhysical":{"height":600},"scale":1},
            "child":{"label":"old","url":"old","sizePhysical":{"height":542},"positionPhysical":{"y":58},"logicalHeight":542}});
        let mut reopened = first.clone();
        reopened["child"]["label"] = json!("new");
        reopened["child"]["url"] = json!("new");
        assert!(same_geometry(&first, &reopened));
        reopened["parent"]["innerPhysical"]["height"] = json!(599);
        assert!(!same_geometry(&first, &reopened));
        reopened["parent"]["innerPhysical"]["height"] = json!(600);
        reopened["child"]["sizePhysical"]["height"] = json!(541);
        assert!(!same_geometry(&first, &reopened));
    }
}

#[cfg(test)]
mod consistency_tests {
    use super::*;
    #[test]
    fn interleaved_scale_monitor_or_session_fingerprints_cannot_pass_a_mixed_sample() {
        let base = Sample {
            inner: PhysicalSize::new(800, 600),
            outer: PhysicalSize::new(800, 600),
            parent_position: PhysicalPosition::new(0, 0),
            scale: 1.0,
            area: json!({}),
            monitor: json!({"name":"A"}),
            position: PhysicalPosition::new(0, 58),
            size: PhysicalSize::new(800, 542),
            url: "atools-settings://owned.localhost/index.html#/generalSetting".into(),
            label: "ztools-settings-owned".into(),
            parent_label: "main".into(),
            parent_window_label: "main".into(),
            hidden: true,
            unfocused: true,
            children: vec!["ztools-settings-owned".into()],
            diagnostics: json!({"sessionCount":1,"phase":"open","ready":true,"revoked":false,"documentAuthorized":true,"childPresent":true,"layoutLeasePresent":true,"layoutRegistrationCount":1,"bundleRevisionPresent":true}),
        };
        for key in ["scale", "monitor", "child", "lease", "parentHeight"] {
            let a = base.clone();
            let mut b = base.clone();
            match key {
                "scale" => b.scale = 2.0,
                "monitor" => b.monitor = json!({"name":"B"}),
                "child" => b.label = "new-child".into(),
                "lease" => b.diagnostics["layoutLeasePresent"] = json!(false),
                _ => b.inner.height = 599,
            };
            let mut reads = 0;
            assert!(stable_read(
                || {
                    reads += 1;
                    Ok(if reads % 2 == 0 { b.clone() } else { a.clone() })
                },
                Sample::fingerprint
            )
            .is_err());
            assert_eq!(reads, 6);
        }
        let values = [
            json!({"scale":1}),
            json!({"scale":2}),
            json!({"scale":2}),
            json!({"scale":2}),
        ];
        let mut index = 0;
        let (sample, proof) = stable_read(
            || {
                let value = values[index].clone();
                index += 1;
                Ok(value)
            },
            Clone::clone,
        )
        .unwrap();
        assert_eq!(sample, json!({"scale":2}));
        assert_eq!(proof["attempts"], 2);
        assert_eq!(proof["before"], proof["after"]);
    }
}
