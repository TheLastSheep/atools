use super::{
    report::LauncherReport,
    schema::{self, Evidence, Operation, ProbeId},
};
use crate::renderer_desktop_smoke::profile::Profile;
use atools_core::Database;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::oneshot;

const MAX_RECEIPT_BYTES: usize = 4096;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Receipt {
    pub(super) schema_version: u8,
    pub(super) token: String,
    pub(super) operation: String,
    pub(super) nonce: String,
    pub(super) caller: String,
    pub(super) evidence: Value,
}

struct Pending {
    operation: Operation,
    nonce: String,
    sender: oneshot::Sender<Result<Value, &'static str>>,
}

struct Inner {
    report: LauncherReport,
    pending: Option<Pending>,
    next_operation: usize,
    restore_started: bool,
}

#[derive(Clone)]
pub(in crate::renderer_desktop_smoke) struct Harness {
    token: String,
    run_id: String,
    profile_root: PathBuf,
    first_path: String,
    second_path: String,
    fixture_valid: bool,
    enter_case: bool,
    sequence: Vec<Operation>,
    db: Arc<Database>,
    success_launch_attempted: Arc<AtomicBool>,
    inner: Arc<Mutex<Inner>>,
}

impl Harness {
    pub(in crate::renderer_desktop_smoke) fn new(
        profile: &Profile,
        db: Arc<Database>,
        first_path: String,
        second_path: String,
        fixture_valid: bool,
        errors: Vec<&'static str>,
        catalog: super::report::CatalogReport,
    ) -> Self {
        let enter_case = profile.auto_clear == "immediately";
        let mut report = LauncherReport::new(&profile.auto_clear, catalog, true);
        for error in errors {
            report.add_error(error);
        }
        Self {
            token: uuid::Uuid::new_v4().simple().to_string(),
            run_id: profile.run_id.clone(),
            profile_root: profile.root.clone(),
            first_path,
            second_path,
            fixture_valid,
            enter_case,
            sequence: Operation::sequence(enter_case),
            db,
            success_launch_attempted: Arc::new(AtomicBool::new(false)),
            inner: Arc::new(Mutex::new(Inner {
                report,
                pending: None,
                next_operation: 0,
                restore_started: false,
            })),
        }
    }

    pub(super) fn token(&self) -> &str {
        &self.token
    }

    pub(super) fn run_id(&self) -> &str {
        &self.run_id
    }

    pub(super) fn profile_root(&self) -> &std::path::Path {
        &self.profile_root
    }

    pub(super) fn database(&self) -> Arc<Database> {
        Arc::clone(&self.db)
    }

    pub(super) fn mark_success_launch_attempted(&self) {
        self.success_launch_attempted.store(true, Ordering::Release);
    }

    pub(super) fn success_launch_attempted(&self) -> bool {
        self.success_launch_attempted.load(Ordering::Acquire)
    }

    pub(super) fn fixture_valid(&self) -> bool {
        self.fixture_valid
    }

    pub(super) fn enter_case(&self) -> bool {
        self.enter_case
    }

    pub(super) fn path_for(&self, probe: ProbeId) -> &str {
        match probe {
            ProbeId::First => &self.first_path,
            ProbeId::Second => &self.second_path,
        }
    }

    pub(super) fn selected_probe(&self) -> Option<ProbeId> {
        let inner = self.inner.lock();
        match inner.report.input.selected_probe.as_str() {
            "first" => Some(ProbeId::First),
            "second" => Some(ProbeId::Second),
            _ => None,
        }
    }

    pub(super) fn begin(
        &self,
        operation: Operation,
    ) -> Result<(String, oneshot::Receiver<Result<Value, &'static str>>), &'static str> {
        let mut inner = self.inner.lock();
        let order_valid = if operation == Operation::RestoreInput {
            !inner.restore_started
        } else {
            self.sequence.get(inner.next_operation) == Some(&operation)
        };
        if inner.pending.is_some() || !order_valid {
            inner
                .report
                .add_error("launcher-operation-protocol-rejected");
            return Err("launcher-operation-protocol-rejected");
        }
        if operation == Operation::RestoreInput {
            inner.restore_started = true;
        }
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let (sender, receiver) = oneshot::channel();
        inner.pending = Some(Pending {
            operation,
            nonce: nonce.clone(),
            sender,
        });
        Ok((nonce, receiver))
    }

    pub(super) fn cancel(&self, operation: Operation, nonce: &str) {
        let mut inner = self.inner.lock();
        if inner
            .pending
            .as_ref()
            .is_some_and(|pending| pending.operation == operation && pending.nonce == nonce)
        {
            inner.pending = None;
            inner
                .report
                .add_error("launcher-operation-protocol-rejected");
        }
    }

    pub(super) fn accept(&self, receipt: Receipt) -> Result<(), &'static str> {
        let encoded = serde_json::to_vec(&receipt).map_err(|_| {
            self.record_error("launcher-operation-protocol-rejected");
            "launcher-operation-protocol-rejected"
        })?;
        if encoded.len() > MAX_RECEIPT_BYTES
            || receipt.schema_version != 1
            || receipt.token != self.token
            || receipt.caller != "main"
            || receipt.nonce.len() != 32
            || !receipt
                .nonce
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            self.record_error("launcher-operation-protocol-rejected");
            self.reject_matching(&receipt.operation, &receipt.nonce);
            return Err("launcher-operation-protocol-rejected");
        }

        let operation = if receipt.operation.as_str() == Operation::RestoreInput.as_str() {
            Some(Operation::RestoreInput)
        } else {
            self.sequence
                .iter()
                .copied()
                .find(|operation| operation.as_str() == receipt.operation.as_str())
        }
        .ok_or_else(|| {
            self.record_error("launcher-operation-protocol-rejected");
            "launcher-operation-protocol-rejected"
        })?;
        let evidence = match schema::parse(operation, &receipt.evidence, self.enter_case) {
            Ok(evidence) => evidence,
            Err(()) => {
                self.record_error("launcher-operation-protocol-rejected");
                self.reject_matching(&receipt.operation, &receipt.nonce);
                return Err("launcher-operation-protocol-rejected");
            }
        };

        let pending = {
            let mut inner = self.inner.lock();
            let Some(pending) = inner.pending.take() else {
                inner
                    .report
                    .add_error("launcher-operation-protocol-rejected");
                return Err("launcher-operation-protocol-rejected");
            };
            if pending.operation != operation
                || pending.nonce != receipt.nonce
                || (operation != Operation::RestoreInput
                    && self.sequence.get(inner.next_operation) != Some(&operation))
            {
                inner.pending = Some(pending);
                inner
                    .report
                    .add_error("launcher-operation-protocol-rejected");
                return Err("launcher-operation-protocol-rejected");
            }
            if operation != Operation::RestoreInput {
                inner.next_operation += 1;
            }
            apply_evidence(&mut inner.report, operation, evidence);
            pending
        };
        let _ = pending.sender.send(Ok(receipt.evidence));
        Ok(())
    }

    fn reject_matching(&self, operation: &str, nonce: &str) {
        let pending = {
            let mut inner = self.inner.lock();
            if inner.pending.as_ref().is_some_and(|pending| {
                pending.operation.as_str() == operation && pending.nonce == nonce
            }) {
                inner.pending.take()
            } else {
                None
            }
        };
        if let Some(pending) = pending {
            let _ = pending
                .sender
                .send(Err("launcher-operation-protocol-rejected"));
        }
    }

    pub(super) fn record_error(&self, error: &'static str) {
        self.inner.lock().report.add_error(error);
    }

    pub(super) fn update_report(&self, update: impl FnOnce(&mut LauncherReport)) {
        update(&mut self.inner.lock().report);
    }

    pub(super) fn snapshot(&self) -> Value {
        let inner = self.inner.lock();
        inner
            .report
            .clone()
            .to_value(self.enter_case, usize::from(inner.pending.is_some()))
    }

    pub(super) fn pending_count(&self) -> usize {
        usize::from(self.inner.lock().pending.is_some())
    }
}

fn apply_evidence(report: &mut LauncherReport, operation: Operation, evidence: Evidence) {
    match (operation, evidence) {
        (Operation::Search, Evidence::Search(value)) => {
            report.input.dom_input = value.dom_input;
            report.input.space_enabled = value.space_enabled;
            report.input.result_count = value.result_count;
            report.input.selection_changed = value.selection_changed;
            report.input.selected_identity_matched = value.selected_identity_matched;
            report.input.selected_probe = value.selected_after.as_str().to_owned();
        }
        (Operation::SpaceDisabled, Evidence::SpaceDisabled(value)) => {
            report.space_disabled.checked = value.sent;
        }
        (Operation::Unlisted, Evidence::Unlisted(value)) => {
            report.unlisted.rejected = value.rejected;
        }
        (Operation::LaunchDenied, Evidence::Launch(_)) => {}
        (Operation::LaunchSucceeded, Evidence::Launch(value)) => {
            report.launched.main_history_applied = value.main_history_applied;
        }
        (Operation::RestoreInput, Evidence::RestoreInput(true)) => {}
        (Operation::RestoreInput, Evidence::RestoreInput(false)) => {
            report.add_error("launcher-renderer-probe-not-ready");
        }
        _ => report.add_error("launcher-operation-protocol-rejected"),
    }
}
