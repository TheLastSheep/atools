//! Safe, bounded projection of native plugin BrowserWindow records.

use crate::plugin_runtime_inventory::{RuntimeEvidence, RuntimeKind, RuntimePhase, RuntimeSession};
use tauri::AppHandle;

use super::{
    intents::{NativeWindow, WindowLife},
    manager::Runtime,
};

const MAX_INVENTORY_ENTRIES: usize = 128;

pub(crate) fn inventory_snapshot(app: &AppHandle) -> Result<(Vec<RuntimeSession>, bool), String> {
    let runtime = super::manager(app)?;
    Ok(snapshot_runtime(&runtime))
}

fn snapshot_runtime(runtime: &Runtime) -> (Vec<RuntimeSession>, bool) {
    let store = runtime.store.lock();
    let mut windows = store.windows.values().collect::<Vec<_>>();
    windows.sort_unstable_by(|left, right| left.native_label.cmp(&right.native_label));
    let entries = windows
        .into_iter()
        .map(|window| project_window(window))
        .collect();
    let (snapshot, truncated) = bound_entries(entries);
    (snapshot, truncated)
}

fn bound_entries(mut entries: Vec<RuntimeSession>) -> (Vec<RuntimeSession>, bool) {
    let truncated = entries.len() > MAX_INVENTORY_ENTRIES;
    entries.truncate(MAX_INVENTORY_ENTRIES);
    (entries, truncated)
}

fn project_window(window: &NativeWindow) -> RuntimeSession {
    RuntimeSession::new(
        RuntimeKind::BrowserWindow,
        window.native_label.clone(),
        window.owner.plugin.clone(),
        Some(window.owner.window.clone()),
        None,
        phase_for_window(*window.life.lock()),
        RuntimeEvidence::NativeWindow,
    )
}

fn phase_for_window(life: WindowLife) -> RuntimePhase {
    match life {
        WindowLife::Creating => RuntimePhase::Starting,
        WindowLife::Alive => RuntimePhase::Ready,
        WindowLife::Destroying => RuntimePhase::Stopping,
    }
}

#[cfg(test)]
mod tests {
    use super::{bound_entries, phase_for_window, project_window, MAX_INVENTORY_ENTRIES};
    use crate::plugin_asset_protocol::Owner;
    use crate::plugin_browser_window_runtime::intents::{LoadState, NativeWindow, WindowLife};
    use crate::plugin_runtime_inventory::{
        RuntimeEvidence, RuntimeKind, RuntimePhase, RuntimeSession,
    };
    use std::sync::atomic::AtomicBool;
    use tokio::sync::watch;

    #[test]
    fn maps_native_window_lifecycle_without_synthesizing_closed() {
        assert_eq!(
            phase_for_window(WindowLife::Creating),
            RuntimePhase::Starting
        );
        assert_eq!(phase_for_window(WindowLife::Alive), RuntimePhase::Ready);
        assert_eq!(
            phase_for_window(WindowLife::Destroying),
            RuntimePhase::Stopping
        );
    }

    #[test]
    fn projects_only_safe_window_metadata_and_retains_failed_load_record() {
        let owner = Owner::new("main", "sample-plugin", &uuid::Uuid::new_v4().to_string()).unwrap();
        let (load_tx, _) = watch::channel(LoadState::Failed("private-renderer-error".into()));
        let window = NativeWindow {
            owner,
            parent_label: "main".into(),
            creator_binding_id: "private-source-binding".into(),
            frontend_window_id: "frontend-window".into(),
            native_label: "native-window-id".into(),
            intent_id: "private-intent".into(),
            open_run_id: "private-task-run".into(),
            parent_was_visible: true,
            permission_prompt_shown: false,
            requested_show: true,
            life: parking_lot::Mutex::new(WindowLife::Creating),
            renderer_ready: AtomicBool::new(false),
            load_tx,
            renderer_authorized: AtomicBool::new(false),
            destroy_requested: AtomicBool::new(false),
        };

        let row = project_window(&window);
        let value = serde_json::to_value(row).unwrap();
        assert_eq!(value["phase"], "starting");
        assert_eq!(value["codeRevision"], serde_json::Value::Null);
        let serialized = value.to_string();
        for private in [
            "private-renderer-error",
            "private-source-binding",
            "private-intent",
            "private-task-run",
        ] {
            assert!(!serialized.contains(private));
        }
        assert_eq!(value["evidence"], "native_window");
    }

    #[test]
    fn bounds_window_projection_to_128_rows() {
        let rows = (0..129)
            .map(|index| {
                RuntimeSession::new(
                    RuntimeKind::BrowserWindow,
                    format!("native-{index}"),
                    "sample-plugin".into(),
                    Some("main".into()),
                    None,
                    RuntimePhase::Ready,
                    RuntimeEvidence::NativeWindow,
                )
            })
            .collect();
        let (rows, truncated) = bound_entries(rows);
        assert_eq!(rows.len(), MAX_INVENTORY_ENTRIES);
        assert!(truncated);
    }
}
