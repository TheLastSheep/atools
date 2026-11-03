use super::{
    report::{compute_passed, empty_report},
    schema::{valid_operation, validate_evidence},
};
use serde_json::Value;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{ipc::Invoke, AppHandle, Manager, State, Webview, Window, Wry};
use tokio::sync::oneshot;

const MAX_PROBE_BYTES: usize = 16 * 1024;
const COMMAND: &str = "settings_journey_probe";

struct PendingProbe {
    operation: String,
    generation: u8,
    caller_label: String,
    sender: oneshot::Sender<Value>,
}

struct Inner {
    enabled: bool,
    token: String,
    pending: Option<PendingProbe>,
    report: Value,
}

#[derive(Clone)]
pub(in crate::renderer_desktop_smoke) struct Harness(Arc<Mutex<Inner>>);

impl Harness {
    pub(in crate::renderer_desktop_smoke) fn new(enabled: bool) -> Self {
        Self(Arc::new(Mutex::new(Inner {
            enabled,
            token: uuid::Uuid::new_v4().simple().to_string(),
            pending: None,
            report: empty_report(enabled),
        })))
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(super) fn enabled(&self) -> bool {
        self.lock().enabled
    }

    pub(super) fn token(&self) -> String {
        self.lock().token.clone()
    }

    pub(super) fn begin(
        &self,
        operation: &str,
        generation: u8,
        caller_label: &str,
    ) -> Result<oneshot::Receiver<Value>, &'static str> {
        let mut inner = self.lock();
        if !inner.enabled {
            return Err("settings-journey-disabled");
        }
        if inner.pending.is_some() {
            return Err("settings-journey-probe-already-pending");
        }
        if !valid_operation(operation, generation, caller_label) {
            return Err("settings-journey-probe-operation-invalid");
        }
        let (sender, receiver) = oneshot::channel();
        inner.pending = Some(PendingProbe {
            operation: operation.to_owned(),
            generation,
            caller_label: caller_label.to_owned(),
            sender,
        });
        Ok(receiver)
    }

    pub(super) fn cancel(&self, operation: &str) {
        let mut inner = self.lock();
        if inner
            .pending
            .as_ref()
            .is_some_and(|pending| pending.operation == operation)
        {
            inner.pending = None;
        }
    }

    pub(super) fn record_error(&self, error: &'static str) {
        let mut inner = self.lock();
        if let Some(errors) = inner.report["errors"].as_array_mut() {
            if !errors.iter().any(|item| item.as_str() == Some(error)) {
                errors.push(Value::String(error.to_owned()));
            }
        }
        inner.report["passed"] = Value::Bool(false);
    }

    pub(super) fn set(&self, path: &[&str], value: Value) {
        let mut inner = self.lock();
        let mut cursor = &mut inner.report;
        for key in path.iter().take(path.len().saturating_sub(1)) {
            cursor = &mut cursor[*key];
        }
        if let Some(key) = path.last() {
            cursor[*key] = value;
        }
    }

    pub(super) fn snapshot(&self) -> Value {
        let mut inner = self.lock();
        let passed = compute_passed(&inner.report);
        inner.report["passed"] = Value::Bool(passed);
        inner.report.clone()
    }

    pub(super) fn unavailable_report() -> Value {
        let mut report = empty_report(true);
        report["errors"] = serde_json::json!(["settings-journey-harness-state-unavailable"]);
        report
    }

    pub(super) fn set_cleanup(&self, app: &AppHandle<Wry>) {
        let native = crate::renderer_settings_view::snapshot(app);
        let state_available = native.get("stateAvailable").and_then(Value::as_bool);
        let runtime_initialized = native.get("runtimeInitialized").and_then(Value::as_bool);
        let initialized = state_available == Some(true) && runtime_initialized == Some(true);
        let window = crate::window::main_window(app).ok();
        let views = window.as_ref().map(|window| owned_child_count(window));
        let layout = crate::window::main_child_layout_active_count(app).ok();
        let sessions = native.get("sessionCount").and_then(Value::as_u64);
        let pending_calls = native.get("pendingCalls").and_then(Value::as_u64);
        let pending_writes = native.get("pendingWrites").and_then(Value::as_u64);

        self.set(
            &["cleanup", "runtimeInitialized"],
            runtime_initialized.map_or(Value::Null, Value::Bool),
        );
        self.set(
            &["cleanup", "stateAvailable"],
            state_available.map_or(Value::Null, Value::Bool),
        );
        self.set(&["cleanup", "sessions"], option_count(sessions));
        self.set(
            &["cleanup", "childViews"],
            option_count(views.map(|value| value as u64)),
        );
        self.set(
            &["cleanup", "layoutRegistrations"],
            option_count(layout.map(|value| value as u64)),
        );
        self.set(&["cleanup", "pendingCalls"], option_count(pending_calls));
        self.set(&["cleanup", "pendingWrites"], option_count(pending_writes));
        self.set(&["cleanup", "bundleCached"], native["bundleCached"].clone());

        if !initialized {
            self.record_error("settings-runtime-diagnostics-unavailable");
        }
        if sessions != Some(0) {
            self.record_error("settings-session-cleanup-not-verified");
        }
        if views != Some(0) {
            self.record_error("settings-child-cleanup-not-verified");
        }
        if layout != Some(0) {
            self.record_error("settings-layout-cleanup-not-verified");
        }
        if pending_calls != Some(0) {
            self.record_error("settings-pending-calls-not-drained");
        }
        if pending_writes != Some(0) {
            self.record_error("settings-pending-writes-not-drained");
        }
    }

    fn accept(
        &self,
        app: &AppHandle<Wry>,
        webview: &Webview<Wry>,
        window: &Window<Wry>,
        token: &str,
        operation: &str,
        generation: u8,
        evidence: Value,
    ) -> Result<(), &'static str> {
        if token.len() != 32 || token != self.token() {
            return Err("settings-journey-probe-token-rejected");
        }
        if serde_json::to_vec(&evidence).map_or(true, |bytes| bytes.len() > MAX_PROBE_BYTES) {
            return Err("settings-journey-probe-exceeds-limit");
        }
        validate_evidence(operation, generation, &evidence)?;
        let caller = validate_caller(app, webview, window)?;
        let pending = {
            let mut inner = self.lock();
            if !inner.enabled {
                return Err("settings-journey-disabled");
            }
            let pending = inner
                .pending
                .take()
                .ok_or("settings-journey-unsolicited-probe")?;
            if pending.operation != operation
                || pending.generation != generation
                || pending.caller_label != caller
            {
                inner.pending = Some(pending);
                return Err("settings-journey-probe-correlation-rejected");
            }
            pending
        };
        let _ = pending.sender.send(evidence);
        Ok(())
    }
}

fn validate_caller(
    app: &AppHandle<Wry>,
    webview: &Webview<Wry>,
    window: &Window<Wry>,
) -> Result<String, &'static str> {
    if window.label() != "main" || webview.window().label() != "main" {
        return Err("settings-journey-probe-parent-rejected");
    }
    if webview.label() == "main" {
        if !super::super::controller::is_local_root_url(
            &webview
                .url()
                .map_err(|_| "settings-journey-main-url-unavailable")?,
        ) {
            return Err("settings-journey-main-root-url-rejected");
        }
        let actual = crate::window::main_webview(app)
            .map_err(|_| "settings-journey-main-webview-unavailable")?;
        if actual.label() != webview.label() {
            return Err("settings-journey-main-webview-identity-rejected");
        }
        return Ok("main".to_owned());
    }

    let id = webview
        .label()
        .strip_prefix("ztools-settings-")
        .filter(|id| valid_id(id))
        .ok_or("settings-journey-child-label-rejected")?;
    let expected = format!("atools-settings://{id}.localhost/index.html#/generalSetting");
    if webview
        .url()
        .map_err(|_| "settings-journey-child-url-unavailable")?
        .as_str()
        != expected
    {
        return Err("settings-journey-child-url-rejected");
    }
    let runtime = crate::renderer_settings_view::snapshot(app);
    if runtime["stateAvailable"].as_bool() != Some(true)
        || runtime["sessionCount"].as_u64() != Some(1)
        || runtime["childPresent"].as_bool() != Some(true)
        || runtime["ready"].as_bool() != Some(true)
    {
        return Err("settings-journey-child-not-current-native-session");
    }
    let window =
        crate::window::main_window(app).map_err(|_| "settings-journey-main-window-unavailable")?;
    let children = owned_children(&window);
    if children.len() != 1 || children[0].label() != webview.label() {
        return Err("settings-journey-child-not-unique-owned-webview");
    }
    Ok(webview.label().to_owned())
}

fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && uuid::Uuid::parse_str(id)
            .is_ok_and(|uuid| uuid.get_version_num() == 4 && uuid.simple().to_string() == id)
}

pub(super) fn owned_children(window: &tauri::Window<Wry>) -> Vec<Webview<Wry>> {
    window
        .webviews()
        .into_iter()
        .filter(|webview| {
            webview
                .label()
                .strip_prefix("ztools-settings-")
                .is_some_and(valid_id)
        })
        .collect()
}

pub(super) fn owned_child_count(window: &tauri::Window<Wry>) -> usize {
    owned_children(window).len()
}

pub(in crate::renderer_desktop_smoke) fn handles(command: &str) -> bool {
    command == COMMAND
}

pub(in crate::renderer_desktop_smoke) fn handler(
) -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![settings_journey_probe]
}

#[tauri::command]
fn settings_journey_probe(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    window: Window<Wry>,
    harness: State<'_, Harness>,
    token: String,
    operation: String,
    generation: u8,
    evidence: Value,
) -> Result<(), String> {
    (*harness)
        .accept(
            &app, &webview, &window, &token, &operation, generation, evidence,
        )
        .map_err(str::to_owned)
}

fn option_count(value: Option<u64>) -> Value {
    value.map_or(Value::Null, Value::from)
}
