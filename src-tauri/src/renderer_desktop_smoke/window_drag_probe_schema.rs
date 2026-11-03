use serde::{Deserialize, Serialize};

pub(super) const STAGES: [&str; 10] = [
    "baseline",
    "dragged",
    "resized",
    "released",
    "restored",
    "hide-locked",
    "hidden-cleared",
    "redragged",
    "navigated",
    "recovered",
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CounterSnapshot {
    pub(super) pending: u64,
    pub(super) queued: u64,
    pub(super) in_flight: Option<String>,
    pub(super) pending_position_reads: u64,
    pub(super) queued_moves: u64,
    pub(super) queued_locks: u64,
    pub(super) position_reads: u64,
    pub(super) move_requests: u64,
    pub(super) lock_requests: u64,
    pub(super) dispatched_positions: u64,
    pub(super) dispatched_moves: u64,
    pub(super) dispatched_locks: u64,
    pub(super) coalesced_moves: u64,
    pub(super) rejected_operations: u64,
    pub(super) failures: u64,
    pub(super) cancelled_reads: u64,
    pub(super) dropped_after_dispose: u64,
    pub(super) disposed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DomObservation {
    pub(super) search_box_found: bool,
    pub(super) input_empty: bool,
    pub(super) document_visibility: String,
    pub(super) document_has_focus: bool,
    pub(super) document_id: String,
    pub(super) position_read: Option<Point>,
    pub(super) outstanding_native_calls: u64,
    pub(super) renderer_window_drag_calls: u64,
    pub(super) expand_window_calls: u64,
    pub(super) hide_window_calls: u64,
    pub(super) window_notification_pending_replies: u64,
    pub(super) window_notification_failures: u64,
    pub(super) drag: CounterSnapshot,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Point {
    pub(super) x: f64,
    pub(super) y: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Dimensions {
    pub(super) width: f64,
    pub(super) height: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DragNativeObservation {
    pub(super) position: Option<Point>,
    pub(super) inner_size: Option<Dimensions>,
    pub(super) scale_factor: Option<f64>,
    pub(super) locked: Option<bool>,
    pub(super) visible: Option<bool>,
    pub(super) focused: Option<bool>,
    pub(super) focus_gained_events: u64,
    pub(super) active_child_layouts: Option<u64>,
    pub(super) child_webviews: Option<u64>,
    pub(super) data_store_persistent: Option<bool>,
    pub(super) document_generation: u64,
    pub(super) page_load_starts: u64,
    pub(super) page_load_finishes: u64,
    pub(super) document_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StageObservation {
    pub(super) stage: &'static str,
    pub(super) elapsed_ms: u64,
    pub(super) dom: DomObservation,
    pub(super) native: DragNativeObservation,
    pub(super) errors: Vec<&'static str>,
}

pub(super) fn validate_stage(
    index: usize,
    dom: &DomObservation,
    native: &DragNativeObservation,
    previous_stages: &[StageObservation],
) -> Vec<&'static str> {
    let mut errors = Vec::new();
    let Some(stage) = STAGES.get(index).copied() else {
        return vec!["window-drag-stage-invalid"];
    };
    check(
        &mut errors,
        dom.search_box_found,
        "window-drag-search-box-missing",
    );
    check(
        &mut errors,
        dom.input_empty,
        "window-drag-search-input-not-empty",
    );
    check(
        &mut errors,
        dom.document_visibility == "hidden",
        "window-drag-document-not-hidden",
    );
    check(
        &mut errors,
        !dom.drag.disposed,
        "window-drag-adapter-disposed",
    );
    check(
        &mut errors,
        dom.drag.pending == 0
            && dom.drag.queued == 0
            && dom.drag.in_flight.is_none()
            && dom.drag.pending_position_reads == 0
            && dom.drag.queued_moves == 0
            && dom.drag.queued_locks == 0,
        "window-drag-adapter-not-settled",
    );
    check(
        &mut errors,
        dom.drag.rejected_operations == 0
            && dom.drag.failures == 0
            && dom.drag.cancelled_reads == 0
            && dom.drag.dropped_after_dispose == 0,
        "window-drag-adapter-errors",
    );
    check(
        &mut errors,
        dom.outstanding_native_calls == 0
            && dom.window_notification_pending_replies == 0
            && dom.window_notification_failures == 0,
        "window-drag-host-calls-not-settled",
    );
    check(
        &mut errors,
        native
            .position
            .is_some_and(|point| point.x.is_finite() && point.y.is_finite())
            && native.inner_size.is_some_and(|size| {
                size.width.is_finite()
                    && size.height.is_finite()
                    && size.width > 0.0
                    && size.height > 0.0
            })
            && native
                .scale_factor
                .is_some_and(|scale| scale.is_finite() && scale > 0.0)
            && native.locked.is_some()
            && native.visible == Some(false)
            && native.focused == Some(false)
            && native.focus_gained_events == 0
            && native.active_child_layouts == Some(0)
            && native.child_webviews == Some(0)
            && native.data_store_persistent == Some(false),
        "window-drag-native-hidden-snapshot-incomplete",
    );
    let lifecycle = if index < 8 { (0, 0, 0) } else { (1, 1, 1) };
    check(
        &mut errors,
        native.document_generation == lifecycle.0
            && native.page_load_starts == lifecycle.1
            && native.page_load_finishes == lifecycle.2,
        "window-drag-document-lifecycle-mismatch",
    );
    check(
        &mut errors,
        valid_document_id(&native.document_id)
            && dom.document_id == native.document_id
            && valid_document_id(&dom.document_id),
        "window-drag-document-identity-mismatch",
    );
    if let Some(previous) = previous_stages.last() {
        let same_document = if index == 8 {
            dom.document_id != previous.dom.document_id
                && native.document_id != previous.native.document_id
        } else {
            dom.document_id == previous.dom.document_id
                && native.document_id == previous.native.document_id
        };
        check(
            &mut errors,
            same_document,
            "window-drag-document-identity-transition-invalid",
        );
    }

    if index == 0 {
        check(
            &mut errors,
            native.locked == Some(false),
            "window-drag-baseline-locked",
        );
        check(
            &mut errors,
            points_equal(dom.position_read, native.position, 0.75),
            "window-drag-position-read-mismatch",
        );
        check(
            &mut errors,
            dom.drag.position_reads >= 1
                && dom.drag.dispatched_positions >= 1
                && dom.renderer_window_drag_calls >= 1,
            "window-drag-baseline-position-read-missing",
        );
    } else if let Some(previous) = previous_stages.last() {
        check(
            &mut errors,
            (index == 8) == dom.position_read.is_some(),
            "window-drag-unexpected-position-read",
        );
        match stage {
            "dragged" => {
                let dx = point_delta(native.position, previous.native.position, true);
                let dy = point_delta(native.position, previous.native.position, false);
                check(
                    &mut errors,
                    native.locked == Some(true),
                    "window-drag-move-not-locked",
                );
                check(
                    &mut errors,
                    dx.is_some_and(|value| (value - 20.0).abs() <= 1.0)
                        && dy.is_some_and(|value| (value - 15.0).abs() <= 1.0),
                    "window-drag-position-delta-mismatch",
                );
                check(
                    &mut errors,
                    dimensions_equal(native.inner_size, previous.native.inner_size, 0.75),
                    "window-drag-size-changed-during-move",
                );
                check(
                    &mut errors,
                    dom.drag.position_reads > previous.dom.drag.position_reads
                        && dom.drag.dispatched_positions > previous.dom.drag.dispatched_positions
                        && dom.drag.lock_requests > previous.dom.drag.lock_requests
                        && dom.drag.dispatched_locks > previous.dom.drag.dispatched_locks
                        && dom.drag.move_requests
                            >= previous.dom.drag.move_requests.saturating_add(3)
                        && dom.drag.dispatched_moves > previous.dom.drag.dispatched_moves
                        && dom.drag.coalesced_moves > previous.dom.drag.coalesced_moves
                        && dom.renderer_window_drag_calls > previous.dom.renderer_window_drag_calls,
                    "window-drag-production-api-dispatch-missing",
                );
            }
            "resized" => {
                check(
                    &mut errors,
                    native.locked == Some(true),
                    "window-drag-resize-not-locked",
                );
                check(
                    &mut errors,
                    dimensions_equal_width_and_grew(native.inner_size, previous.native.inner_size),
                    "window-drag-resize-not-observed",
                );
                check(
                    &mut errors,
                    dom.expand_window_calls > previous.dom.expand_window_calls,
                    "window-drag-resize-api-not-dispatched",
                );
            }
            "released" => {
                check(
                    &mut errors,
                    native.locked == Some(false),
                    "window-drag-release-not-observed",
                );
                check(
                    &mut errors,
                    dimensions_equal(native.inner_size, previous.native.inner_size, 0.75)
                        && points_equal(native.position, previous.native.position, 1.0),
                    "window-drag-release-geometry-changed",
                );
                check(
                    &mut errors,
                    dom.drag.lock_requests > previous.dom.drag.lock_requests
                        && dom.drag.dispatched_locks > previous.dom.drag.dispatched_locks,
                    "window-drag-unlock-api-not-dispatched",
                );
            }
            "restored" => {
                check(
                    &mut errors,
                    native.locked == Some(false),
                    "window-drag-final-lock-active",
                );
                let baseline = previous_stages.first();
                check(
                    &mut errors,
                    baseline.is_some_and(|baseline| {
                        points_equal(native.position, baseline.native.position, 1.0)
                            && dimensions_equal(native.inner_size, baseline.native.inner_size, 0.75)
                    }),
                    "window-drag-baseline-geometry-not-restored",
                );
                check(
                    &mut errors,
                    dom.drag.move_requests > previous.dom.drag.move_requests
                        && dom.drag.dispatched_moves > previous.dom.drag.dispatched_moves
                        && dom.expand_window_calls > previous.dom.expand_window_calls,
                    "window-drag-restore-api-not-dispatched",
                );
            }
            "hide-locked" => {
                check(
                    &mut errors,
                    native.locked == Some(true)
                        && dimensions_equal(native.inner_size, previous.native.inner_size, 0.75)
                        && points_equal(native.position, previous.native.position, 1.0),
                    "window-drag-hide-lock-not-observed",
                );
                check(
                    &mut errors,
                    dom.drag.lock_requests > previous.dom.drag.lock_requests
                        && dom.drag.dispatched_locks > previous.dom.drag.dispatched_locks
                        && dom.renderer_window_drag_calls > previous.dom.renderer_window_drag_calls
                        && dom.hide_window_calls == previous.dom.hide_window_calls,
                    "window-drag-hide-lock-api-not-dispatched",
                );
            }
            "hidden-cleared" => {
                check(
                    &mut errors,
                    native.locked == Some(false)
                        && dimensions_equal(native.inner_size, previous.native.inner_size, 0.75)
                        && points_equal(native.position, previous.native.position, 1.0),
                    "window-drag-hide-did-not-clear-lock",
                );
                check(
                    &mut errors,
                    dom.hide_window_calls > previous.dom.hide_window_calls,
                    "window-drag-hide-api-not-dispatched",
                );
            }
            "redragged" => {
                let dx = point_delta(native.position, previous.native.position, true);
                let dy = point_delta(native.position, previous.native.position, false);
                check(
                    &mut errors,
                    native.locked == Some(true)
                        && dx.is_some_and(|value| (value - 8.0).abs() <= 1.0)
                        && dy.is_some_and(|value| (value - 6.0).abs() <= 1.0)
                        && dimensions_equal(native.inner_size, previous.native.inner_size, 0.75),
                    "window-drag-post-hide-redrag-not-observed",
                );
                check(
                    &mut errors,
                    dom.drag.lock_requests > previous.dom.drag.lock_requests
                        && dom.drag.dispatched_locks > previous.dom.drag.dispatched_locks
                        && dom.drag.move_requests > previous.dom.drag.move_requests
                        && dom.drag.dispatched_moves > previous.dom.drag.dispatched_moves
                        && dom.renderer_window_drag_calls > previous.dom.renderer_window_drag_calls
                        && dom.hide_window_calls == previous.dom.hide_window_calls,
                    "window-drag-post-hide-redrag-api-not-dispatched",
                );
            }
            "navigated" => {
                check(
                    &mut errors,
                    native.locked == Some(false)
                        && points_equal(dom.position_read, native.position, 0.75)
                        && dimensions_equal(native.inner_size, previous.native.inner_size, 0.75)
                        && points_equal(native.position, previous.native.position, 1.0),
                    "window-drag-navigation-reset-not-observed",
                );
                check(
                    &mut errors,
                    dom.drag.position_reads == 1
                        && dom.drag.dispatched_positions == 1
                        && dom.drag.lock_requests == 0
                        && dom.drag.move_requests == 0
                        && dom.drag.dispatched_locks == 0
                        && dom.drag.dispatched_moves == 0
                        && dom.renderer_window_drag_calls == 1
                        && dom.hide_window_calls == 0,
                    "window-drag-new-document-adapter-not-fresh",
                );
            }
            "recovered" => {
                check(
                    &mut errors,
                    native.locked == Some(false)
                        && previous_stages.first().is_some_and(|baseline| {
                            points_equal(native.position, baseline.native.position, 1.0)
                                && dimensions_equal(
                                    native.inner_size,
                                    baseline.native.inner_size,
                                    0.75,
                                )
                        }),
                    "window-drag-post-navigation-geometry-not-restored",
                );
                check(
                    &mut errors,
                    dom.drag.lock_requests > previous.dom.drag.lock_requests
                        && dom.drag.dispatched_locks > previous.dom.drag.dispatched_locks
                        && dom.drag.move_requests > previous.dom.drag.move_requests
                        && dom.drag.dispatched_moves > previous.dom.drag.dispatched_moves
                        && dom.expand_window_calls > previous.dom.expand_window_calls
                        && dom.renderer_window_drag_calls > previous.dom.renderer_window_drag_calls
                        && dom.hide_window_calls == 0,
                    "window-drag-post-navigation-restore-api-not-dispatched",
                );
            }
            _ => check(&mut errors, false, "window-drag-stage-invalid"),
        }
    } else {
        check(&mut errors, false, "window-drag-previous-stage-missing");
    }
    errors
}

fn valid_document_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn point_delta(current: Option<Point>, previous: Option<Point>, x_axis: bool) -> Option<f64> {
    let current = current?;
    let previous = previous?;
    Some(if x_axis {
        current.x - previous.x
    } else {
        current.y - previous.y
    })
}

fn points_equal(left: Option<Point>, right: Option<Point>, tolerance: f64) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            (left.x - right.x).abs() <= tolerance && (left.y - right.y).abs() <= tolerance
        }
        _ => false,
    }
}

fn dimensions_equal(left: Option<Dimensions>, right: Option<Dimensions>, tolerance: f64) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            (left.width - right.width).abs() <= tolerance
                && (left.height - right.height).abs() <= tolerance
        }
        _ => false,
    }
}

fn dimensions_equal_width_and_grew(left: Option<Dimensions>, right: Option<Dimensions>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            (left.width - right.width).abs() <= 0.75
                && left.height > right.height + 8.0
                && left.height <= right.height + 40.0
        }
        _ => false,
    }
}

fn check(errors: &mut Vec<&'static str>, valid: bool, error: &'static str) {
    if !valid && !errors.contains(&error) {
        errors.push(error);
    }
}
