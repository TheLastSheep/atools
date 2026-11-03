use super::focus_observation::FocusObservation;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::Url;
use tokio::sync::oneshot;

const MAX_REPORT_BYTES: usize = 8 * 1024;

struct PendingMain {
    operation: String,
    sender: oneshot::Sender<Value>,
}

struct PendingChild {
    nonce: String,
    generation: u8,
    kind: &'static str,
    sender: oneshot::Sender<Value>,
}

struct Inner {
    token: String,
    pending_main: Option<PendingMain>,
    pending_child: Option<PendingChild>,
    layout_lease: Option<crate::window::MainChildLayoutLease>,
    last_document_id: Option<String>,
    passed: bool,
    snapshot: Value,
}

#[derive(Clone)]
pub(in crate::renderer_desktop_smoke) struct Harness(Arc<Mutex<Inner>>);

impl Default for Harness {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Inner {
            token: uuid::Uuid::new_v4().simple().to_string(),
            pending_main: None,
            pending_child: None,
            layout_lease: None,
            last_document_id: None,
            passed: false,
            snapshot: json!({
                "schemaVersion": 1,
                "enabled": true,
                "passed": false,
                "identity": {
                    "mainWindowLabel": "main",
                    "parentLabel": null,
                    "parentWebviews": [],
                    "mainWindowLookup": "unobserved",
                    "getWebviewWindowMain": "unobserved",
                    "mainWebviewRole": "unobserved",
                    "mainWebviewParent": null,
                    "childWebviewRole": "unobserved",
                    "parentIsWebviewWindow": {"value": false, "basis": "unobserved"}
                },
                "main": {
                    "ipc": {
                        "getGeneralSettings": "unobserved",
                        "windowIsVisible": "unobserved",
                        "resourceExists": "unobserved"
                    },
                    "windowJourney": {
                        "attachViewport": {
                            "beforeInnerHeightPhysical": 0,
                            "issued": false,
                            "verified": false,
                            "afterInnerHeightPhysical": 0,
                            "scaleFactor": null
                        },
                        "expand": {"issued": false, "verified": false, "childBoundsVerified": false, "innerHeightPhysical": 0},
                        "reset": {"issued": false, "verified": false, "childBoundsVerified": false, "innerHeightPhysical": 0},
                        "hide": {"issued": false, "verified": false, "visible": true},
                        "restore": {"visible": false, "focused": false},
                        "domAlive": false
                    }
                },
                "child": {
                    "label": "renderer-settings-probe",
                    "created": false,
                    "parentLabel": null,
                    "incognitoPersistent": null,
                    "boundsPhysical": {"x": 0, "y": 0, "width": 0, "height": 0},
                    "boundsAfterExpandPhysical": null,
                    "boundsAfterResetPhysical": null,
                    "focusJourney": {
                        "childWebviewFocused": false,
                        "mainWebviewFocused": false,
                        "windowVisible": false,
                        "windowFocused": false,
                        "diagnostics": {
                            "childFocusApiIssued": null,
                            "childWindowBeforeFocus": null,
                            "childWindowAfterFocus": null,
                            "childDocument": null,
                            "mainFocusApiIssued": null,
                            "mainWindowBeforeFocus": null,
                            "mainWindowAfterFocus": null,
                            "mainDocument": null,
                            "focusEvents": "not-observed"
                        }
                    },
                    "ipc": {
                        "getGeneralSettings": {"outcome": "unobserved", "code": "UNOBSERVED"},
                        "windowIsVisible": {"outcome": "unobserved", "code": "UNOBSERVED"},
                        "resourceExists": {"outcome": "unobserved", "code": "UNOBSERVED"}
                    }
                },
                "cleanup": {
                    "initialCloseObservedAbsent": false,
                    "reopenCreated": false,
                    "reopenedChildClosed": false,
                    "finalChildAbsent": false,
                    "liveChildren": 1,
                    "liveLayoutRegistrations": null,
                    "layoutLeaseCleared": null,
                    "reopenViewport": null,
                    "documentIdentityFreshOnReopen": false,
                    "reopenBoundsPhysical": null,
                    "reopenIpc": null
                },
                "errors": []
            }),
        })))
    }
}

impl Harness {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(super) fn token(&self) -> String {
        self.lock().token.clone()
    }

    pub(super) fn snapshot(&self) -> Value {
        let inner = self.lock();
        let mut snapshot = inner.snapshot.clone();
        let errors_empty = snapshot
            .get("errors")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty);
        snapshot["passed"] = Value::Bool(inner.passed && errors_empty);
        snapshot
    }

    pub(super) fn record(&self, path: &[&str], value: Value) {
        let mut inner = self.lock();
        let mut cursor = &mut inner.snapshot;
        for key in path.iter().take(path.len().saturating_sub(1)) {
            cursor = &mut cursor[*key];
        }
        if let Some(key) = path.last() {
            cursor[*key] = value;
        }
    }

    pub(super) fn record_error(&self, error: &'static str) {
        let mut inner = self.lock();
        inner.passed = false;
        if let Some(errors) = inner.snapshot["errors"].as_array_mut() {
            if !errors.iter().any(|item| item.as_str() == Some(error)) {
                errors.push(Value::String(error.into()));
            }
        }
    }

    pub(super) fn set_passed(&self, passed: bool) {
        self.lock().passed = passed;
    }

    pub(super) fn install_layout_lease(
        &self,
        lease: crate::window::MainChildLayoutLease,
    ) -> Result<(), crate::window::MainChildLayoutLease> {
        let mut inner = self.lock();
        if inner.layout_lease.is_some() {
            return Err(lease);
        }
        inner.layout_lease = Some(lease);
        Ok(())
    }

    pub(super) fn take_layout_lease(&self) -> Option<crate::window::MainChildLayoutLease> {
        self.lock().layout_lease.take()
    }

    pub(super) fn has_layout_lease(&self) -> bool {
        self.lock().layout_lease.is_some()
    }

    pub(super) fn begin_main(
        &self,
        operation: &str,
    ) -> Result<oneshot::Receiver<Value>, &'static str> {
        let mut inner = self.lock();
        if inner.pending_main.is_some() || inner.pending_child.is_some() {
            return Err("multiwebview-probe-already-pending");
        }
        let (sender, receiver) = oneshot::channel();
        inner.pending_main = Some(PendingMain {
            operation: operation.to_string(),
            sender,
        });
        Ok(receiver)
    }

    pub(super) fn cancel_main(&self, operation: &str) {
        let mut inner = self.lock();
        if inner
            .pending_main
            .as_ref()
            .is_some_and(|pending| pending.operation == operation)
        {
            inner.pending_main = None;
        }
    }

    pub(super) fn accept_main(
        &self,
        token: &str,
        operation: &str,
        evidence: Value,
    ) -> Result<(), &'static str> {
        if token.len() > 64
            || operation.len() > 32
            || evidence.to_string().len() > MAX_REPORT_BYTES
            || !evidence.is_object()
        {
            return Err("multiwebview-main-evidence-invalid");
        }
        let mut inner = self.lock();
        if token != inner.token {
            return Err("multiwebview-main-token-rejected");
        }
        let pending = inner
            .pending_main
            .take()
            .ok_or("multiwebview-main-report-unsolicited")?;
        if pending.operation != operation {
            inner.pending_main = Some(pending);
            return Err("multiwebview-main-operation-mismatch");
        }
        pending
            .sender
            .send(evidence)
            .map_err(|_| "multiwebview-main-report-waiter-gone")
    }

    pub(super) fn begin_child(
        &self,
        nonce: String,
        generation: u8,
        kind: &'static str,
    ) -> Result<oneshot::Receiver<Value>, &'static str> {
        let mut inner = self.lock();
        if inner.pending_main.is_some() || inner.pending_child.is_some() {
            return Err("multiwebview-probe-already-pending");
        }
        let (sender, receiver) = oneshot::channel();
        inner.pending_child = Some(PendingChild {
            nonce,
            generation,
            kind,
            sender,
        });
        Ok(receiver)
    }

    pub(super) fn cancel_child(&self, generation: u8) {
        let mut inner = self.lock();
        if inner
            .pending_child
            .as_ref()
            .is_some_and(|pending| pending.generation == generation)
        {
            inner.pending_child = None;
        }
    }

    pub(super) fn accept_child_navigation(&self, url: &Url) {
        if url.as_str().len() > MAX_REPORT_BYTES
            || url.scheme() != "atools-multiwebview-probe"
            || url.host_str() != Some("report")
            || url.path() != "/"
            || url.fragment().is_some()
            || url.username() != ""
            || url.password().is_some()
            || url.port().is_some()
        {
            return;
        }
        let mut nonce = None;
        let mut payload = None;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "nonce" if nonce.is_none() => nonce = Some(value.into_owned()),
                "payload" if payload.is_none() => payload = Some(value.into_owned()),
                _ => return,
            }
        }
        let (Some(nonce), Some(payload)) = (nonce, payload) else {
            return;
        };
        if payload.len() > MAX_REPORT_BYTES {
            return;
        }
        let Ok(report) = serde_json::from_str::<Value>(&payload) else {
            return;
        };
        if !report.is_object() {
            return;
        }

        let mut inner = self.lock();
        let Some(pending) = inner.pending_child.take() else {
            return;
        };
        let document_id = report.get("documentId").and_then(Value::as_str);
        if nonce != pending.nonce
            || report.get("nonce").and_then(Value::as_str) != Some(pending.nonce.as_str())
            || report.get("version").and_then(Value::as_u64) != Some(1)
            || report.get("generation").and_then(Value::as_u64)
                != Some(u64::from(pending.generation))
            || report.get("kind").and_then(Value::as_str) != Some(pending.kind)
            || document_id.map_or(true, |id| id.is_empty() || id.len() > 128)
        {
            inner.pending_child = Some(pending);
            return;
        }

        if pending.kind == "focus" {
            let same_document = inner.last_document_id.as_deref() == document_id;
            let Some(observation) = FocusObservation::from_renderer_report(&report) else {
                inner.pending_child = Some(pending);
                return;
            };
            if !same_document {
                inner.pending_child = Some(pending);
                return;
            }
            let focused = observation.has_focus;
            let document = json!({
                "hasFocus": observation.has_focus,
                "visibilityState": observation.visibility_state,
                "eventsObserved": observation.events_observed,
                "focusEvents": observation.focus_events,
                "blurEvents": observation.blur_events
            });
            inner.snapshot["child"]["focusJourney"]["childWebviewFocused"] = Value::Bool(focused);
            inner.snapshot["child"]["focusJourney"]["diagnostics"]["childDocument"] =
                document.clone();
            let _ = pending.sender.send(json!({
                "generation": pending.generation,
                "kind": "focus",
                "focused": focused,
                "document": document
            }));
            return;
        }

        let fresh_document = inner
            .last_document_id
            .as_deref()
            .map_or(true, |previous| Some(previous) != document_id);
        inner.last_document_id = document_id.map(str::to_string);
        let ipc = json!({
            "getGeneralSettings": child_status(report.get("getGeneralSettings"), true),
            "windowIsVisible": child_status(report.get("windowIsVisible"), false),
            "resourceExists": child_status(report.get("resourceExists"), false)
        });
        if pending.generation == 1 {
            inner.snapshot["child"]["ipc"] = ipc.clone();
        } else {
            inner.snapshot["cleanup"]["reopenIpc"] = ipc.clone();
            inner.snapshot["cleanup"]["documentIdentityFreshOnReopen"] =
                Value::Bool(fresh_document);
        }
        let normalized = json!({
            "generation": pending.generation,
            "freshDocument": fresh_document,
            "ipc": ipc
        });
        let _ = pending.sender.send(normalized);
    }
}

fn child_status(value: Option<&Value>, app_command: bool) -> Value {
    let Some(value) = value else {
        return json!({"outcome":"unknown", "code":"MISSING_RESULT", "permissionDenied":false});
    };
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        return json!({"outcome":"allowed", "code":"", "permissionDenied":false});
    }
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .filter(|code| !code.is_empty() && code.len() <= 64)
        .unwrap_or("NO_ERROR_CODE");
    let permission_denied = value.get("permissionDenied").and_then(Value::as_bool) == Some(true);
    let code = if app_command {
        if code == "CHILD_WEBVIEW_APP_COMMAND_DENIED" && permission_denied {
            code
        } else if code == "UNKNOWN_COMMAND" {
            code
        } else {
            "UNEXPECTED_ERROR"
        }
    } else if code == "UNKNOWN_COMMAND" {
        code
    } else if code == "REJECTED" && permission_denied {
        code
    } else {
        "UNEXPECTED_ERROR"
    };
    json!({"outcome":"denied", "code":code, "permissionDenied":permission_denied})
}
