//! Native window snapshots and their adapter-owned size-constraint mirror.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, AtomicU8, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewWindow, Wry};

use super::size_policy::FrameMetrics;

pub(crate) use super::size_policy::NativeConstraints;

const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(5);
static NATIVE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static CONSTRAINTS: OnceLock<Mutex<HashMap<String, NativeConstraints>>> = OnceLock::new();

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A completed read of actual native state plus adapter-owned min/max limits.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSnapshot {
    pub bounds: NativeBounds,
    pub content_bounds: NativeBounds,
    pub minimum_size: [f64; 2],
    pub maximum_size: [f64; 2],
    pub constraints_source: &'static str,
    pub visible: bool,
    pub focused: bool,
    pub always_on_top: bool,
    pub minimized: bool,
    pub maximized: bool,
    pub full_screen: bool,
    pub resizable: bool,
    pub title: String,
    pub native_sequence: u64,
}

impl NativeSnapshot {
    pub fn to_value(&self) -> Result<Value, String> {
        serde_json::to_value(self)
            .map_err(|error| format!("ERR_ATOOLS_NATIVE_WINDOW_SNAPSHOT_SERIALIZATION: {error}"))
    }
}

fn constraints() -> &'static Mutex<HashMap<String, NativeConstraints>> {
    CONSTRAINTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn remember_constraints(label: &str, value: NativeConstraints) {
    constraints()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(label.to_string(), value);
}

pub(crate) fn current_constraints(label: &str) -> NativeConstraints {
    constraints()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(label)
        .copied()
        .unwrap_or_default()
}

fn remove_constraints(label: &str) {
    constraints()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(label);
}

/// Drop adapter-only constraint state after build failure or native destruction.
pub fn forget_window(app: &AppHandle, label: &str) {
    super::dragging::forget_window(app, label);
    remove_constraints(label);
}

pub(crate) fn next_native_sequence() -> u64 {
    NATIVE_SEQUENCE
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            Some(current.saturating_add(1))
        })
        .unwrap_or(u64::MAX)
        .saturating_add(1)
}

pub(crate) async fn run_on_main_thread<T, F>(app: &AppHandle, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let state = Arc::new(AtomicU8::new(0));
    let callback_state = state.clone();
    app.run_on_main_thread(move || {
        if callback_state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let result = work();
        callback_state.store(3, Ordering::Release);
        let _ = sender.send(result);
    })
    .map_err(|error| format!("ERR_ATOOLS_NATIVE_WINDOW_MAIN_THREAD: {error}"))?;

    match tokio::time::timeout(MAIN_THREAD_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            Err("ERR_ATOOLS_NATIVE_WINDOW_MAIN_THREAD: callback ended without a result".into())
        }
        Err(_) => {
            let _ = state.compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire);
            Err(format!(
                "ERR_ATOOLS_NATIVE_WINDOW_TIMEOUT: main-thread operation exceeded {} ms",
                MAIN_THREAD_TIMEOUT.as_millis()
            ))
        }
    }
}

pub async fn snapshot(app: &AppHandle, label: &str) -> Result<NativeSnapshot, String> {
    super::options::validate_label(label)?;
    let scheduler = app.clone();
    let worker = app.clone();
    let label = label.to_string();
    run_on_main_thread(&scheduler, move || {
        let window = worker
            .get_webview_window(&label)
            .ok_or_else(|| format!("ERR_ATOOLS_NATIVE_WINDOW_NOT_FOUND: {label}"))?;
        snapshot_now(&window)
    })
    .await
}

pub(crate) fn snapshot_now(window: &WebviewWindow<Wry>) -> Result<NativeSnapshot, String> {
    let label = window.label().to_string();
    let scale = window.scale_factor().map_err(native_error)?;
    let outer_position = window
        .outer_position()
        .map_err(native_error)?
        .to_logical::<f64>(scale);
    let outer_size_physical = window.outer_size().map_err(native_error)?;
    let inner_position = window
        .inner_position()
        .map_err(native_error)?
        .to_logical::<f64>(scale);
    let inner_size_physical = window.inner_size().map_err(native_error)?;
    let metrics = FrameMetrics::new(
        scale,
        [outer_size_physical.width, outer_size_physical.height],
        [inner_size_physical.width, inner_size_physical.height],
    )?;
    let min_max = metrics.outer_constraints(current_constraints(&label))?;
    let outer_size = outer_size_physical.to_logical::<f64>(scale);
    let inner_size = inner_size_physical.to_logical::<f64>(scale);

    Ok(NativeSnapshot {
        bounds: NativeBounds {
            x: outer_position.x,
            y: outer_position.y,
            width: outer_size.width,
            height: outer_size.height,
        },
        content_bounds: NativeBounds {
            x: inner_position.x,
            y: inner_position.y,
            width: inner_size.width,
            height: inner_size.height,
        },
        minimum_size: min_max.minimum(),
        maximum_size: min_max.maximum(),
        constraints_source: "adapter",
        visible: window.is_visible().map_err(native_error)?,
        focused: window.is_focused().map_err(native_error)?,
        always_on_top: window.is_always_on_top().map_err(native_error)?,
        minimized: window.is_minimized().map_err(native_error)?,
        maximized: window.is_maximized().map_err(native_error)?,
        full_screen: window.is_fullscreen().map_err(native_error)?,
        resizable: window.is_resizable().map_err(native_error)?,
        title: window.title().map_err(native_error)?,
        native_sequence: next_native_sequence(),
    })
}

pub(crate) fn native_error(error: impl std::fmt::Display) -> String {
    format!("ERR_ATOOLS_NATIVE_WINDOW: {error}")
}

#[cfg(test)]
mod tests {
    use super::super::size_policy::ConstraintBasis;
    use super::{
        current_constraints, remember_constraints, remove_constraints, FrameMetrics,
        NativeConstraints,
    };

    #[test]
    fn constraint_mirror_is_window_scoped_and_zero_means_unbounded() {
        let label = "plugin-browser-window-constraint-test";
        remember_constraints(
            label,
            NativeConstraints {
                min_width: Some(240.0),
                min_height: None,
                max_width: None,
                max_height: Some(900.0),
                basis: ConstraintBasis::Outer,
            },
        );
        let current = current_constraints(label);
        assert_eq!(current.minimum(), [240.0, 0.0]);
        assert_eq!(current.maximum(), [0.0, 900.0]);
        remove_constraints(label);
        assert_eq!(current_constraints(label), NativeConstraints::default());

        let content = NativeConstraints {
            min_width: Some(120.0),
            min_height: None,
            max_width: Some(640.0),
            max_height: None,
            basis: ConstraintBasis::Content,
        };
        remember_constraints(label, content);
        assert_eq!(current_constraints(label), content);
        remove_constraints(label);
    }

    #[test]
    fn public_snapshot_constraints_use_outer_size_even_for_content_specs() {
        let metrics = FrameMetrics::new(2.0, [220, 200], [200, 180]).unwrap();
        let content = NativeConstraints {
            min_width: Some(100.0),
            min_height: Some(80.0),
            max_width: Some(500.0),
            max_height: Some(400.0),
            basis: ConstraintBasis::Content,
        };

        let outer = metrics.outer_constraints(content).unwrap();
        assert_eq!(outer.basis, ConstraintBasis::Outer);
        assert_eq!(outer.minimum(), [110.0, 90.0]);
        assert_eq!(outer.maximum(), [510.0, 410.0]);
    }
}
