//! Bounded input-only diagnostics. No native reads, tasks, callbacks, or queue flushing.
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, PhysicalPosition, PhysicalSize, Window};
const LIMIT: u64 = 32;
static NEXT: AtomicU64 = AtomicU64::new(0);
fn admitted(index: u64) -> bool {
    index < LIMIT
}
fn authorized(label: &str, validate: impl FnOnce() -> Result<(), String>) -> bool {
    label == "main" && validate().is_ok()
}
#[allow(clippy::too_many_arguments)]
fn plan_input(
    requested: f64,
    scale: f64,
    position: PhysicalPosition<i32>,
    inner: PhysicalSize<u32>,
    outer: PhysicalSize<u32>,
    target: PhysicalPosition<i32>,
    target_inner_height: u32,
) -> Value {
    json!({"requestedLogicalHeight":requested,"scale":scale,
        "originalPosition":position,"originalInner":inner,"originalOuter":outer,
        "targetPosition":target,"targetInnerHeight":target_inner_height,
        "positionSetterSkipped":false,"positionMatchesOriginal":target==position})
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn begin(
    app: &AppHandle,
    window: &Window,
    requested: f64,
    scale: f64,
    position: PhysicalPosition<i32>,
    inner: PhysicalSize<u32>,
    outer: PhysicalSize<u32>,
    target: PhysicalPosition<i32>,
    target_inner_height: u32,
) {
    if !authorized(window.label(), || super::validate(app)) {
        return;
    }
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    if !admitted(id) {
        if id == LIMIT {
            eprintln!("[R76-RESIZE-APPLY] {{\"overflow\":true,\"limit\":{LIMIT}}}");
        }
        return;
    }
    // Supplied values are the production caller's existing reads/plan, not new measurements.
    let plan = plan_input(
        requested,
        scale,
        position,
        inner,
        outer,
        target,
        target_inner_height,
    );
    eprintln!(
        "[R76-RESIZE-APPLY] {}",
        json!({"applyId":id,"phase":"plan-input",
        "plan":plan,"observation":"input-only-diagnostic-not-acceptance"})
    );
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_logging_requires_real_main_and_successful_complete_fixture_validation() {
        assert!(!authorized("other", || panic!(
            "must not inspect another window"
        )));
        for error in ["not-height-profile", "bad-owner", "source-mismatch"] {
            assert!(!authorized("main", || Err(error.into())));
        }
        assert!(authorized("main", || Ok(())));
    }
    #[test]
    fn fractional_request_and_plan_are_not_rounded_or_changed_and_position_is_never_skipped() {
        let position = PhysicalPosition::new(712, 696);
        let plan = plan_input(
            258.5,
            2.0,
            position,
            PhysicalSize::new(1600, 1200),
            PhysicalSize::new(1600, 1200),
            position,
            517,
        );
        assert_eq!(plan["requestedLogicalHeight"], 258.5);
        assert_eq!(plan["targetInnerHeight"], 517);
        assert_eq!(plan["positionSetterSkipped"], false);
        assert_eq!(plan["positionMatchesOriginal"], true);
    }
    #[test]
    fn input_log_budget_has_an_explicit_closed_overflow_boundary() {
        assert!(admitted(0));
        assert!(admitted(31));
        assert!(!admitted(32));
    }
}
