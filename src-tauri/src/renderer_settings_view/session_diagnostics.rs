use serde_json::Value;

use super::SettingsViewRuntime;

pub(super) fn snapshot(
    runtime: &SettingsViewRuntime,
    child_present: bool,
    layout_count: Option<usize>,
) -> Value {
    let activity = runtime.accounting().snapshot();
    let Ok(inner) = runtime.inner.lock() else {
        return serde_json::json!({
            "sessionCount":0,
            "bundleCached":false,
            "runtimeInitialized":true,
            "stateAvailable":false,
            "pendingCalls":activity.pending_calls,
            "pendingWrites":activity.pending_writes,
        });
    };
    let session = inner.session.as_ref();
    let signal = session.map(|value| value.signals.borrow().clone());
    let command_data = session.map(|value| value.command_data.diagnostics());
    let input = session.map(|value| value.sub_input.diagnostics());
    serde_json::json!({
        "sessionCount": if session.is_some() { 1 } else { 0 },
        "bundleCached": inner.cached_bundle.is_some(),
        "runtimeInitialized": true,
        "stateAvailable": true,
        "bundleLoadActive": runtime.bundle_load_active.load(std::sync::atomic::Ordering::Acquire),
        "bundleResourceCount": inner.cached_bundle.as_ref().map_or(0, |bundle| bundle.resource_count()),
        "bundleBytes": inner.cached_bundle.as_ref().map_or(0, |bundle| bundle.total_bytes()),
        "phase": signal.as_ref().map(|value| value.phase.as_str()),
        "documentAuthorized": session.is_some_and(|value| value.index_consumed && !value.revoked.load(std::sync::atomic::Ordering::Acquire)),
        "ready": signal.as_ref().is_some_and(|value| value.ready),
        "revoked": session.is_none_or(|value| value.revoked.load(std::sync::atomic::Ordering::Acquire)),
        "childPresent": child_present,
        "pendingCalls": activity.pending_calls,
        "pendingWrites": activity.pending_writes,
        "layoutLeasePresent": session.is_some_and(|value| value.layout_lease.is_some()),
        "layoutRegistrationCount": layout_count,
        "bundleRevisionPresent": session.is_some_and(|value| !value.bundle_revision.is_empty()),
        "commandSnapshotBytes": command_data.map_or(0, |value| value.0),
        "aliasSnapshotBytes": command_data.map_or(0, |value| value.1),
        "commandSettingsSnapshotBytes": session.map_or(0, |value| value.command_data.command_settings_bytes()),
        "stagedAliasWriteBytes": command_data.map_or(0, |value| value.2),
        "commandDataClosed": command_data.is_some_and(|value| value.3),
        "subInput": {
            "closed": input.is_none_or(|value| value.closed),
            "visible": input.is_some_and(|value| value.visible),
            "generation": input.map_or(0, |value| value.generation),
            "controlSequence": input.map_or(0, |value| value.control_sequence),
            "userSequence": input.map_or(0, |value| value.user_sequence),
            "revision": input.map_or(0, |value| value.revision),
            "valueVersion": input.map_or(0, |value| value.value_version),
            "valueBytes": input.map_or(0, |value| value.value_bytes),
            "placeholderBytes": input.map_or(0, |value| value.placeholder_bytes),
        },
    })
}
