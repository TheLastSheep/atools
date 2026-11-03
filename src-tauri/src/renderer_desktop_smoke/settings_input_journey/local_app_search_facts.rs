use super::local_app_search_schema as schema;
use super::state::Harness;
use crate::{launcher_app_catalog_source::LauncherAppCatalogSource, state::AppState};
use atools_core::Database;
use serde_json::Value;
use std::{path::Path, sync::Arc, time::Duration};
use tauri::{AppHandle, Manager, Wry};

const SETTINGS_KEY: &str = "settings-general";
const MAX_GENERAL_BYTES: usize = 64 * 1024;
const DB_TIMEOUT: Duration = Duration::from_secs(8);
const DB_POLL: Duration = Duration::from_millis(50);

pub(super) async fn read_general(harness: &Harness) -> Result<Value, &'static str> {
    let db = harness.database();
    tauri::async_runtime::spawn_blocking(move || read_general_blocking(&db))
        .await
        .map_err(|_| schema::PROBE_FAILED)?
}

fn read_general_blocking(db: &Database) -> Result<Value, &'static str> {
    let raw = db
        .get_setting(SETTINGS_KEY)
        .map_err(|_| schema::PROBE_FAILED)?
        .ok_or(schema::PROBE_FAILED)?;
    if raw.len() > MAX_GENERAL_BYTES {
        return Err(schema::PROBE_FAILED);
    }
    let value: Value = serde_json::from_str(&raw).map_err(|_| schema::PROBE_FAILED)?;
    if !value.is_object() {
        return Err(schema::PROBE_FAILED);
    }
    Ok(value)
}

pub(super) async fn wait_general(harness: &Harness, expected_enabled: bool) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + DB_TIMEOUT;
    let mut latest = None;
    loop {
        if let Ok(value) = read_general(harness).await {
            let matched = local_app_search(&value) == Some(expected_enabled);
            latest = Some(value);
            if matched {
                return latest;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return latest;
        }
        tokio::time::sleep(DB_POLL).await;
    }
}

pub(super) async fn catalog_snapshot(app: &AppHandle<Wry>) -> Result<Value, &'static str> {
    let state = app.try_state::<AppState>().ok_or(schema::PROBE_FAILED)?;
    let catalog: Arc<LauncherAppCatalogSource> = Arc::clone(&state.launcher_app_catalog);
    let apps = tauri::async_runtime::spawn_blocking(move || catalog.snapshot())
        .await
        .map_err(|_| schema::PROBE_FAILED)?
        .map_err(|_| schema::PROBE_FAILED)?;
    serde_json::to_value(apps).map_err(|_| schema::PROBE_FAILED)
}

pub(super) fn target_path_resolved_and_listed(snapshot: &Value, target: &(String, String)) -> bool {
    let target_path = Path::new(&target.1);
    let canonical = target_path.canonicalize();
    if !target_path.is_absolute() || !target_path.is_dir() {
        return false;
    }
    let Ok(canonical) = canonical else {
        return false;
    };
    if !canonical.is_absolute() || !canonical.is_dir() {
        return false;
    }
    snapshot.as_array().is_some_and(|apps| {
        apps.iter().any(|app| {
            app["name"].as_str() == Some(target.0.as_str())
                && app["path"].as_str() == Some(target.1.as_str())
        })
    })
}

pub(super) fn catalog_unchanged(
    baseline: &Value,
    after_disable: &Value,
    after_enable: &Value,
    target: &(String, String),
) -> bool {
    baseline == after_disable
        && baseline == after_enable
        && target_path_resolved_and_listed(after_disable, target)
        && target_path_resolved_and_listed(after_enable, target)
}

pub(super) fn local_app_search(settings: &Value) -> Option<bool> {
    let settings = settings.as_object()?;
    // The original renderer treats an absent preference as enabled.
    match settings.get("localAppSearch") {
        Some(value) => value.as_bool(),
        None => Some(true),
    }
}

pub(super) fn same_general_except_local_app_search(left: &Value, right: &Value) -> bool {
    let (Some(left), Some(right)) = (left.as_object(), right.as_object()) else {
        return false;
    };
    let mut left = left.clone();
    let mut right = right.clone();
    left.remove("localAppSearch");
    right.remove("localAppSearch");
    left == right
}

pub(super) fn general_write_matches(before: &Value, after: &Value, expected_enabled: bool) -> bool {
    local_app_search(after) == Some(expected_enabled)
        && same_general_except_local_app_search(before, after)
}

#[cfg(test)]
mod tests {
    use super::{
        catalog_unchanged, general_write_matches, local_app_search,
        same_general_except_local_app_search,
    };
    use serde_json::json;

    #[test]
    fn general_settings_comparison_requires_only_local_app_search_to_change() {
        let before = json!({"theme":"dark","localAppSearch":true,"unknown":"kept"});
        let disabled = json!({"theme":"dark","localAppSearch":false,"unknown":"kept"});
        assert_eq!(local_app_search(&before), Some(true));
        assert_eq!(local_app_search(&json!({"theme":"dark"})), Some(true));
        assert_eq!(local_app_search(&json!({"localAppSearch":null})), None);
        assert!(general_write_matches(&before, &disabled, false));
        assert!(!general_write_matches(&before, &disabled, true));
        assert!(!general_write_matches(
            &before,
            &json!({"theme":"light","localAppSearch":false,"unknown":"kept"}),
            false,
        ));
        assert!(!general_write_matches(
            &before,
            &json!({"theme":"dark","localAppSearch":"false","unknown":"kept"}),
            false,
        ));
        assert!(!same_general_except_local_app_search(
            &before,
            &json!({"theme":"dark","localAppSearch":false}),
        ));
    }

    #[test]
    fn native_catalog_must_remain_identical_and_keep_the_selected_target() {
        let app_dir = tempfile::tempdir().unwrap();
        let target = (
            "Fixture".to_owned(),
            app_dir.path().to_string_lossy().into_owned(),
        );
        let baseline = json!([{"name":target.0.clone(),"path":target.1.clone()}]);
        assert!(catalog_unchanged(&baseline, &baseline, &baseline, &target,));
        let changed = json!([]);
        assert!(!catalog_unchanged(&baseline, &changed, &baseline, &target,));
    }
}
