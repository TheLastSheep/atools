use super::report::{CatalogReport, DomObservation, NativeObservation, Stage, StageObservation};
use super::schema;
use crate::renderer_desktop_smoke::profile::Profile;
use atools_core::Database;
use parking_lot::Mutex;
use serde_json::Value;
use std::{path::PathBuf, sync::Arc, time::Instant};
use tokio::sync::{oneshot, Notify};

const TOKEN_BYTES: usize = 32;

struct PendingObservation {
    stage: Stage,
    sender: oneshot::Sender<Result<(), &'static str>>,
}

struct Inner {
    report: CatalogReport,
    probe_injected: bool,
    ready_started: bool,
    ready_result: Option<Result<(), &'static str>>,
    stale_started: bool,
    stale_completed: bool,
    stale_sender: Option<oneshot::Sender<Result<(), &'static str>>>,
    next_stage: usize,
    pending: Option<PendingObservation>,
    focus_gained_events: u64,
}

#[derive(Clone)]
pub(in crate::renderer_desktop_smoke) struct Harness {
    profile: Arc<Profile>,
    db: Arc<Database>,
    token: String,
    started: Instant,
    added_path: PathBuf,
    after_dispose_path: PathBuf,
    inner: Arc<Mutex<Inner>>,
    ready_changed: Arc<Notify>,
}

impl Harness {
    pub(super) fn new(
        profile: Arc<Profile>,
        db: Arc<Database>,
        added_path: PathBuf,
        after_dispose_path: PathBuf,
        task_runs_before: u64,
        history_before: u64,
    ) -> Self {
        let report = CatalogReport::new(&profile, task_runs_before, history_before);
        Self {
            profile,
            db,
            token: uuid::Uuid::new_v4().simple().to_string(),
            started: Instant::now(),
            added_path,
            after_dispose_path,
            inner: Arc::new(Mutex::new(Inner {
                report,
                probe_injected: false,
                ready_started: false,
                ready_result: None,
                stale_started: false,
                stale_completed: false,
                stale_sender: None,
                next_stage: 0,
                pending: None,
                focus_gained_events: 0,
            })),
            ready_changed: Arc::new(Notify::new()),
        }
    }

    pub(super) fn token(&self) -> &str {
        &self.token
    }

    pub(in crate::renderer_desktop_smoke) fn profile(&self) -> &Profile {
        &self.profile
    }

    pub(super) fn database(&self) -> Arc<Database> {
        Arc::clone(&self.db)
    }

    pub(super) fn added_path(&self) -> &std::path::Path {
        &self.added_path
    }

    pub(super) fn after_dispose_path(&self) -> &std::path::Path {
        &self.after_dispose_path
    }

    pub(super) fn token_matches(&self, token: &str) -> bool {
        token.len() == TOKEN_BYTES
            && token == self.token
            && token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    pub(super) fn mark_probe_injected(&self) -> bool {
        let mut inner = self.inner.lock();
        if inner.probe_injected {
            return false;
        }
        inner.probe_injected = true;
        true
    }

    pub(super) fn begin_ready(&self, token: &str) -> Result<(), &'static str> {
        if !self.token_matches(token) {
            return Err("catalog-probe-token-rejected");
        }
        let mut inner = self.inner.lock();
        if inner.ready_started || inner.ready_result.is_some() {
            return Err("catalog-probe-protocol-rejected");
        }
        inner.ready_started = true;
        Ok(())
    }

    pub(super) fn complete_ready(
        &self,
        dom: DomObservation,
        native: NativeObservation,
    ) -> Result<(), &'static str> {
        let mut inner = self.inner.lock();
        if !inner.ready_started || inner.ready_result.is_some() {
            return Err("catalog-probe-protocol-rejected");
        }
        let result = schema::validate_stage(Stage::Initial, 0, &[], &dom, &native);
        inner
            .report
            .set_data_store_persistent(native.data_store_persistent);
        match result {
            Ok(()) => {
                inner.report.push_stage(StageObservation {
                    stage: Stage::Initial.as_str(),
                    elapsed_ms: elapsed_ms(self.started),
                    dom,
                    native,
                    errors: Vec::new(),
                });
                inner.next_stage = 1;
                inner.ready_result = Some(Ok(()));
            }
            Err(error) => {
                inner.report.add_error(error);
                inner.report.push_stage(StageObservation {
                    stage: Stage::Initial.as_str(),
                    elapsed_ms: elapsed_ms(self.started),
                    dom,
                    native,
                    errors: vec![error],
                });
                inner.ready_result = Some(Err(error));
            }
        }
        let outcome = inner
            .ready_result
            .clone()
            .unwrap_or(Err("catalog-probe-protocol-rejected"));
        drop(inner);
        self.ready_changed.notify_one();
        outcome
    }

    pub(super) fn fail_ready(&self, error: &'static str) {
        let mut inner = self.inner.lock();
        if inner.ready_result.is_none() {
            inner.report.add_error(error);
            inner.ready_result = Some(Err(error));
        }
        drop(inner);
        self.ready_changed.notify_one();
    }

    pub(super) async fn wait_ready(
        &self,
        timeout: std::time::Duration,
    ) -> Result<(), &'static str> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(result) = self.inner.lock().ready_result {
                return result;
            }
            let changed = self.ready_changed.notified();
            if let Some(result) = self.inner.lock().ready_result {
                return result;
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                self.record_error("catalog-probe-readiness-timeout");
                return Err("catalog-probe-readiness-timeout");
            }
        }
    }

    pub(super) fn begin_stage(
        &self,
        stage: Stage,
    ) -> Result<oneshot::Receiver<Result<(), &'static str>>, &'static str> {
        let mut inner = self.inner.lock();
        if inner.pending.is_some() || Stage::ALL.get(inner.next_stage) != Some(&stage) {
            inner.report.add_error("catalog-probe-protocol-rejected");
            return Err("catalog-probe-protocol-rejected");
        }
        let (sender, receiver) = oneshot::channel();
        inner.pending = Some(PendingObservation { stage, sender });
        Ok(receiver)
    }

    pub(super) fn cancel_stage(&self, stage: Stage, error: &'static str) {
        let pending = {
            let mut inner = self.inner.lock();
            inner.report.add_error(error);
            match inner.pending.take() {
                Some(pending) if pending.stage == stage => Some(pending),
                Some(pending) => {
                    inner.pending = Some(pending);
                    None
                }
                None => None,
            }
        };
        if let Some(pending) = pending {
            let _ = pending.sender.send(Err(error));
        }
    }

    pub(super) fn accept_stage(
        &self,
        stage: Stage,
        dom: DomObservation,
        native: NativeObservation,
    ) -> Result<(), &'static str> {
        let (pending, result) = {
            let mut inner = self.inner.lock();
            let Some(pending) = inner.pending.take() else {
                inner.report.add_error("catalog-probe-protocol-rejected");
                return Err("catalog-probe-protocol-rejected");
            };
            if pending.stage != stage || Stage::ALL.get(inner.next_stage) != Some(&stage) {
                inner.pending = Some(pending);
                inner.report.add_error("catalog-probe-protocol-rejected");
                return Err("catalog-probe-protocol-rejected");
            }
            let index = inner.next_stage;
            let result = schema::validate_stage(stage, index, inner.report.stages(), &dom, &native);
            match result {
                Ok(()) => {
                    inner.report.push_stage(StageObservation {
                        stage: stage.as_str(),
                        elapsed_ms: elapsed_ms(self.started),
                        dom,
                        native,
                        errors: Vec::new(),
                    });
                    inner.next_stage += 1;
                }
                Err(error) => {
                    inner.report.add_error(error);
                    inner.report.push_stage(StageObservation {
                        stage: stage.as_str(),
                        elapsed_ms: elapsed_ms(self.started),
                        dom,
                        native,
                        errors: vec![error],
                    });
                }
            }
            (pending, result)
        };
        let _ = pending.sender.send(result);
        result
    }

    pub(super) fn begin_stale_launch(
        &self,
    ) -> Result<oneshot::Receiver<Result<(), &'static str>>, &'static str> {
        let mut inner = self.inner.lock();
        if inner.next_stage != 3 || inner.pending.is_some() || inner.stale_started {
            inner
                .report
                .add_error("catalog-stale-launch-protocol-rejected");
            return Err("catalog-stale-launch-protocol-rejected");
        }
        inner.stale_started = true;
        let (sender, receiver) = oneshot::channel();
        inner.stale_sender = Some(sender);
        Ok(receiver)
    }

    pub(super) fn complete_stale_launch(
        &self,
        token: &str,
        rejected: bool,
        task_runs_after: u64,
        history_after: u64,
    ) -> Result<(), &'static str> {
        if !self.token_matches(token) {
            return Err("catalog-probe-token-rejected");
        }
        let (sender, result) = {
            let mut inner = self.inner.lock();
            if !inner.stale_started || inner.stale_completed || inner.next_stage != 3 {
                return Err("catalog-stale-launch-protocol-rejected");
            }
            inner
                .report
                .set_stale_launch(rejected, task_runs_after, history_after);
            inner.stale_completed = true;
            let result = if !rejected || task_runs_after != 0 || history_after != 0 {
                inner
                    .report
                    .add_error("catalog-stale-launch-not-rejected-cleanly");
                Err("catalog-stale-launch-not-rejected-cleanly")
            } else {
                Ok(())
            };
            (inner.stale_sender.take(), result)
        };
        if let Some(sender) = sender {
            let _ = sender.send(result);
        }
        result
    }

    pub(super) fn fail_stale_launch(&self, error: &'static str) {
        let sender = {
            let mut inner = self.inner.lock();
            inner.report.add_error(error);
            inner.stale_completed = true;
            inner.stale_sender.take()
        };
        if let Some(sender) = sender {
            let _ = sender.send(Err(error));
        }
    }

    pub(super) fn record_focus_gained(&self) {
        let mut inner = self.inner.lock();
        inner.focus_gained_events = inner.focus_gained_events.saturating_add(1);
    }

    pub(super) fn focus_gained_events(&self) -> u64 {
        self.inner.lock().focus_gained_events
    }

    pub(super) fn record_error(&self, error: &'static str) {
        self.inner.lock().report.add_error(error);
    }

    pub(super) fn set_clipboard_counts(&self, counts: Option<(u64, u64, u64)>) {
        let mut inner = self.inner.lock();
        inner.report.set_clipboard_counts(counts);
        match counts {
            None => inner
                .report
                .add_error("catalog-clipboard-observation-unavailable"),
            Some((reads, writes, pastes)) if reads != 0 || writes != 0 || pastes != 0 => {
                inner.report.add_error("catalog-clipboard-was-used");
            }
            Some(_) => {}
        }
    }

    pub(super) fn snapshot(&self) -> Value {
        self.inner.lock().report.to_value()
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(120_000) as u64
}
