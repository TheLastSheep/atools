use super::{
    history_expectations::history_matches, native::NativeCapture, protocol::Harness, report,
};
use crate::renderer_desktop_smoke::profile::{LaunchTargetKind, RegistrationSource};
use serde_json::Value;

pub(super) fn phase_error(
    stage: &str,
    dom: &Value,
    capture: &NativeCapture,
    first_probe: &Value,
    second_probe: &Value,
    target_kind: LaunchTargetKind,
    registration_source: RegistrationSource,
) -> Option<&'static str> {
    let second_name = if registration_source == RegistrationSource::SettingsChild {
        "AToolsOwnedProbeSecond.app"
    } else {
        "AToolsOwnedProbeSecond"
    };
    let native = &capture.value;
    if !dom_common(dom, stage == "disposed") || !native_common(native) {
        return Some("launch-return-hidden-observation-incomplete");
    }
    let calls = dom.pointer("/adapter/launchCalls").and_then(Value::as_u64);
    let events = native
        .pointer("/appLaunchedWitness/deliveredEvents")
        .and_then(Value::as_u64);
    let task_runs = native.get("taskRuns");
    let audits = native.get("audits");
    let history = native.get("history");
    let probes = native.get("probes");
    let lock_requests = dom
        .pointer("/adapter/windowDrag/lockRequests")
        .and_then(Value::as_u64);
    let dispatched_locks = dom
        .pointer("/adapter/windowDrag/dispatchedLocks")
        .and_then(Value::as_u64);
    let size_locked = native
        .pointer("/window/sizeLocked")
        .and_then(Value::as_bool);
    let input = dom.get("inputValue").and_then(Value::as_str);
    let pasted = dom.get("pastedText").and_then(Value::as_str);
    let selected = dom.get("selectedTitle").and_then(Value::as_str);
    let app_target = native
        .pointer("/appLaunchedWitness/targetLabel")
        .and_then(Value::as_str);
    let app_payload_null = native
        .pointer("/appLaunchedWitness/payloadIsNull")
        .and_then(Value::as_bool);

    let expected = match stage {
        "baseline" => {
            input == Some("")
                && pasted == Some("")
                && selected == Some("")
                && calls == Some(0)
                && events == Some(0)
                && counter(task_runs, "total") == Some(0)
                && counter(audits, "denied") == Some(0)
                && counter(audits, "confirmed") == Some(0)
                && history_matches(history, target_kind, 0, 0, 0)
                && lock_requests == Some(0)
                && dispatched_locks == Some(0)
                && size_locked == Some(false)
                && probe_count(probes, "started") == Some(0)
                && probe_count(probes, "exited") == Some(0)
                && probe_matches(first_probe, false)
                && probe_matches(second_probe, false)
        }
        "pasted" => {
            input == Some("")
                && pasted.is_some_and(|text| text.contains("AToolsOwnedProbeFirst"))
                && selected == Some("")
                && action(dom, "metaFDefaultPrevented") == Some(true)
                && calls == Some(0)
                && events == Some(0)
                && counter(task_runs, "total") == Some(0)
                && history_matches(history, target_kind, 0, 0, 0)
                && lock_requests == Some(1)
                && dispatched_locks == Some(1)
                && size_locked == Some(true)
                && probe_matches(first_probe, false)
                && probe_matches(second_probe, false)
        }
        "denied" => {
            input == Some("")
                && pasted.is_some_and(|text| text.contains("AToolsOwnedProbeFirst"))
                && action(dom, "launchRejected") == Some(true)
                && calls == Some(1)
                && events == Some(0)
                && counter(task_runs, "total") == Some(1)
                && counter(task_runs, "cancelled") == Some(1)
                && counter(task_runs, "succeeded") == Some(0)
                && counter(audits, "denied") == Some(1)
                && counter(audits, "confirmed") == Some(0)
                && history_matches(history, target_kind, 0, 0, 0)
                && lock_requests == Some(1)
                && dispatched_locks == Some(1)
                && size_locked == Some(true)
                && probe_count(probes, "started") == Some(0)
                && probe_matches(first_probe, false)
                && probe_matches(second_probe, false)
        }
        "direct-return" => {
            input == Some("")
                && pasted == Some("")
                && selected == Some("")
                && action(dom, "launchResolved") == Some(true)
                && calls == Some(2)
                && events == Some(1)
                && app_target == Some("main")
                && app_payload_null == Some(true)
                && counter(task_runs, "total") == Some(2)
                && counter(task_runs, "cancelled") == Some(1)
                && counter(task_runs, "succeeded") == Some(1)
                && counter(audits, "denied") == Some(1)
                && counter(audits, "confirmed") == Some(1)
                && history_matches(history, target_kind, 1, 1, 0)
                && lock_requests == Some(1)
                && dispatched_locks == Some(1)
                && size_locked == Some(false)
                && probe_count(probes, "started") == Some(1)
                && probe_count(probes, "exited") == Some(1)
                && probe_count(probes, "liveProcesses") == Some(0)
                && probe_matches(first_probe, true)
                && probe_matches(second_probe, false)
        }
        "typed" => {
            input == Some("AToolsOwnedProbe")
                && pasted == Some("")
                && selected == Some(second_name)
                && action(dom, "arrowDownDefaultPrevented") == Some(true)
                && calls == Some(2)
                && events == Some(1)
                && counter(task_runs, "total") == Some(2)
                && history_matches(history, target_kind, 1, 1, 0)
                && lock_requests == Some(2)
                && dispatched_locks == Some(2)
                && size_locked == Some(true)
                && probe_count(probes, "started") == Some(1)
                && probe_count(probes, "exited") == Some(1)
                && probe_matches(first_probe, true)
                && probe_matches(second_probe, false)
        }
        "keyboard-return" => {
            input == Some("")
                && pasted == Some("")
                && selected == Some("")
                && action(dom, "enterDefaultPrevented") == Some(true)
                && action(dom, "launchResolved") == Some(true)
                && calls == Some(3)
                && events == Some(2)
                && app_target == Some("main")
                && app_payload_null == Some(true)
                && counter(task_runs, "total") == Some(3)
                && counter(task_runs, "cancelled") == Some(1)
                && counter(task_runs, "succeeded") == Some(2)
                && counter(audits, "denied") == Some(1)
                && counter(audits, "confirmed") == Some(2)
                && history_matches(history, target_kind, 2, 1, 1)
                && lock_requests == Some(2)
                && dispatched_locks == Some(2)
                && size_locked == Some(false)
                && probe_count(probes, "started") == Some(2)
                && probe_count(probes, "exited") == Some(2)
                && probe_count(probes, "liveProcesses") == Some(0)
                && probe_matches(first_probe, true)
                && probe_matches(second_probe, true)
        }
        "disposed" => {
            input == Some("")
                && pasted == Some("")
                && selected == Some("")
                && calls == Some(3)
                && events == Some(2)
                && app_target == Some("main")
                && app_payload_null == Some(true)
                && lock_requests == Some(2)
                && dispatched_locks == Some(2)
                && size_locked == Some(false)
                && counter(task_runs, "total") == Some(3)
                && history_matches(history, target_kind, 2, 1, 1)
                && adapter_disposed(dom)
                && probe_count(probes, "started") == Some(2)
                && probe_count(probes, "exited") == Some(2)
                && probe_count(probes, "liveProcesses") == Some(0)
                && probe_matches(first_probe, true)
                && probe_matches(second_probe, true)
        }
        _ => false,
    };
    let audit_links = match stage {
        "denied" => capture.audit_links.first_denied == Some(true),
        "direct-return" | "typed" => {
            capture.audit_links.first_denied == Some(true)
                && capture.audit_links.first_succeeded == Some(true)
        }
        "keyboard-return" | "disposed" => {
            capture.audit_links.first_denied == Some(true)
                && capture.audit_links.first_succeeded == Some(true)
                && capture.audit_links.second_succeeded == Some(true)
        }
        _ => true,
    };
    if expected && audit_links {
        None
    } else {
        Some(stage_error(stage))
    }
}

fn dom_common(dom: &Value, disposed: bool) -> bool {
    let local_events = dom.pointer("/adapter/listeners/localShortcutEvents");
    let local_event_state = local_events
        .and_then(|value| value.get("listenerState"))
        .and_then(Value::as_str);
    let local_subscribers = local_events
        .and_then(|value| value.get("subscribers"))
        .and_then(Value::as_u64);
    dom.get("visibility").and_then(Value::as_str) == Some("hidden")
        && dom.get("documentHasFocus").and_then(Value::as_bool) == Some(false)
        && dom.get("inputFocused").and_then(Value::as_bool).is_some()
        && dom
            .pointer("/adapter/outstandingNativeCalls")
            .and_then(Value::as_u64)
            == Some(0)
        && dom
            .pointer("/adapter/windowDrag/pending")
            .and_then(Value::as_u64)
            == Some(0)
        && dom
            .pointer("/adapter/windowDrag/queued")
            .and_then(Value::as_u64)
            == Some(0)
        && dom
            .pointer("/adapter/windowDrag/inFlight")
            .is_some_and(Value::is_null)
        && settings_input_matches(dom, disposed)
        && local_event_state == Some(if disposed { "disposed" } else { "listening" })
        && (if disposed {
            local_subscribers == Some(0)
        } else {
            local_subscribers.is_some_and(|n| n > 0)
        })
        && local_events
            .and_then(|value| value.get("invalidEvents"))
            .and_then(Value::as_u64)
            == Some(0)
        && local_events
            .and_then(|value| value.get("staleEvents"))
            .and_then(Value::as_u64)
            == Some(0)
        && local_events
            .and_then(|value| value.get("registrationErrors"))
            .and_then(Value::as_u64)
            == Some(0)
        && local_events
            .and_then(|value| value.get("callbackErrors"))
            .and_then(Value::as_u64)
            == Some(0)
        && local_events
            .and_then(|value| value.get("registrationsPending"))
            .and_then(Value::as_u64)
            == Some(0)
        && local_events
            .and_then(|value| value.get("cleanupPending"))
            .and_then(Value::as_u64)
            == Some(0)
        && local_events
            .and_then(|value| value.get("cleanupErrors"))
            .and_then(Value::as_u64)
            == Some(0)
        && (!disposed
            || local_events
                .and_then(|value| value.get("latestRevision"))
                .is_some_and(Value::is_null)
                && local_events
                    .and_then(|value| value.get("replayPending"))
                    .and_then(Value::as_bool)
                    == Some(false))
        && adapter_errors_zero(dom)
}

pub(super) fn settings_input_matches(dom: &Value, disposed: bool) -> bool {
    let settings_view = dom.pointer("/adapter/listeners/settingsView");
    let input = settings_view.and_then(|value| value.get("input"));
    let callbacks = if disposed { 0 } else { 5 };
    settings_view
        .and_then(|value| value.get("listenerState"))
        .and_then(Value::as_str)
        == Some(if disposed { "disposed" } else { "listening" })
        && input
            .and_then(|value| value.get("callbacks"))
            .and_then(Value::as_u64)
            == Some(callbacks)
        && [
            "invalidPayloads",
            "stalePayloads",
            "callbackErrors",
            "notifyFailures",
            "staleReplies",
        ]
        .iter()
        .all(|key| {
            input
                .and_then(|value| value.get(*key))
                .and_then(Value::as_u64)
                == Some(0)
        })
        && input
            .and_then(|value| value.get("notifyPending"))
            .and_then(Value::as_bool)
            == Some(false)
        && input
            .and_then(|value| value.get("notifyInFlight"))
            .and_then(Value::as_bool)
            == Some(false)
        && input
            .and_then(|value| value.get("disposed"))
            .and_then(Value::as_bool)
            == Some(disposed)
}

fn native_common(native: &Value) -> bool {
    native.pointer("/window/visible").and_then(Value::as_bool) == Some(false)
        && native.pointer("/window/focused").and_then(Value::as_bool) == Some(false)
        && native.get("focusGainedEvents").and_then(Value::as_u64) == Some(0)
        && native.get("childWebviews").and_then(Value::as_u64) == Some(0)
        && native.get("activeChildLayouts").and_then(Value::as_u64) == Some(0)
        && native.get("wkStorePersistent").and_then(Value::as_bool) == Some(false)
        && native
            .pointer("/appLaunchedWitness/targetLabel")
            .and_then(Value::as_str)
            == Some("main")
        && native
            .pointer("/probes/pendingLaunches")
            .and_then(Value::as_u64)
            == Some(0)
}

fn adapter_errors_zero(dom: &Value) -> bool {
    let Some(listeners) = dom.pointer("/adapter/listeners") else {
        return false;
    };
    let source_groups = [
        listeners.get("focusEvents"),
        listeners.pointer("/appState/eventSource"),
        listeners.pointer("/appCatalog/eventSource"),
        listeners.pointer("/appLaunched/eventSource"),
        listeners.pointer("/contextMenu/eventSource"),
    ];
    if !source_groups.into_iter().all(|source| {
        source.is_some_and(|source| {
            ["registrationErrors", "callbackErrors", "cleanupErrors"]
                .iter()
                .all(|key| source.get(*key).and_then(Value::as_u64) == Some(0))
        })
    }) {
        return false;
    }
    listeners
        .pointer("/settingsView/registrationErrors")
        .and_then(Value::as_u64)
        == Some(0)
        && listeners
            .pointer("/settingsView/cleanupErrors")
            .and_then(Value::as_u64)
            == Some(0)
        && listeners
            .pointer("/generalPreferenceEvents/invalidPayloads")
            .and_then(Value::as_u64)
            == Some(0)
}

fn adapter_disposed(dom: &Value) -> bool {
    let Some(listeners) = dom.pointer("/adapter/listeners") else {
        return false;
    };
    let source_groups = [
        listeners.get("focusEvents"),
        listeners.pointer("/appState/eventSource"),
        listeners.pointer("/appCatalog/eventSource"),
        listeners.pointer("/appLaunched/eventSource"),
        listeners.pointer("/contextMenu/eventSource"),
    ];
    source_groups.into_iter().all(|source| {
        source.is_some_and(|source| {
            source.get("listenerState").and_then(Value::as_str) == Some("disposed")
                && source.get("subscribers").and_then(Value::as_u64) == Some(0)
                && source.get("registrationsPending").and_then(Value::as_u64) == Some(0)
                && source.get("cleanupPending").and_then(Value::as_u64) == Some(0)
        })
    }) && listeners
        .pointer("/settingsView/listenerState")
        .and_then(Value::as_str)
        == Some("disposed")
        && dom
            .pointer("/adapter/windowDrag/disposed")
            .and_then(Value::as_bool)
            == Some(true)
        && dom
            .pointer("/adapter/windowDrag/pending")
            .and_then(Value::as_u64)
            == Some(0)
        && dom
            .pointer("/adapter/windowDrag/queued")
            .and_then(Value::as_u64)
            == Some(0)
        && dom
            .pointer("/adapter/outstandingNativeCalls")
            .and_then(Value::as_u64)
            == Some(0)
}

fn counter(value: Option<&Value>, key: &str) -> Option<u64> {
    value?.get(key)?.as_u64()
}

fn probe_count(value: Option<&Value>, key: &str) -> Option<u64> {
    value?.get(key)?.as_u64()
}

fn probe_matches(probe: &Value, expected_started: bool) -> bool {
    let marker = probe.get("marker");
    let background_only = probe.get("backgroundOnly").and_then(Value::as_bool) == Some(true);
    if !background_only {
        return false;
    }
    let started = marker
        .and_then(|value| value.get("started"))
        .and_then(Value::as_bool);
    let exiting = marker
        .and_then(|value| value.get("exiting"))
        .and_then(Value::as_bool);
    if expected_started {
        started == Some(true)
            && exiting == Some(true)
            && marker
                .and_then(|value| value.get("runIdMatched"))
                .and_then(Value::as_bool)
                == Some(true)
            && marker
                .and_then(|value| value.get("probeIdMatched"))
                .and_then(Value::as_bool)
                == Some(true)
            && marker
                .and_then(|value| value.get("pid"))
                .and_then(Value::as_u64)
                .is_some_and(|pid| pid > 0)
            && marker
                .and_then(|value| value.get("processTerminal"))
                .and_then(Value::as_bool)
                == Some(true)
    } else {
        started == Some(false)
            && exiting == Some(false)
            && marker
                .and_then(|value| value.get("pid"))
                .is_some_and(Value::is_null)
    }
}

fn action(dom: &Value, key: &str) -> Option<bool> {
    dom.pointer(&format!("/actions/{key}"))?.as_bool()
}

pub(super) fn stage_native_count(harness: &Harness, index: usize, path: &[&str]) -> Option<u64> {
    let native = harness.stage_native(index)?;
    path.iter()
        .try_fold(&native, |value, key| value.get(*key))?
        .as_u64()
}

pub(super) fn mark_stage_unobserved(harness: &Harness, index: usize, error: &'static str) {
    harness.set_stage(
        index,
        report::unknown_dom(),
        report::empty_native(),
        false,
        Some(error),
    );
}

fn stage_error(stage: &str) -> &'static str {
    match stage {
        "baseline" => "launch-return-baseline-observation-failed",
        "pasted" => "launch-return-paste-path-not-verified",
        "denied" => "launch-return-denied-launch-not-verified",
        "direct-return" => "launch-return-direct-return-not-verified",
        "typed" => "launch-return-second-selection-not-verified",
        "keyboard-return" => "launch-return-keyboard-return-not-verified",
        "disposed" => "launch-return-disposal-not-verified",
        _ => "launch-return-stage-not-verified",
    }
}
