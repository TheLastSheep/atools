//! Bounded, dependency-service-local diagnostics for cancelled PREPARE runs.
//! This supplements the existing cancellation result and never owns admission.
use atools_core::task_run::{TaskRun, TaskRunStatus};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::{
    sync::{Arc, OnceLock, Weak},
    time::Instant,
};

const MAX_ELAPSED_MS: u64 = 600_000;
const MAX_SAMPLES: u32 = 256;
const MAX_DIAGNOSTIC_BYTES: usize = 4096;
const STAGES: [Stage; 8] = [
    Stage::Derive,
    Stage::Preflight,
    Stage::Workspace,
    Stage::MaterializeWorker,
    Stage::ReceiptValidation,
    Stage::Publish,
    Stage::TerminalCleanup,
    Stage::Unknown,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Stage {
    Derive,
    Preflight,
    Workspace,
    MaterializeWorker,
    ReceiptValidation,
    Publish,
    TerminalCleanup,
    Unknown,
}
impl Stage {
    fn key(self) -> &'static str {
        match self {
            Self::Derive => "derive",
            Self::Preflight => "preflight",
            Self::Workspace => "workspace",
            Self::MaterializeWorker => "materialize_worker",
            Self::ReceiptValidation => "receipt_validation",
            Self::Publish => "publish",
            Self::TerminalCleanup => "terminal_cleanup",
            Self::Unknown => "unknown",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Cause {
    Unknown,
    UserCancel,
    OperationDeadline,
}
impl Cause {
    fn key(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::UserCancel => "user_cancel",
            Self::OperationDeadline => "operation_deadline",
        }
    }
}

struct State {
    cause: Cause,
    cause_stage: Stage,
    stage: Stage,
    stage_started: Instant,
    stage_elapsed: [Option<u64>; 8],
    stage_elapsed_capped: [bool; 8],
    operation_started: Instant,
    cleanup_started: Option<Instant>,
    cleanup_elapsed: Option<u64>,
    cleanup_elapsed_capped: bool,
    worker_reaped: Option<bool>,
    resource_seen: bool,
    resource_available: bool,
    resource_partial: bool,
    sample_count: u32,
    sample_count_capped: bool,
}

pub(super) struct Context {
    run_id: String,
    state: Mutex<State>,
}
pub(super) struct Registration {
    context: Arc<Context>,
}
static ACTIVE: OnceLock<Mutex<Option<Weak<Context>>>> = OnceLock::new();

impl Context {
    pub(super) fn new(run_id: &str) -> Self {
        let now = Instant::now();
        Self {
            run_id: run_id.to_owned(),
            state: Mutex::new(State {
                cause: Cause::Unknown,
                cause_stage: Stage::Unknown,
                stage: Stage::Derive,
                stage_started: now,
                stage_elapsed: [None; 8],
                stage_elapsed_capped: [false; 8],
                operation_started: now,
                cleanup_started: None,
                cleanup_elapsed: None,
                cleanup_elapsed_capped: false,
                worker_reaped: None,
                resource_seen: false,
                resource_available: false,
                resource_partial: false,
                sample_count: 0,
                sample_count_capped: false,
            }),
        }
    }
    pub(super) fn set_stage(&self, next: Stage) {
        let now = Instant::now();
        let mut state = self.state.lock();
        let index = state.stage as usize;
        if state.stage != next && state.stage_elapsed[index].is_none() {
            let (elapsed, capped) = elapsed_ms(state.stage_started, now);
            state.stage_elapsed[index] = Some(elapsed);
            state.stage_elapsed_capped[index] = capped;
        }
        if state.stage != next {
            state.stage = next;
            state.stage_started = now;
        }
    }
    fn mark_cause(&self, cause: Cause) {
        let mut state = self.state.lock();
        if state.cause == Cause::Unknown {
            state.cause = cause;
            state.cause_stage = state.stage;
        }
    }
    pub(super) fn deadline_observed(&self) {
        self.mark_cause(Cause::OperationDeadline);
    }
    pub(super) fn begin_cleanup(&self) {
        self.set_stage(Stage::TerminalCleanup);
        let mut state = self.state.lock();
        if state.cleanup_started.is_none() {
            state.cleanup_started = Some(Instant::now());
        }
    }
    pub(super) fn end_cleanup(&self) {
        let mut state = self.state.lock();
        if state.cleanup_elapsed.is_none() {
            if let Some(started) = state.cleanup_started {
                let (elapsed, capped) = elapsed_ms(started, Instant::now());
                state.cleanup_elapsed = Some(elapsed);
                state.cleanup_elapsed_capped = capped;
            }
        }
    }
    pub(super) fn worker_observed(
        &self,
        reaped: bool,
        elapsed: Option<u64>,
        samples: u32,
        unavailable: u32,
    ) {
        let mut state = self.state.lock();
        state.worker_reaped = Some(reaped);
        if elapsed.is_some() {
            state.resource_seen = true;
            state.sample_count_capped = samples > MAX_SAMPLES;
            state.sample_count = samples.min(MAX_SAMPLES);
            state.resource_available = samples > 0 && unavailable == 0;
            state.resource_partial = unavailable > 0;
        }
    }
    pub(super) fn diagnostic(&self) -> Value {
        let now = Instant::now();
        let state = self.state.lock();
        let mut elapsed_capped = false;
        let mut stages = Map::new();
        for stage in STAGES {
            let value = if stage == state.stage && state.stage_elapsed[stage as usize].is_none() {
                let (value, capped) = elapsed_ms(state.stage_started, now);
                elapsed_capped |= capped;
                Some(value)
            } else {
                state.stage_elapsed[stage as usize]
            };
            elapsed_capped |= state.stage_elapsed_capped[stage as usize];
            stages.insert(
                stage.key().into(),
                value.map_or(Value::Null, |value| json!(value)),
            );
        }
        let (operation_elapsed, operation_capped) = elapsed_ms(state.operation_started, now);
        elapsed_capped |= operation_capped;
        let cleanup = state.cleanup_elapsed;
        elapsed_capped |= state.cleanup_elapsed_capped;
        let availability = if !state.resource_seen {
            "absent"
        } else if state.resource_available {
            "available"
        } else if state.resource_partial {
            "partial"
        } else {
            "unknown"
        };
        let value = json!({
            "schemaVersion":1, "cause":state.cause.key(), "causeStage":state.cause_stage.key(),
            "stageElapsedMs":stages, "elapsedCapped":elapsed_capped,
            "operationElapsedMs":operation_elapsed, "cleanupElapsedMs":cleanup,
            "workerReaped":state.worker_reaped,
            "resourceObservation":{"availability":availability,"sampleCount":state.sample_count,
                "sampleCountCapped":state.sample_count_capped}
        });
        let _ = &self.run_id; // Keep exact run identity private to the context.
        value
    }
}

fn elapsed_ms(start: Instant, end: Instant) -> (u64, bool) {
    let raw = end.saturating_duration_since(start).as_millis();
    (
        raw.min(MAX_ELAPSED_MS as u128) as u64,
        raw > MAX_ELAPSED_MS as u128,
    )
}

#[cfg(test)]
pub(super) static TEST_ACTIVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(super) fn register(run_id: &str) -> (Arc<Context>, Registration) {
    let context = Arc::new(Context::new(run_id));
    *ACTIVE.get_or_init(|| Mutex::new(None)).lock() = Some(Arc::downgrade(&context));
    (Arc::clone(&context), Registration { context })
}
impl Drop for Registration {
    fn drop(&mut self) {
        let Some(slot) = ACTIVE.get() else { return };
        let mut active = slot.lock();
        if active
            .as_ref()
            .and_then(Weak::upgrade)
            .is_some_and(|current| {
                current.run_id == self.context.run_id && Arc::ptr_eq(&current, &self.context)
            })
        {
            *active = None;
        }
    }
}
pub(super) fn mark_accepted_user_cancel(run_id: &str) {
    let context = ACTIVE.get().and_then(|slot| {
        let active = slot.lock();
        active.as_ref().and_then(Weak::upgrade)
    });
    if let Some(context) = context {
        if context.run_id == run_id {
            context.mark_cause(Cause::UserCancel);
        }
    }
}

pub(super) fn attach_to_run(run: &mut TaskRun, context: &Context) {
    if run.id != context.run_id {
        return;
    }
    let diagnostic = context.diagnostic();
    if !valid_diagnostic(&diagnostic) {
        return;
    }
    match &mut run.metrics {
        Value::Null => {
            let mut metrics = Map::new();
            metrics.insert("operationDiagnostic".into(), diagnostic);
            run.metrics = Value::Object(metrics);
        }
        Value::Object(metrics) => {
            metrics.insert("operationDiagnostic".into(), diagnostic);
        }
        _ => {}
    }
}
pub(super) fn project_metrics(metrics: &Value) -> Option<Value> {
    let diagnostic = metrics.get("operationDiagnostic")?;
    valid_diagnostic(diagnostic).then(|| diagnostic.clone())
}
pub(super) fn project_cancelled_prepare(
    capability: &str,
    status: TaskRunStatus,
    metrics: &Value,
) -> Option<Value> {
    if capability != super::registry::PREPARE || status != TaskRunStatus::Cancelled {
        return None;
    }
    project_metrics(metrics)
}

fn valid_diagnostic(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let keys = [
        "schemaVersion",
        "cause",
        "causeStage",
        "stageElapsedMs",
        "elapsedCapped",
        "operationElapsedMs",
        "cleanupElapsedMs",
        "workerReaped",
        "resourceObservation",
    ];
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return false;
    }
    let Some(cause) = value["cause"].as_str() else {
        return false;
    };
    let Some(cause_stage) = value["causeStage"].as_str() else {
        return false;
    };
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || !["unknown", "user_cancel", "operation_deadline"].contains(&cause)
        || !STAGES.iter().any(|stage| stage.key() == cause_stage)
        || !value["elapsedCapped"].is_boolean()
    {
        return false;
    }
    if (cause == "unknown") != (cause_stage == "unknown") {
        return false;
    }
    if value["operationElapsedMs"]
        .as_u64()
        .is_none_or(|n| n > MAX_ELAPSED_MS)
        || !(value["cleanupElapsedMs"].is_null()
            || value["cleanupElapsedMs"]
                .as_u64()
                .is_some_and(|n| n <= MAX_ELAPSED_MS))
        || !(value["workerReaped"].is_null() || value["workerReaped"].is_boolean())
    {
        return false;
    }
    let Some(stages) = value["stageElapsedMs"].as_object() else {
        return false;
    };
    if stages.len() != STAGES.len()
        || STAGES.iter().any(|stage| {
            let Some(elapsed) = stages.get(stage.key()) else {
                return true;
            };
            !(elapsed.is_null() || elapsed.as_u64().is_some_and(|n| n <= MAX_ELAPSED_MS))
        })
    {
        return false;
    }
    let Some(resource) = value["resourceObservation"].as_object() else {
        return false;
    };
    let Some(availability) = resource.get("availability").and_then(Value::as_str) else {
        return false;
    };
    let Some(sample_count) = resource.get("sampleCount").and_then(Value::as_u64) else {
        return false;
    };
    let Some(sample_count_capped) = resource.get("sampleCountCapped").and_then(Value::as_bool)
    else {
        return false;
    };
    if resource.len() != 3
        || !["availability", "sampleCount", "sampleCountCapped"]
            .iter()
            .all(|key| resource.contains_key(*key))
        || !["absent", "partial", "available", "unknown"].contains(&availability)
        || sample_count > MAX_SAMPLES as u64
        || (sample_count_capped && sample_count != MAX_SAMPLES as u64)
        || (availability == "absent" && sample_count != 0)
        || (availability == "available" && sample_count == 0)
        || (availability != "absent" && value["workerReaped"].is_null())
    {
        return false;
    }
    serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= MAX_DIAGNOSTIC_BYTES)
}

#[cfg(test)]
#[path = "diagnostics_tests.rs"]
mod tests;
