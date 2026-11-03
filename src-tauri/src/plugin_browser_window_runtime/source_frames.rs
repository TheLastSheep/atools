//! A late child-document bind cannot outlive its actual native parent record.
use super::intents::WindowLife;
use crate::plugin_asset_protocol::Owner;

pub(crate) fn validate_source_frame(
    app: &tauri::AppHandle,
    owner: &Owner,
    frame_id: &str,
) -> Result<(), String> {
    if frame_id == "main" {
        return Ok(());
    }
    let id = frame_id
        .strip_prefix("child:")
        .ok_or("Invalid plugin source frame")?;
    let runtime = super::manager(app)?;
    validate_child_frame(&runtime, owner, id)
}

fn validate_child_frame(
    runtime: &super::manager::Runtime,
    owner: &Owner,
    id: &str,
) -> Result<(), String> {
    let window = runtime
        .window_for_frontend_id(owner, id)
        .ok_or("Plugin source native window is no longer active")?;
    let alive = *window.life.lock() == WindowLife::Alive;
    let authorized = window
        .renderer_authorized
        .load(std::sync::atomic::Ordering::Acquire);
    if !alive || !authorized {
        return Err("Plugin source native window is no longer active".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_browser_window_runtime::intents::Payload;
    use serde_json::json;
    use std::sync::atomic::Ordering;

    #[test]
    fn child_binding_requires_exact_alive_native_record_even_for_a_new_generation() {
        let runtime = super::super::manager::Runtime::default();
        let owner = Owner::new("main", "fixture", "9fe6b202-0c8b-4b9b-b320-c8c64e0bfeef").unwrap();
        let intent = runtime
            .create_open_intent(
                owner.clone(),
                "binding-a".into(),
                "child-1".into(),
                json!({}),
                true,
            )
            .unwrap();
        intent.set_run("run-open").unwrap();
        let spec = match intent.payload.lock().as_ref().unwrap() {
            Payload::Open { spec: Some(spec) } => spec.clone(),
            _ => unreachable!(),
        };
        let label = spec.label.clone();
        let (window, _) = runtime
            .reserve(
                &intent,
                "main".into(),
                "shell-url".into(),
                "ticket".into(),
                spec,
            )
            .unwrap();
        runtime
            .consume_reservation("main", "shell-url", "binding-a", "run-open")
            .unwrap();
        assert!(validate_child_frame(&runtime, &owner, "child-1").is_err());
        runtime.mark_loaded(&label).unwrap();
        assert!(validate_child_frame(&runtime, &owner, "child-1").is_err());
        window.renderer_authorized.store(true, Ordering::Release);
        assert!(validate_child_frame(&runtime, &owner, "child-1").is_ok());
        assert!(validate_child_frame(&runtime, &owner, "sibling").is_err());
        let other_owner =
            Owner::new("main", "fixture", "2fe6b202-0c8b-4b9b-b320-c8c64e0bfeef").unwrap();
        assert!(validate_child_frame(&runtime, &other_owner, "child-1").is_err());
        runtime.mark_destroying(&label).unwrap();
        assert!(validate_child_frame(&runtime, &owner, "child-1").is_err());
        runtime.remove_destroyed(&label).unwrap();
        assert!(validate_child_frame(&runtime, &owner, "child-1").is_err());
    }
}
