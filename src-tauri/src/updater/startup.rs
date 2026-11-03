//! One background registration shared by original and legacy Main; no UI timer.
use super::*;
use std::sync::atomic::Ordering;
pub(crate) fn register(app: &tauri::AppHandle, coordinator: &UpdateCoordinator) {
    if coordinator.startup_registered.swap(true, Ordering::AcqRel) {
        return;
    }
    let Some(observed) = coordinator.scheduler.generation() else {
        return;
    };
    let app = app.clone();
    let coordinator = coordinator.clone();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<crate::state::AppState>() else {
            return;
        };
        let db = state.db.clone();
        let raw = crate::general_settings_runtime::read_general_settings(app.clone(), db).await;
        if let Ok(raw) = raw {
            super::auto_check::apply_to(
                &app,
                &coordinator,
                auto_enabled(raw.as_deref()),
                Some(observed),
            );
        }
    });
}

fn auto_enabled(raw: Option<&str>) -> bool {
    let Some(raw) = raw else { return true };
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .is_some_and(|fields| {
            fields
                .get("autoCheckUpdate")
                .map_or(true, |value| value.as_bool() == Some(true))
        })
}
#[cfg(test)]
mod tests {
    #[test]
    fn startup_pref_is_existing_general_boolean_and_invalid_is_off() {
        for raw in [
            None,
            Some("{}"),
            Some(r#"{"autoCheckUpdate":true,"unknown":1}"#),
        ] {
            assert!(super::auto_enabled(raw));
        }
        for raw in [
            Some("[]"),
            Some("null"),
            Some("bad"),
            Some(r#"{"autoCheckUpdate":false}"#),
            Some(r#"{"autoCheckUpdate":"true"}"#),
        ] {
            assert!(!super::auto_enabled(raw));
        }
    }
}
