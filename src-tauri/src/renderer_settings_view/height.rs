//! Requested content height is independent of the parent viewport clipping.
use serde_json::Value;
use tauri::{AppHandle, Wry};
use tokio::time::{Duration, Instant};

pub(super) fn raw_default(raw: Option<&str>) -> Result<f64, String> {
    let Some(raw) = raw else {
        return Ok(542.0);
    };
    let value: Value =
        serde_json::from_str(raw).map_err(|_| "Stored General settings are invalid")?;
    if !value.is_object() {
        return Err("Stored General settings are invalid".into());
    }
    match value.get("windowDefaultHeight") {
        None => Ok(542.0),
        Some(value) => atools_core::db::renderer_general_settings_window_default_height(value)
            .ok_or_else(|| "Stored default content height is invalid".into()),
    }
}

#[derive(Clone)]
struct HeightEntry {
    session: String,
    bundle: String,
    desired: f64,
}

#[derive(Default)]
pub(super) struct HeightCache {
    confirmed: Option<HeightEntry>,
    pending: Option<HeightEntry>,
}
impl HeightCache {
    pub(super) fn stage(&mut self, session: &str, bundle: &str, default: f64) -> f64 {
        let desired = self
            .confirmed
            .as_ref()
            .filter(|entry| entry.bundle == bundle)
            .map_or(default, |entry| entry.desired);
        self.pending = Some(HeightEntry {
            session: session.into(),
            bundle: bundle.into(),
            desired,
        });
        desired
    }
    pub(super) fn confirm(&mut self, session: &str, bundle: &str) -> bool {
        if !self
            .pending
            .as_ref()
            .is_some_and(|entry| entry.session == session && entry.bundle == bundle)
        {
            return false;
        }
        self.confirmed = self.pending.take();
        true
    }
}

pub(super) async fn confirm_viewport(
    app: &AppHandle<Wry>,
    deadline: Instant,
) -> Result<(), String> {
    let window = crate::window::main_window(app)
        .map_err(|_| "Main native window is unavailable".to_owned())?;
    let local_deadline = deadline.min(Instant::now() + Duration::from_secs(2));
    loop {
        let size = window
            .inner_size()
            .map_err(|_| "Main window viewport is unavailable".to_owned())?;
        let scale = window
            .scale_factor()
            .map_err(|_| "Main window scale factor is unavailable".to_owned())?;
        let logical_height = f64::from(size.height) / scale;
        if size.width > 0 && scale.is_finite() && scale > 0.0 && logical_height >= 184.0 {
            return Ok(());
        }
        tokio::time::timeout_at(
            local_deadline,
            tokio::time::sleep(Duration::from_millis(20)),
        )
        .await
        .map_err(|_| "Main window viewport is insufficient for the settings view".to_owned())?;
    }
}

#[cfg(test)]
#[path = "height_tests.rs"]
mod tests;
