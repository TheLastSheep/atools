use crate::renderer_desktop_smoke::launcher_journey::{
    evidence::DatabaseEvidence,
    process::{self, ProbeObservation},
};
use crate::renderer_desktop_smoke::profile::LaunchTargetKind;
use atools_core::db::RendererDirectSubtype;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Listener, Manager, Webview, Window, WindowEvent, Wry};

const APP_LAUNCHED_EVENT: &str = "atools://renderer-app-launched";

#[derive(Default)]
pub(super) struct Witness {
    delivered: AtomicUsize,
    invalid_payloads: AtomicUsize,
    focus_gained: AtomicUsize,
    focus_notify: tokio::sync::Notify,
    bound_to_main: AtomicBool,
    listener_id: Mutex<Option<tauri::EventId>>,
}

impl Witness {
    pub(super) fn focus_gained(&self) -> usize {
        self.focus_gained.load(Ordering::Acquire)
    }
    pub(super) async fn wait_for_focus(&self) {
        while self.focus_gained() == 0 {
            self.focus_notify.notified().await;
        }
    }
    fn snapshot(&self) -> (usize, Option<bool>) {
        let delivered = self.delivered.load(Ordering::Acquire);
        let invalid = self.invalid_payloads.load(Ordering::Acquire);
        let payload_is_null = if delivered == 0 {
            None
        } else {
            Some(invalid == 0)
        };
        (delivered, payload_is_null)
    }
}

pub(super) struct NativeCapture {
    pub(super) value: Value,
    pub(super) first_probe: Value,
    pub(super) second_probe: Value,
    pub(super) audit_links: AuditLinks,
}

#[derive(Clone, Copy)]
pub(super) struct AuditLinks {
    pub(super) first_denied: Option<bool>,
    pub(super) first_succeeded: Option<bool>,
    pub(super) second_succeeded: Option<bool>,
}

impl AuditLinks {
    fn unknown() -> Self {
        Self {
            first_denied: None,
            first_succeeded: None,
            second_succeeded: None,
        }
    }
}

#[derive(Clone, Copy)]
struct ProbeStatus {
    started: Option<bool>,
    exiting: Option<bool>,
    run_id_matched: Option<bool>,
    probe_id_matched: Option<bool>,
    pid: Option<u32>,
    terminal: Option<bool>,
}

impl ProbeStatus {
    fn absent() -> Self {
        Self {
            started: Some(false),
            exiting: Some(false),
            run_id_matched: None,
            probe_id_matched: None,
            pid: None,
            terminal: None,
        }
    }

    fn unknown() -> Self {
        Self {
            started: None,
            exiting: None,
            run_id_matched: None,
            probe_id_matched: None,
            pid: None,
            terminal: None,
        }
    }

    fn from_observation(observation: ProbeObservation) -> Self {
        if !observation.started {
            return Self::unknown();
        }
        let identity_matches = observation.run_id_matched && observation.probe_id_matched;
        Self {
            started: Some(true),
            exiting: identity_matches.then_some(observation.exit_marker),
            run_id_matched: Some(observation.run_id_matched),
            probe_id_matched: Some(observation.probe_id_matched),
            pid: observation.pid,
            terminal: identity_matches.then_some(observation.terminal),
        }
    }

    fn to_value(self, probe_id: &str) -> Value {
        json!({
            "probeId": probe_id,
            "bundleName": super::report::bundle_name(probe_id),
            "backgroundOnly": true,
            "marker": {
                "started": self.started,
                "exiting": self.exiting,
                "runIdMatched": self.run_id_matched,
                "probeIdMatched": self.probe_id_matched,
                "pid": self.pid,
                "processTerminal": self.terminal
            }
        })
    }
}

pub(super) fn install_witness(
    app: &AppHandle<Wry>,
    harness: &super::protocol::Harness,
) -> Result<(), String> {
    let webview = crate::window::main_webview(app).map_err(|error| error.to_string())?;
    if webview.label() != "main" || webview.window().label() != "main" {
        return Err("launch-return-native-witness-main-target-rejected".to_owned());
    }
    let witness = Arc::clone(&harness.witness);
    let listener_id = webview.listen(APP_LAUNCHED_EVENT, move |event| {
        witness.delivered.fetch_add(1, Ordering::AcqRel);
        if serde_json::from_str::<Value>(event.payload()).ok() != Some(Value::Null) {
            witness.invalid_payloads.fetch_add(1, Ordering::AcqRel);
        }
    });
    *harness.witness.listener_id.lock() = Some(listener_id);
    harness.witness.bound_to_main.store(true, Ordering::Release);
    Ok(())
}

pub(super) fn record_window_event(harness: &super::protocol::Harness, event: &WindowEvent) {
    if matches!(event, WindowEvent::Focused(true)) {
        harness.witness.focus_gained.fetch_add(1, Ordering::AcqRel);
        harness.witness.focus_notify.notify_one();
    }
}

pub(super) fn stop_witness(app: &AppHandle<Wry>, harness: &super::protocol::Harness) {
    if let Some(listener_id) = harness.witness.listener_id.lock().take() {
        app.unlisten(listener_id);
    }
}

pub(super) async fn capture(
    app: &AppHandle<Wry>,
    harness: &super::protocol::Harness,
    dom: &Value,
    stage: &str,
) -> NativeCapture {
    let (first_expected, second_expected) = match stage {
        "direct-return" => (true, false),
        "keyboard-return" | "disposed" => (true, true),
        _ => (false, false),
    };
    let first = observe_probe(
        harness.profile().root.as_path(),
        harness.profile().run_id.as_str(),
        "first",
        first_expected,
    )
    .await;
    let second = observe_probe(
        harness.profile().root.as_path(),
        harness.profile().run_id.as_str(),
        "second",
        second_expected,
    )
    .await;
    let evidence = DatabaseEvidence::read(&harness.database());
    let target_subtype = match harness.profile().launch_target_kind {
        LaunchTargetKind::App => RendererDirectSubtype::App,
        LaunchTargetKind::LocalShortcut => RendererDirectSubtype::LocalShortcut,
    };
    let (task_runs, audits, history, audit_links) = match evidence {
        Ok(evidence) => {
            let first_path = harness.first_path();
            let second_path = harness.second_path();
            let (first_name, second_name) = if harness.profile().registration_source
                == crate::renderer_desktop_smoke::profile::RegistrationSource::SettingsChild
            {
                ("AToolsOwnedProbeFirst.app", "AToolsOwnedProbeSecond.app")
            } else {
                ("AToolsOwnedProbeFirst", "AToolsOwnedProbeSecond")
            };
            let task_runs = json!({
                "total": evidence.task_run_count(),
                "cancelled": evidence.denied_run_count(first_path) + evidence.denied_run_count(second_path),
                "succeeded": evidence.succeeded_run_count(first_path) + evidence.succeeded_run_count(second_path)
            });
            let audits = json!({
                "denied": evidence.denied_audit_count(first_path) + evidence.denied_audit_count(second_path),
                "confirmed": evidence.confirmed_audit_count(first_path) + evidence.confirmed_audit_count(second_path)
            });
            let history = json!({
                "items": evidence.history_count(),
                "firstUseCount": evidence.matching_history_use_count_for_subtype(first_path, first_name, target_subtype),
                "secondUseCount": evidence.matching_history_use_count_for_subtype(second_path, second_name, target_subtype),
                "appItems": evidence.history_count_for_subtype(RendererDirectSubtype::App),
                "localShortcutItems": evidence.history_count_for_subtype(RendererDirectSubtype::LocalShortcut)
            });
            let audit_links = AuditLinks {
                first_denied: Some(evidence.denied_audit(first_path)),
                first_succeeded: Some(evidence.succeeded_audit(first_path)),
                second_succeeded: Some(evidence.succeeded_audit(second_path)),
            };
            (task_runs, audits, history, audit_links)
        }
        Err(()) => (
            json!({ "total": null, "cancelled": null, "succeeded": null }),
            json!({ "denied": null, "confirmed": null }),
            json!({ "items": null, "firstUseCount": null, "secondUseCount": null, "appItems": null, "localShortcutItems": null }),
            AuditLinks::unknown(),
        ),
    };
    let window = crate::window::main_window(app).ok();
    let child_webviews = child_webview_count(app);
    let (delivered, payload_is_null) = harness.witness.snapshot();
    let size_locked = crate::renderer_window_drag::locked(app);
    let bounds = window.as_ref().and_then(read_bounds);
    let wk_store_persistent = main_wk_store_persistent(app).await;
    let pending = pending_launch_count(dom);
    let native = json!({
        "window": {
            "visible": window.as_ref().and_then(|window| window.is_visible().ok()),
            "focused": window.as_ref().and_then(|window| window.is_focused().ok()),
            "sizeLocked": size_locked,
            "bounds": bounds
        },
        "focusGainedEvents": harness.witness.focus_gained.load(Ordering::Acquire),
        "childWebviews": child_webviews,
        "activeChildLayouts": active_child_layouts(app),
        "wkStorePersistent": wk_store_persistent,
        "taskRuns": task_runs,
        "audits": audits,
        "history": history,
        "appLaunchedWitness": {
            "targetLabel": harness.witness.bound_to_main.load(Ordering::Acquire).then_some("main"),
            "deliveredEvents": delivered,
            "payloadIsNull": payload_is_null
        },
        "probes": {
            "started": count_bool([first.started, second.started], true),
            "exited": count_bool([first.exiting, second.exiting], true),
            "liveProcesses": live_process_count([first, second]),
            "pendingLaunches": pending
        }
    });
    NativeCapture {
        value: native,
        first_probe: first.to_value("first"),
        second_probe: second.to_value("second"),
        audit_links,
    }
}

async fn observe_probe(root: &Path, run_id: &str, probe_id: &str, expected: bool) -> ProbeStatus {
    if !expected && process::markers_absent_for(root, probe_id) {
        return ProbeStatus::absent();
    }
    let root = root.to_path_buf();
    let run_id = run_id.to_owned();
    let probe_id = probe_id.to_owned();
    tokio::task::spawn_blocking(move || {
        ProbeStatus::from_observation(process::observe_probe(
            root.as_path(),
            run_id.as_str(),
            probe_id.as_str(),
        ))
    })
    .await
    .unwrap_or_else(|_| ProbeStatus::unknown())
}

#[cfg(feature = "ztools-multiwebview")]
fn child_webview_count(app: &AppHandle<Wry>) -> Option<usize> {
    Some(
        app.webviews()
            .keys()
            .filter(|label| label.as_str() != "main")
            .count(),
    )
}

#[cfg(not(feature = "ztools-multiwebview"))]
fn child_webview_count(_app: &AppHandle<Wry>) -> Option<usize> {
    None
}

fn count_bool(values: [Option<bool>; 2], expected: bool) -> Option<usize> {
    values
        .into_iter()
        .try_fold(0_usize, |count, value| match value {
            Some(value) => Some(count + usize::from(value == expected)),
            None => None,
        })
}

fn live_process_count(probes: [ProbeStatus; 2]) -> Option<usize> {
    probes.into_iter().try_fold(0_usize, |count, probe| {
        match (probe.started, probe.terminal) {
            (Some(false), None) | (Some(true), Some(true)) => Some(count),
            (Some(true), Some(false)) => Some(count + 1),
            _ => None,
        }
    })
}

fn pending_launch_count(dom: &Value) -> Option<usize> {
    let adapter = dom.get("adapter")?;
    let outstanding = adapter.get("outstandingNativeCalls")?.as_u64()? as usize;
    let queued_mutations = adapter
        .get("listeners")?
        .get("appState")?
        .get("queuedMutations")?
        .as_u64()? as usize;
    let drag_pending = adapter.get("windowDrag")?.get("pending")?.as_u64()? as usize;
    outstanding
        .checked_add(queued_mutations)?
        .checked_add(drag_pending)
}

fn read_bounds(window: &Window<Wry>) -> Option<Value> {
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(json!({
        "x": position.x,
        "y": position.y,
        "width": size.width,
        "height": size.height
    }))
}

fn active_child_layouts(app: &AppHandle<Wry>) -> Option<usize> {
    #[cfg(feature = "ztools-multiwebview")]
    {
        crate::window::main_child_layout_active_count(app).ok()
    }
    #[cfg(not(feature = "ztools-multiwebview"))]
    {
        let _ = app;
        None
    }
}

async fn main_wk_store_persistent(app: &AppHandle<Wry>) -> Option<bool> {
    let webview = crate::window::main_webview(app).ok()?;
    read_webview_store(webview).await
}

#[cfg(all(target_os = "macos", feature = "legacy-node-smoke"))]
async fn read_webview_store(webview: Webview<Wry>) -> Option<bool> {
    use objc2::MainThreadMarker;
    use objc2_web_kit::WKWebView;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform| {
            let persistent = if MainThreadMarker::new().is_some() {
                let pointer = platform.inner();
                if pointer.is_null() {
                    None
                } else {
                    let native = unsafe { &*pointer.cast::<WKWebView>() };
                    let configuration = unsafe { native.configuration() };
                    let store = unsafe { configuration.websiteDataStore() };
                    Some(unsafe { store.isPersistent() })
                }
            } else {
                None
            };
            let _ = sender.send(persistent);
        })
        .ok()?;
    tokio::time::timeout(Duration::from_secs(3), receiver)
        .await
        .ok()?
        .ok()?
}

#[cfg(not(all(target_os = "macos", feature = "legacy-node-smoke")))]
async fn read_webview_store(_webview: Webview<Wry>) -> Option<bool> {
    None
}
