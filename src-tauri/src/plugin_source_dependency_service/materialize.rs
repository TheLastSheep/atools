use super::{
    archive_store::{ArchiveStore, PLAN_ARCHIVE_LIMIT},
    diagnostics::{Context as PrepareDiagnostic, Stage as DiagnosticStage},
    registry_store::{self, VerifiedSet},
    toolchain_fingerprint::NodePin,
};
use atools_plugin::source_build::{
    dependency_set_id_sha256, verify_archive_integrity, LockedDependencyPlanV1,
};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

#[path = "worker_failure.rs"]
mod worker_failure;

const DEPENDENCY_STAGE_CLEANUP_ENTRIES: usize = 210_000;

pub(super) struct PrepareResult {
    pub set: VerifiedSet,
    pub elapsed_ms: u64,
    pub node_pin: NodePin,
}

struct Preflight {
    store: ArchiveStore,
    plan: LockedDependencyPlanV1,
    cached_set: Option<VerifiedSet>,
    plan_bytes: Vec<u8>,
    worker_executable: PathBuf,
    node_pin: NodePin,
}

pub(super) fn require_archives(
    store: &ArchiveStore,
    plan: &LockedDependencyPlanV1,
) -> Result<u64, String> {
    let mut total = 0u64;
    for package in &plan.packages {
        let bytes = store
            .read_archive(package)
            .map_err(|_| "SOURCE_DEPENDENCY_ARCHIVE_MISSING")?;
        if !verify_archive_integrity(package, &bytes) {
            return Err("SOURCE_DEPENDENCY_CACHE_CORRUPT".into());
        }
        total = total
            .checked_add(bytes.len() as u64)
            .ok_or("SOURCE_DEPENDENCY_ARCHIVE_LIMIT")?;
        if total > PLAN_ARCHIVE_LIMIT {
            return Err("SOURCE_DEPENDENCY_ARCHIVE_LIMIT".into());
        }
    }
    Ok(total)
}

#[cfg(target_os = "macos")]
pub(super) async fn prepare(
    cache_root: &Path,
    plan: LockedDependencyPlanV1,
    node_path: PathBuf,
    node_pin: NodePin,
    lease: &super::super::manager::Lease,
    cancelled: Arc<AtomicBool>,
    worker_finished: Arc<AtomicBool>,
    cleanup_unconfirmed: Arc<AtomicBool>,
    deadline: Instant,
    diagnostic: Arc<PrepareDiagnostic>,
) -> Result<PrepareResult, String> {
    use super::super::staging::Workspace;
    let cache_root = cache_root.to_path_buf();
    let preflight_cancel = cancelled.clone();
    let expected_pin = node_pin.clone();
    let diagnostic_for_preflight = Arc::clone(&diagnostic);
    diagnostic.set_stage(DiagnosticStage::Preflight);
    let preflight = run_blocking_bounded(
        cancelled.clone(),
        deadline,
        move || {
            prepare_preflight(
                cache_root,
                plan,
                node_path,
                expected_pin,
                &preflight_cancel,
                deadline,
                &diagnostic_for_preflight,
            )
        },
        "SOURCE_DEPENDENCY_PREPARE_JOIN",
        &diagnostic,
    )
    .await?;
    if cancelled.load(Ordering::Acquire) {
        return Err("SOURCE_DEPENDENCY_CANCELLED".into());
    }
    if Instant::now() >= deadline {
        diagnostic.deadline_observed();
        return Err("SOURCE_DEPENDENCY_OPERATION_TIMEOUT".into());
    }
    if let Some(set) = preflight.cached_set {
        return Ok(PrepareResult {
            set,
            elapsed_ms: 0,
            node_pin: preflight.node_pin,
        });
    }

    let workspace_cancel = cancelled.clone();
    let cleanup_for_workspace = cleanup_unconfirmed.clone();
    diagnostic.set_stage(DiagnosticStage::Workspace);
    let mut workspace = run_blocking_bounded(
        cancelled.clone(),
        deadline,
        move || {
            if workspace_cancel.load(Ordering::Acquire) {
                return Err("SOURCE_DEPENDENCY_CANCELLED".into());
            }
            Workspace::with_signal_and_entry_limit(
                cleanup_for_workspace,
                DEPENDENCY_STAGE_CLEANUP_ENTRIES,
            )
        },
        "SOURCE_DEPENDENCY_STAGE_CREATE",
        &diagnostic,
    )
    .await?;
    let stage_started = Instant::now();
    workspace.mark_running();
    worker_finished.store(false, Ordering::Release);
    let executable = preflight.worker_executable;
    let archive_root = preflight.store.archive_root().to_path_buf();
    let stage_root = workspace.root.clone();
    let plan_bytes = preflight.plan_bytes;
    let worker_cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel_for_child = Arc::clone(&worker_cancel);
    diagnostic.set_stage(DiagnosticStage::MaterializeWorker);
    let mut worker = tokio::task::spawn_blocking(move || {
        crate::plugin_source_dependencies::supervisor::run_materializer(
            &executable,
            &archive_root,
            &stage_root,
            &plan_bytes,
            &worker_cancel_for_child,
        )
    });
    let mut operation_timed_out = false;
    let joined = loop {
        if cancelled.load(Ordering::Acquire) {
            worker_cancel.store(true, Ordering::Release);
            diagnostic.begin_cleanup();
            let joined = worker.await;
            diagnostic.end_cleanup();
            break joined;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            operation_timed_out = true;
            diagnostic.deadline_observed();
            worker_cancel.store(true, Ordering::Release);
            diagnostic.begin_cleanup();
            let joined = worker.await;
            diagnostic.end_cleanup();
            break joined;
        }
        match tokio::time::timeout(remaining.min(Duration::from_millis(25)), &mut worker).await {
            Ok(joined) => break joined,
            Err(_) => continue,
        }
    };
    let outcome = joined.map_err(|_| {
        cleanup_unconfirmed.store(true, Ordering::Release);
        "SOURCE_DEPENDENCY_WORKER_JOIN"
    })?;
    diagnostic.worker_observed(
        outcome.reaped,
        outcome.resource_observation.elapsed_milliseconds,
        outcome.resource_observation.sample_count,
        outcome.resource_observation.unavailable_sample_count,
    );
    if !outcome.reaped {
        cleanup_unconfirmed.store(true, Ordering::Release);
        return Err("SOURCE_DEPENDENCY_WORKER_UNREAPED".into());
    }
    worker_finished.store(true, Ordering::Release);
    workspace.mark_quiescent();
    if cancelled.load(Ordering::Acquire) {
        return Err("SOURCE_DEPENDENCY_CANCELLED".into());
    }
    if operation_timed_out {
        return Err("SOURCE_DEPENDENCY_OPERATION_TIMEOUT".into());
    }
    diagnostic.set_stage(DiagnosticStage::ReceiptValidation);
    let exit_succeeded = outcome
        .exit_status
        .as_ref()
        .is_some_and(|status| status.success());
    let receipt = match outcome.receipt {
        Err(error) => return Err(worker_failure::diagnostic_code(error)),
        Ok(receipt) if exit_succeeded => receipt,
        Ok(_) => return Err("SOURCE_DEPENDENCY_WORKER_FAILED".into()),
    };
    let observation = outcome.resource_observation;
    if observation.sample_count == 0
        || observation.elapsed_milliseconds.is_none()
        || observation.elapsed_milliseconds.unwrap_or(u64::MAX) > 120_000
        || observation
            .peak_observed_physical_footprint_bytes
            .is_some_and(|bytes| bytes > observation.observed_footprint_limit_bytes)
    {
        return Err("SOURCE_DEPENDENCY_WORKER_OBSERVATION_INVALID".into());
    }
    let worker_elapsed_ms = observation.elapsed_milliseconds.unwrap_or(0);
    let plan = preflight.plan;
    let set_id = dependency_set_id_sha256(&plan).map_err(|_| "SOURCE_DEPENDENCY_PLAN_INVALID")?;
    let handle = atools_plugin::source_build::OwnedDependencyRootHandle {
        set_id_sha256: set_id,
        manifest_sha256: receipt.manifest_sha256.clone(),
    };
    if !atools_plugin::source_build::verify_dependency_receipt(&plan, &receipt, &handle)
        .map_err(|_| "SOURCE_DEPENDENCY_RECEIPT_INVALID")?
    {
        return Err("SOURCE_DEPENDENCY_RECEIPT_INVALID".into());
    }

    let store = preflight.store;
    let publication_gate = lease.phase_gate();
    let publish_cancel = cancelled.clone();
    diagnostic.set_stage(DiagnosticStage::Publish);
    let publish = run_blocking_bounded(
        cancelled.clone(),
        deadline,
        move || {
            registry_store::publish_verified_stage(
                &store,
                workspace,
                &plan,
                receipt,
                &publish_cancel,
                stage_started,
                move || publication_gate.enter(super::super::manager::Phase::Publishing),
            )
        },
        "SOURCE_DEPENDENCY_PUBLISH_JOIN",
        &diagnostic,
    )
    .await?;
    Ok(PrepareResult {
        set: publish,
        elapsed_ms: worker_elapsed_ms,
        node_pin: preflight.node_pin,
    })
}

#[cfg(target_os = "macos")]
fn prepare_preflight(
    cache_root: PathBuf,
    plan: LockedDependencyPlanV1,
    node_path: PathBuf,
    expected_pin: NodePin,
    cancelled: &AtomicBool,
    deadline: Instant,
    diagnostic: &PrepareDiagnostic,
) -> Result<Preflight, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("SOURCE_DEPENDENCY_CANCELLED".into());
    }
    if Instant::now() >= deadline {
        diagnostic.deadline_observed();
        return Err("SOURCE_DEPENDENCY_OPERATION_TIMEOUT".into());
    }
    let store =
        ArchiveStore::open_existing(&cache_root)?.ok_or("SOURCE_DEPENDENCY_ARCHIVE_MISSING")?;
    store.cache_totals(cancelled)?;
    let _archive_bytes = require_archives(&store, &plan)?;
    let cached_set = registry_store::verify_existing(&store, &plan, cancelled)?;
    let plan_bytes = serde_json::to_vec(&plan).map_err(|_| "SOURCE_DEPENDENCY_PLAN_INVALID")?;
    if plan_bytes.len() > atools_plugin::source_build::MAX_PLAN_JSON_BYTES {
        return Err("SOURCE_DEPENDENCY_PLAN_INVALID".into());
    }
    if cancelled.load(Ordering::Acquire) {
        return Err("SOURCE_DEPENDENCY_CANCELLED".into());
    }
    let worker_executable =
        std::env::current_exe().map_err(|_| "SOURCE_DEPENDENCY_WORKER_HOST_UNAVAILABLE")?;
    let worker_executable = super::super::staging::canonical_file(&worker_executable)
        .map_err(|_| "SOURCE_DEPENDENCY_WORKER_HOST_UNAVAILABLE")?;
    let node_pin = super::toolchain_fingerprint::pin_node(&node_path, &plan.target, cancelled)?;
    if node_pin.fingerprint_sha256 != plan.toolchain_fingerprint_sha256
        || node_pin.fingerprint_sha256 != expected_pin.fingerprint_sha256
        || node_pin.sha256 != expected_pin.sha256
    {
        return Err("SOURCE_DEPENDENCY_TOOLCHAIN_CHANGED".into());
    }
    Ok(Preflight {
        store,
        plan,
        cached_set,
        plan_bytes,
        worker_executable,
        node_pin,
    })
}

async fn run_blocking_bounded<T, F>(
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
    task: F,
    join_error: &'static str,
    diagnostic: &PrepareDiagnostic,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let mut handle = tokio::task::spawn_blocking(task);
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        diagnostic.deadline_observed();
        cancelled.store(true, Ordering::Release);
        diagnostic.begin_cleanup();
        let _ = handle.await;
        diagnostic.end_cleanup();
        return Err("SOURCE_DEPENDENCY_OPERATION_TIMEOUT".into());
    }
    match tokio::time::timeout(remaining, &mut handle).await {
        Ok(joined) => joined.map_err(|_| join_error.to_owned())?,
        Err(_) => {
            diagnostic.deadline_observed();
            cancelled.store(true, Ordering::Release);
            diagnostic.begin_cleanup();
            let _ = handle.await;
            diagnostic.end_cleanup();
            Err("SOURCE_DEPENDENCY_OPERATION_TIMEOUT".into())
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) async fn prepare(
    _cache_root: &Path,
    _plan: LockedDependencyPlanV1,
    _node_path: PathBuf,
    _node_pin: NodePin,
    _cancelled: Arc<AtomicBool>,
    _finished: Arc<AtomicBool>,
    _cleanup_unconfirmed: Arc<AtomicBool>,
    _deadline: Instant,
    _diagnostic: Arc<PrepareDiagnostic>,
) -> Result<PrepareResult, String> {
    Err("SOURCE_DEPENDENCY_PLATFORM_UNSUPPORTED".into())
}
