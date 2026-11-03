use super::{
    manager,
    types::{opaque_id, Selection, LEASE, MAX_FILES, MAX_INTENTS},
};
use serde_json::json;
use std::{path::PathBuf, time::Instant};
use tauri::{Emitter, Manager};

pub(super) fn queue_drop(
    app: &tauri::AppHandle,
    window: &str,
    paths: Vec<PathBuf>,
    x: f64,
    y: f64,
    scale: f64,
) {
    if window != "main"
        || !supported()
        || !x.is_finite()
        || !y.is_finite()
        || !scale.is_finite()
        || scale <= 0.0
    {
        return;
    }
    let Ok(runtime) = manager(app) else {
        return;
    };
    let id = opaque_id();
    let count = paths.len().min(MAX_FILES + 1);
    let accepted = !paths.is_empty() && paths.len() <= MAX_FILES;
    let selection = Selection {
        id: id.clone(),
        window: window.into(),
        paths: if accepted { paths } else { Vec::new() },
        file_count: count,
        valid: accepted,
        point_x: x,
        point_y: y,
        scale,
        created: Instant::now(),
    };
    {
        let mut store = runtime.store.lock();
        let replaced: Vec<_> = store
            .selections
            .iter()
            .filter(|(_, s)| s.window == window)
            .map(|(old, _)| old.clone())
            .collect();
        let remaining = store.selections.len().saturating_sub(replaced.len());
        if store.stopped
            || store.requests.len() + remaining >= MAX_INTENTS
            || store.requests.values().any(|r| r.owner.window == window)
        {
            return;
        }
        for old in replaced {
            store.selections.remove(&old);
            if let Some(timer) = store.selection_timers.remove(&old) {
                timer.abort();
            }
        }
        store.selections.insert(id.clone(), selection);
    }
    if app
        .emit_to(
            window,
            "atools://plugin-file-drop",
            json!({
                "intentId":id,"xPhysical":x,"yPhysical":y,"scaleFactor":scale,"fileCount":count
            }),
        )
        .is_err()
    {
        super::remove_selection(&runtime, &id);
        return;
    }
    let timer_app = app.clone();
    let timer_id = id.clone();
    let timer = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LEASE).await;
        super::lifecycle::expire_selection(&timer_app, &timer_id);
    });
    super::register_selection_timer(&runtime, &id, timer);
}

pub(super) fn discard(app: &tauri::AppHandle, window: &str, id: &str) -> Result<bool, String> {
    if window != "main" {
        return Err("Invalid file-drop origin".into());
    }
    let runtime = manager(app)?;
    let mut store = runtime.store.lock();
    if store.requests.values().any(|r| r.selection_id == id) {
        return Err("Claimed file-drop intent cannot be discarded directly".into());
    }
    let owned = store.selections.get(id).is_some_and(|s| s.window == window);
    if owned {
        if let Some(timer) = store.selection_timers.remove(id) {
            timer.abort();
        }
        store.selections.remove(id);
    }
    Ok(owned)
}

pub(crate) fn supported() -> bool {
    cfg!(target_os = "macos")
}
