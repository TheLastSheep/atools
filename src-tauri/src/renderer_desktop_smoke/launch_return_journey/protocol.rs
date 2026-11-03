use super::{
    native::Witness,
    report::{JourneyReport, STAGES},
    snapshot::valid_dom,
};
use crate::renderer_desktop_smoke::profile::Profile;
use atools_core::Database;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tauri::{ipc::Invoke, AppHandle, Manager, State, Webview, Wry};
use tokio::sync::{oneshot, watch};

pub(super) const RECEIPT_COMMAND: &str = "renderer_launch_return_receipt";
pub(super) const PROBE_READY_COMMAND: &str = "renderer_launch_return_probe_ready";
const MAX_RECEIPT_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProbeReadyState {
    Pending,
    Injected,
    Ready,
    Failed(&'static str),
}

impl ProbeReadyState {
    fn after_eval_enqueued(self) -> Self {
        match self {
            Self::Pending => Self::Injected,
            state => state,
        }
    }

    fn after_ready_receipt(self) -> Result<Self, &'static str> {
        match self {
            Self::Pending | Self::Injected => Ok(Self::Ready),
            Self::Ready => Err("launch-return-probe-ready-duplicate"),
            Self::Failed(error) => Err(error),
        }
    }

    fn after_failure(self, error: &'static str) -> Self {
        match self {
            Self::Ready => Self::Ready,
            _ => Self::Failed(error),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ProbeReadyOutcome {
    Ready,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ProbeReadyReason {
    None,
    ZtoolsApiTimeout,
    OnAppLaunchedUnavailable,
    ListenerRegistrationFailed,
    ListenerReadyTimeout,
}

impl ProbeReadyReason {
    fn error_code(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::ZtoolsApiTimeout => Some("launch-return-ztools-api-readiness-timeout"),
            Self::OnAppLaunchedUnavailable => Some("launch-return-on-app-launched-api-unavailable"),
            Self::ListenerRegistrationFailed => {
                Some("launch-return-app-launched-listener-registration-failed")
            }
            Self::ListenerReadyTimeout => {
                Some("launch-return-app-launched-listener-readiness-timeout")
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProbeReadyReceipt {
    token: String,
    outcome: ProbeReadyOutcome,
    reason: ProbeReadyReason,
}

enum ProbeReadyDisposition {
    Ready,
    Failed(&'static str),
}

impl ProbeReadyReceipt {
    fn disposition(&self) -> Result<ProbeReadyDisposition, &'static str> {
        match (self.outcome, self.reason.error_code()) {
            (ProbeReadyOutcome::Ready, None) => Ok(ProbeReadyDisposition::Ready),
            (ProbeReadyOutcome::Failed, Some(error)) => Ok(ProbeReadyDisposition::Failed(error)),
            _ => Err("launch-return-probe-ready-receipt-rejected"),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    schema_version: u8,
    token: String,
    stage: String,
    nonce: String,
    caller: String,
    dom: Value,
}

struct Pending {
    stage: &'static str,
    nonce: String,
    sender: oneshot::Sender<Result<Value, &'static str>>,
}

struct Inner {
    next_stage: usize,
    pending: Option<Pending>,
    report: JourneyReport,
}

#[derive(Clone)]
pub(in crate::renderer_desktop_smoke) struct Harness {
    profile: Arc<Profile>,
    db: Arc<Database>,
    first_path: String,
    second_path: String,
    fixture_valid: bool,
    token: String,
    probe_ready: watch::Sender<ProbeReadyState>,
    probe_ready_receiver: watch::Receiver<ProbeReadyState>,
    pub(super) witness: Arc<Witness>,
    inner: Arc<Mutex<Inner>>,
}

impl Harness {
    pub(super) fn new(
        profile: Arc<Profile>,
        db: Arc<Database>,
        first_path: String,
        second_path: String,
        fixture_valid: bool,
        local_shortcut_items: u64,
    ) -> Self {
        let (probe_ready, probe_ready_receiver) = watch::channel(ProbeReadyState::Pending);
        Self {
            token: uuid::Uuid::new_v4().simple().to_string(),
            probe_ready,
            probe_ready_receiver,
            inner: Arc::new(Mutex::new(Inner {
                next_stage: 0,
                pending: None,
                report: JourneyReport::new(&profile, fixture_valid, local_shortcut_items),
            })),
            profile,
            db,
            first_path,
            second_path,
            fixture_valid,
            witness: Arc::new(Witness::default()),
        }
    }

    pub(super) fn profile(&self) -> &Profile {
        &self.profile
    }

    pub(super) fn database(&self) -> Arc<Database> {
        Arc::clone(&self.db)
    }

    pub(super) fn first_path(&self) -> &str {
        &self.first_path
    }

    pub(super) fn second_path(&self) -> &str {
        &self.second_path
    }

    pub(super) fn token(&self) -> &str {
        &self.token
    }

    pub(super) fn fixture_valid(&self) -> bool {
        self.fixture_valid
    }

    pub(super) fn mark_probe_eval_enqueued(&self) {
        self.probe_ready.send_if_modified(|state| {
            let next = state.after_eval_enqueued();
            let changed = next != *state;
            *state = next;
            changed
        });
    }

    pub(super) async fn wait_probe_ready(&self, timeout: Duration) -> Result<(), &'static str> {
        let mut ready = self.probe_ready_receiver.clone();
        let injection_deadline = tokio::time::Instant::now() + timeout;
        let mut status_deadline = None;
        loop {
            let state = *ready.borrow_and_update();
            match state {
                ProbeReadyState::Ready => return Ok(()),
                ProbeReadyState::Failed(error) => return Err(error),
                ProbeReadyState::Pending => {
                    if tokio::time::timeout_at(injection_deadline, ready.changed())
                        .await
                        .is_err()
                    {
                        return Err("launch-return-page-load-injection-timeout");
                    }
                }
                ProbeReadyState::Injected => {
                    let deadline = *status_deadline.get_or_insert_with(|| {
                        tokio::time::Instant::now() + Duration::from_secs(45)
                    });
                    if tokio::time::timeout_at(deadline, ready.changed())
                        .await
                        .is_err()
                    {
                        return Err("launch-return-probe-status-receipt-timeout");
                    }
                }
            }
        }
    }

    fn mark_probe_ready(&self) -> Result<(), &'static str> {
        if self.probe_ready.send_if_modified(|ready| {
            let Ok(next) = ready.after_ready_receipt() else {
                return false;
            };
            *ready = next;
            true
        }) {
            Ok(())
        } else {
            self.record_error("launch-return-probe-ready-duplicate");
            Err("launch-return-probe-ready-duplicate")
        }
    }

    pub(super) fn fail_probe_ready(&self, error: &'static str) {
        self.record_error(error);
        self.probe_ready.send_if_modified(|ready| {
            let next = ready.after_failure(error);
            let changed = next != *ready;
            *ready = next;
            changed
        });
    }

    pub(super) fn begin_stage(
        &self,
        stage: &'static str,
    ) -> Result<(String, oneshot::Receiver<Result<Value, &'static str>>), &'static str> {
        let mut inner = self.inner.lock();
        if inner.pending.is_some() || STAGES.get(inner.next_stage).copied() != Some(stage) {
            inner.report.fail("launch-return-stage-order-rejected");
            return Err("launch-return-stage-order-rejected");
        }
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let (sender, receiver) = oneshot::channel();
        inner.pending = Some(Pending {
            stage,
            nonce: nonce.clone(),
            sender,
        });
        Ok((nonce, receiver))
    }

    pub(super) fn cancel_stage(&self, stage: &str, nonce: &str) {
        let pending = {
            let mut inner = self.inner.lock();
            if inner
                .pending
                .as_ref()
                .is_some_and(|pending| pending.stage == stage && pending.nonce == nonce)
            {
                inner.pending.take()
            } else {
                None
            }
        };
        if let Some(pending) = pending {
            let _ = pending.sender.send(Err("launch-return-receipt-rejected"));
        }
    }

    pub(super) fn accept(&self, raw: Value) -> Result<(), &'static str> {
        let encoded = serde_json::to_vec(&raw).map_err(|_| self.reject_receipt())?;
        if encoded.len() > MAX_RECEIPT_BYTES {
            return Err(self.reject_receipt());
        }
        let receipt: Receipt = serde_json::from_value(raw).map_err(|_| self.reject_receipt())?;
        let stage_index = STAGES.iter().position(|stage| *stage == receipt.stage);
        if receipt.schema_version != 1
            || receipt.token != self.token
            || receipt.caller != "main"
            || !valid_nonce(&receipt.nonce)
            || stage_index.is_none()
            || !valid_dom(&receipt.dom)
        {
            return Err(self.reject_receipt());
        }
        let index = stage_index.unwrap_or_default();
        let pending = {
            let mut inner = self.inner.lock();
            let Some(pending) = inner.pending.take() else {
                inner.report.fail("launch-return-stage-order-rejected");
                return Err("launch-return-stage-order-rejected");
            };
            if pending.stage != receipt.stage
                || pending.nonce != receipt.nonce
                || index != inner.next_stage
            {
                inner.report.fail("launch-return-stage-order-rejected");
                let _ = pending
                    .sender
                    .send(Err("launch-return-stage-order-rejected"));
                return Err("launch-return-stage-order-rejected");
            }
            inner.next_stage += 1;
            pending
        };
        let _ = pending.sender.send(Ok(receipt.dom));
        Ok(())
    }

    pub(super) fn set_stage(
        &self,
        index: usize,
        dom: Value,
        native: Value,
        passed: bool,
        error: Option<&'static str>,
    ) {
        self.inner
            .lock()
            .report
            .set_stage(index, dom, native, passed, error);
    }

    pub(super) fn set_probes(&self, first: Value, second: Value) {
        self.inner.lock().report.set_probes(first, second);
    }

    pub(super) fn set_registration(&self, registration: Value) {
        self.inner.lock().report.set_registration(registration);
    }

    pub(super) fn append_registration_focus(&self, focus: Value) {
        self.inner.lock().report.append_registration_focus(focus);
    }

    pub(super) fn stage_native(&self, index: usize) -> Option<Value> {
        self.inner.lock().report.stage_native(index).cloned()
    }

    pub(super) fn record_error(&self, error: &'static str) {
        self.inner.lock().report.fail(error);
    }

    pub(super) fn finalize(&self, clipboard: (usize, usize, usize)) -> Value {
        let mut inner = self.inner.lock();
        if inner.pending.is_some() {
            inner.report.fail("launch-return-pending-receipt-at-finish");
        }
        inner
            .report
            .set_clipboard(clipboard.0, clipboard.1, clipboard.2);
        std::mem::replace(
            &mut inner.report,
            JourneyReport::new(&self.profile, false, 0),
        )
        .finish()
    }

    fn reject_receipt(&self) -> &'static str {
        let pending = {
            let mut inner = self.inner.lock();
            inner.report.fail("launch-return-receipt-rejected");
            inner.pending.take()
        };
        if let Some(pending) = pending {
            let _ = pending.sender.send(Err("launch-return-receipt-rejected"));
        }
        "launch-return-receipt-rejected"
    }
}

#[tauri::command]
pub(super) fn renderer_launch_return_probe_ready(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    harness: State<'_, Harness>,
    receipt: Value,
) -> Result<(), String> {
    if validate_source(&app, &webview).is_err() {
        harness.fail_probe_ready("launch-return-probe-ready-source-rejected");
        return Err("launch-return-probe-ready-source-rejected".to_owned());
    }
    let receipt: ProbeReadyReceipt = match serde_json::from_value(receipt) {
        Ok(receipt) => receipt,
        Err(_) => {
            harness.fail_probe_ready("launch-return-probe-ready-receipt-rejected");
            return Err("launch-return-probe-ready-receipt-rejected".to_owned());
        }
    };
    if receipt.token != harness.token() {
        harness.fail_probe_ready("launch-return-probe-ready-source-rejected");
        return Err("launch-return-probe-ready-source-rejected".to_owned());
    }
    match receipt.disposition() {
        Ok(ProbeReadyDisposition::Ready) => harness.mark_probe_ready().map_err(str::to_owned),
        Ok(ProbeReadyDisposition::Failed(error)) => {
            harness.fail_probe_ready(error);
            Ok(())
        }
        Err(error) => {
            harness.fail_probe_ready(error);
            Err(error.to_owned())
        }
    }
}

#[tauri::command]
pub(super) fn renderer_launch_return_receipt(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    harness: State<'_, Harness>,
    receipt: Value,
) -> Result<(), String> {
    if validate_source(&app, &webview).is_err() {
        harness.record_error("launch-return-receipt-source-rejected");
        return Err("launch-return-receipt-source-rejected".to_owned());
    }
    harness.accept(receipt).map_err(str::to_owned)
}

fn validate_source(app: &AppHandle<Wry>, webview: &Webview<Wry>) -> Result<(), &'static str> {
    if webview.label() != "main" || webview.window().label() != "main" {
        return Err("launch-return-receipt-source-rejected");
    }
    let url = webview
        .url()
        .map_err(|_| "launch-return-receipt-source-rejected")?;
    if !super::super::controller::is_local_root_url(&url)
        || crate::window::main_webview(app)
            .map(|primary| primary.label() != webview.label())
            .unwrap_or(true)
    {
        return Err("launch-return-receipt-source-rejected");
    }
    Ok(())
}

fn valid_nonce(nonce: &str) -> bool {
    nonce.len() == 32
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
#[path = "protocol/readiness_tests.rs"]
mod readiness_tests;
