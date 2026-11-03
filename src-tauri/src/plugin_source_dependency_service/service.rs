use super::{
    archive_store::{ArchiveStore, CachedArchive, PLAN_ARCHIVE_LIMIT},
    diagnostics::{self, Context as PrepareDiagnostic, Stage as DiagnosticStage},
    fetch, identity, materialize, registry, registry_store, toolchain_fingerprint,
    ConversionDependencies,
};
use atools_core::{
    db::Database,
    task_run::{TaskRun, TaskRunStatus},
};
use atools_plugin::source_build::{
    build_locked_dependency_plan, current_build_target, dependency_set_id_sha256,
    LockedDependencyPlanV1,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

const OP_DEADLINE_MS: u64 = 120_000;

/// Private, in-process override used only by the isolated native fixture. It is
/// never accepted through a command/tool argument; normal applications keep
/// using Tauri's app-owned cache directory.
pub(super) struct IsolatedCacheRoot(PathBuf);

impl IsolatedCacheRoot {
    pub(super) fn new(path: PathBuf) -> Result<Self, String> {
        let metadata =
            std::fs::symlink_metadata(&path).map_err(|_| "SOURCE_DEPENDENCY_CACHE_UNAVAILABLE")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("SOURCE_DEPENDENCY_CACHE_UNAVAILABLE".into());
        }
        let canonical =
            std::fs::canonicalize(&path).map_err(|_| "SOURCE_DEPENDENCY_CACHE_UNAVAILABLE")?;
        if canonical != path {
            return Err("SOURCE_DEPENDENCY_CACHE_UNAVAILABLE".into());
        }
        Ok(Self(canonical))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InspectArgs {
    source_path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationArgs {
    source_path: String,
    expected_revision: String,
}

struct Derived {
    source: identity::SourceIdentity,
    plan: LockedDependencyPlanV1,
    node_path: PathBuf,
    node_pin: toolchain_fingerprint::NodePin,
}

fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = app.try_state::<IsolatedCacheRoot>() {
        return Ok(root.0.clone());
    }
    app.path()
        .app_cache_dir()
        .map_err(|_| "SOURCE_DEPENDENCY_CACHE_UNAVAILABLE".into())
}

fn derive(source_path: &str, cancel: &std::sync::atomic::AtomicBool) -> Result<Derived, String> {
    super::super::api::validate_path(source_path)
        .map_err(|_| "SOURCE_DEPENDENCY_SOURCE_PATH_INVALID")?;
    let source = identity::read_source(Path::new(source_path), cancel)?;
    let target = current_build_target().map_err(|error| error.code())?;
    let node_path = atools_plugin::source_build::resolve_build_node()
        .map_err(|_| "SOURCE_DEPENDENCY_NODE_UNAVAILABLE")?;
    let node_path = super::super::staging::canonical_file(&node_path)
        .map_err(|_| "SOURCE_DEPENDENCY_NODE_UNAVAILABLE")?;
    let node_pin = toolchain_fingerprint::pin_node(&node_path, &target, cancel)?;
    let plan = build_locked_dependency_plan(
        &source.package_json,
        &source.package_lock,
        &source.revision,
        target,
        &node_pin.fingerprint_sha256,
    )
    .map_err(|error| error.code().to_owned())?;
    Ok(Derived {
        source,
        plan,
        node_path,
        node_pin,
    })
}

/// Resolve only an already-prepared set for the source-build fallback. This
/// never fetches or materializes, and it binds the set to the current source
/// and exact Node fingerprint before exposing its app-owned dependency home.
pub(in crate::plugin_source_build) async fn prepared_for_conversion(
    app: &AppHandle,
    source_path: &Path,
    expected_revision: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<Option<ConversionDependencies>, String> {
    if !cfg!(target_os = "macos") {
        return Err("SOURCE_DEPENDENCY_PLATFORM_UNSUPPORTED".into());
    }
    let cache = cache_root(app)?;
    let source = source_path.to_path_buf();
    let expected = expected_revision.to_owned();
    let cancelled_for_work = cancelled.clone();
    let started = Instant::now();
    run_blocking_until(
        cancelled,
        started + Duration::from_millis(OP_DEADLINE_MS),
        move || {
            let derived = derive(
                source
                    .to_str()
                    .ok_or("SOURCE_DEPENDENCY_SOURCE_PATH_INVALID")?,
                &cancelled_for_work,
            )?;
            if derived.source.revision != expected {
                return Err("SOURCE_DEPENDENCY_SOURCE_CHANGED".into());
            }
            let Some(store) = ArchiveStore::open_existing(&cache)? else {
                return Ok(None);
            };
            store.cache_totals(&cancelled_for_work)?;
            let Some(set) = registry_store::verify_existing_since(
                &store,
                &derived.plan,
                &cancelled_for_work,
                started,
            )?
            else {
                return Ok(None);
            };
            Ok(Some(ConversionDependencies {
                dependency_home: set.dependency_home,
                node_path: derived.node_path,
                toolchain_fingerprint_sha256: derived.node_pin.fingerprint_sha256,
                dependency_set_id_sha256: set.set_id,
                dependency_tree_sha256: set.tree_sha256,
            }))
        },
        "SOURCE_DEPENDENCY_INSPECT_FAILED",
        None,
    )
    .await
}

fn output_plan(plan: &LockedDependencyPlanV1) -> Result<(String, usize), String> {
    let set_id = dependency_set_id_sha256(plan).map_err(|_| "SOURCE_DEPENDENCY_PLAN_INVALID")?;
    Ok((set_id, plan.packages.len()))
}

pub(crate) async fn execute(
    app: &AppHandle,
    db: &Database,
    tool_name: &str,
    arguments: Value,
    run_id: &str,
) -> Result<Value, String> {
    if !registry::is_tool(tool_name) {
        return Err("SOURCE_DEPENDENCY_TOOL_UNKNOWN".into());
    }
    if tool_name == registry::INSPECT {
        let args: InspectArgs =
            serde_json::from_value(arguments).map_err(|_| "SOURCE_DEPENDENCY_INVALID_ARGUMENTS")?;
        if !cfg!(target_os = "macos") {
            return Err("SOURCE_DEPENDENCY_PLATFORM_UNSUPPORTED".into());
        }
        let cache = cache_root(app)?;
        let lease = super::super::manager::global().claim(run_id)?;
        let source_path = args.source_path;
        let cancelled = lease.cancel.clone();
        let operation_deadline = Instant::now() + Duration::from_millis(OP_DEADLINE_MS);
        let operation = if let Err(error) = lease.phase(super::super::manager::Phase::Preparing) {
            Err(error)
        } else {
            run_blocking_until(cancelled.clone(), operation_deadline, move || {
            let derived = derive(&source_path, &cancelled)?;
            let maybe_store = ArchiveStore::open_existing(&cache)?;
            if let Some(store) = maybe_store.as_ref() { store.cache_totals(&cancelled)?; }
            let mut cached_bytes = 0u64;
            let mut missing_count = 0usize;
            let mut planned_archive_bytes = Some(0u64);
            if let Some(store) = maybe_store.as_ref() {
                for package in &derived.plan.packages {
                    if cancelled.load(Ordering::Acquire) { return Err("SOURCE_DEPENDENCY_CANCELLED".into()); }
                    match store.inspect_archive(package)? {
                        CachedArchive::Verified { bytes } => {
                            cached_bytes = cached_bytes.checked_add(bytes)
                                .ok_or("SOURCE_DEPENDENCY_CACHE_LIMIT")?;
                            if cached_bytes > PLAN_ARCHIVE_LIMIT { return Err("SOURCE_DEPENDENCY_ARCHIVE_LIMIT".into()); }
                            if let Some(total) = planned_archive_bytes.as_mut() {
                                *total = total.checked_add(bytes).ok_or("SOURCE_DEPENDENCY_ARCHIVE_LIMIT")?;
                                if *total > PLAN_ARCHIVE_LIMIT { return Err("SOURCE_DEPENDENCY_ARCHIVE_LIMIT".into()); }
                            }
                        }
                        CachedArchive::Corrupt(_) => {
                            missing_count += 1;
                            planned_archive_bytes = None;
                        }
                        CachedArchive::Missing => { missing_count += 1; planned_archive_bytes = None; }
                    }
                }
            } else {
                missing_count = derived.plan.packages.len();
                planned_archive_bytes = None;
            }
            if cancelled.load(Ordering::Acquire) { return Err("SOURCE_DEPENDENCY_CANCELLED".into()); }
            let (set_id, package_count) = output_plan(&derived.plan)?;
            let cached_set = if let Some(store) = maybe_store.as_ref() {
                registry_store::verify_existing(store, &derived.plan, &cancelled)?
            } else { None };
            Ok(json!({
                "status":"eligible", "sourceRevision":derived.source.revision,
                "planSha256":derived.plan.plan_sha256, "dependencySetIdSha256":set_id,
                "target":derived.plan.target, "packageCount":package_count,
                "skippedOptionalCount":derived.plan.skipped_optional.len(),
                "cachedBytes":cached_bytes, "missingCount":missing_count,
                "archiveBytes":planned_archive_bytes,
                "dependencySetPrepared":cached_set.is_some(),
                "dependencyTreeSha256":cached_set.as_ref().map(|set| set.tree_sha256.as_str()),
                "dependencyTreeBytes":cached_set.as_ref().map(|set| set.tree_bytes),
                "nodeBinaryBytes":derived.node_pin.bytes, "nodeBinarySha256":derived.node_pin.sha256,
                "toolchainFingerprintSha256":derived.node_pin.fingerprint_sha256,
                "toolchainHashElapsedMs":derived.node_pin.elapsed_ms,
                "lifecyclesSkipped":derived.plan.packages.iter().any(|package| package.lifecycle_scripts_skipped),
                "dependencyClosureVerified":false, "businessUsabilityVerified":false
            }))
        }, "SOURCE_DEPENDENCY_INSPECT_FAILED", None).await
        };
        let cancellation_won = lease.finish()?;
        if cancellation_won {
            finish_cancelled(app, db, run_id, tool_name, None)?;
            return Err("SOURCE_DEPENDENCY_CANCELLED".into());
        }
        operation
    } else {
        let args: OperationArgs =
            serde_json::from_value(arguments).map_err(|_| "SOURCE_DEPENDENCY_INVALID_ARGUMENTS")?;
        super::super::api::validate_path(&args.source_path)
            .map_err(|_| "SOURCE_DEPENDENCY_SOURCE_PATH_INVALID")?;
        if !valid_revision(&args.expected_revision) {
            return Err("SOURCE_DEPENDENCY_REVISION_INVALID".into());
        }
        let lease = super::super::manager::global().claim(run_id)?;
        let (prepare_diagnostic, _diagnostic_registration) = if tool_name == registry::PREPARE {
            let (context, registration) = diagnostics::register(run_id);
            (Some(context), Some(registration))
        } else {
            (None, None)
        };
        let result = if tool_name == registry::FETCH {
            execute_fetch(app, args, &lease).await
        } else if let Some(diagnostic) = prepare_diagnostic.as_ref() {
            execute_prepare(app, args, &lease, Arc::clone(diagnostic)).await
        } else {
            Err("SOURCE_DEPENDENCY_TOOL_UNKNOWN".into())
        };
        if lease.quarantine_unconfirmed_worker() {
            return Err(result
                .err()
                .unwrap_or_else(|| "SOURCE_DEPENDENCY_CLEANUP_UNCONFIRMED".to_owned()));
        }
        let cancellation_won = lease.finish()?;
        if cancellation_won {
            finish_cancelled(app, db, run_id, tool_name, prepare_diagnostic.as_deref())?;
            return Err("SOURCE_DEPENDENCY_CANCELLED".into());
        }
        if lease.cleanup_unconfirmed.load(Ordering::Acquire) {
            lease.quarantine();
        }
        result
    }
}

async fn derive_for_operation(
    args: &OperationArgs,
    lease: &super::super::manager::Lease,
    deadline: Instant,
    diagnostic: Option<&PrepareDiagnostic>,
) -> Result<Derived, String> {
    let source_path = args.source_path.clone();
    let expected = args.expected_revision.clone();
    let cancel = lease.cancel.clone();
    let cancel_for_work = cancel.clone();
    if let Some(diagnostic) = diagnostic {
        diagnostic.set_stage(DiagnosticStage::Derive);
    }
    let derived = run_blocking_until(
        cancel,
        deadline,
        move || derive(&source_path, &cancel_for_work),
        "SOURCE_DEPENDENCY_INSPECT_FAILED",
        diagnostic,
    )
    .await?;
    if derived.source.revision != expected {
        return Err("SOURCE_DEPENDENCY_SOURCE_CHANGED".into());
    }
    Ok(derived)
}

async fn execute_fetch(
    app: &AppHandle,
    args: OperationArgs,
    lease: &super::super::manager::Lease,
) -> Result<Value, String> {
    if !cfg!(target_os = "macos") {
        return Err("SOURCE_DEPENDENCY_PLATFORM_UNSUPPORTED".into());
    }
    lease.phase(super::super::manager::Phase::Fetching)?;
    let started = Instant::now();
    let deadline = started + Duration::from_millis(OP_DEADLINE_MS);
    let derived = derive_for_operation(&args, lease, deadline, None).await?;
    let cache = cache_root(app)?;
    let store = run_blocking_until(
        lease.cancel.clone(),
        deadline,
        move || ArchiveStore::open_for_write(&cache),
        "SOURCE_DEPENDENCY_CACHE_OPEN",
        None,
    )
    .await?;
    let fetched = fetch::fetch_missing(
        &store,
        &derived.plan,
        lease,
        &lease.cancel,
        deadline,
        &lease.cleanup_unconfirmed,
    )
    .await?;
    let (set_id, package_count) = output_plan(&derived.plan)?;
    Ok(
        json!({"status":"cached","sourceRevision":derived.source.revision,
        "dependencySetIdSha256":set_id,"packageCount":package_count,
        "cachedArchiveCount":fetched.cached_archives,"fetchedArchiveCount":fetched.fetched_archives,
        "verifiedArchiveBytes":fetched.archive_bytes,"elapsedMs":started.elapsed().as_millis(),
        "lifecyclesSkipped":derived.plan.packages.iter().any(|package| package.lifecycle_scripts_skipped),
        "dependencySetPrepared":false,"businessUsabilityVerified":false}),
    )
}

async fn execute_prepare(
    app: &AppHandle,
    args: OperationArgs,
    lease: &super::super::manager::Lease,
    diagnostic: Arc<PrepareDiagnostic>,
) -> Result<Value, String> {
    if !cfg!(target_os = "macos") {
        return Err("SOURCE_DEPENDENCY_PLATFORM_UNSUPPORTED".into());
    }
    lease.phase(super::super::manager::Phase::Preparing)?;
    let started = Instant::now();
    let deadline = started + Duration::from_millis(OP_DEADLINE_MS);
    let derived = derive_for_operation(&args, lease, deadline, Some(&diagnostic)).await?;
    let cache = cache_root(app)?;
    lease.phase(super::super::manager::Phase::Materializing)?;
    let prepared = materialize::prepare(
        &cache,
        derived.plan.clone(),
        derived.node_path,
        derived.node_pin,
        lease,
        lease.cancel.clone(),
        lease.worker_finished.clone(),
        lease.cleanup_unconfirmed.clone(),
        deadline,
        Arc::clone(&diagnostic),
    )
    .await?;
    Ok(
        json!({"status":"prepared","sourceRevision":derived.source.revision,
        "dependencySetIdSha256":prepared.set.set_id,"manifestSha256":prepared.set.receipt.manifest_sha256,
        "packageCount":prepared.set.receipt.package_count,"archiveBytes":prepared.set.receipt.archive_bytes,
        "unpackedBytes":prepared.set.receipt.unpacked_bytes,"fileCount":prepared.set.receipt.file_count,
        "treeSha256":prepared.set.tree_sha256,"treeEntries":prepared.set.tree_entries,
        "treeFiles":prepared.set.tree_files,"treeBytes":prepared.set.tree_bytes,
        "nodeBinaryBytes":prepared.node_pin.bytes,"nodeBinarySha256":prepared.node_pin.sha256,
        "toolchainFingerprintSha256":prepared.node_pin.fingerprint_sha256,
        "toolchainHashElapsedMs":prepared.node_pin.elapsed_ms,"workerElapsedMs":prepared.elapsed_ms,
        "dependencyClosureVerified":false,"businessUsabilityVerified":false}),
    )
}

async fn run_blocking_until<T, F>(
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
    task: F,
    join_error: &'static str,
    diagnostic: Option<&PrepareDiagnostic>,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let mut handle = tauri::async_runtime::spawn_blocking(task);
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        if let Some(diagnostic) = diagnostic {
            diagnostic.deadline_observed();
        }
        cancelled.store(true, Ordering::Release);
        if let Some(diagnostic) = diagnostic {
            diagnostic.begin_cleanup();
        }
        let _ = handle.await;
        if let Some(diagnostic) = diagnostic {
            diagnostic.end_cleanup();
        }
        return Err("SOURCE_DEPENDENCY_OPERATION_TIMEOUT".into());
    }
    match tokio::time::timeout(remaining, &mut handle).await {
        Ok(joined) => joined.map_err(|_| join_error.to_owned())?,
        Err(_) => {
            if let Some(diagnostic) = diagnostic {
                diagnostic.deadline_observed();
            }
            cancelled.store(true, Ordering::Release);
            if let Some(diagnostic) = diagnostic {
                diagnostic.begin_cleanup();
            }
            let _ = handle.await;
            if let Some(diagnostic) = diagnostic {
                diagnostic.end_cleanup();
            }
            Err("SOURCE_DEPENDENCY_OPERATION_TIMEOUT".into())
        }
    }
}

fn valid_revision(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(crate) fn request_cancel(app: &AppHandle, run: &TaskRun) -> Result<TaskRun, String> {
    let manager = super::super::manager::global();
    request_cancel_with_manager(run, manager.as_ref())?;
    let _ = app;
    Ok(run.clone())
}

fn request_cancel_with_manager(
    run: &TaskRun,
    manager: &super::super::manager::BuildManager,
) -> Result<(), String> {
    if !registry::is_tool(&run.capability_id) {
        return Err("SOURCE_DEPENDENCY_TASK_IDENTITY".into());
    }
    manager.cancel(&run.id)?;
    if run.capability_id == registry::PREPARE {
        diagnostics::mark_accepted_user_cancel(&run.id);
    }
    Ok(())
}

pub(crate) fn state(run: &TaskRun) -> Result<super::super::manager::BuildState, String> {
    if !registry::is_tool(&run.capability_id) {
        return Err("SOURCE_DEPENDENCY_TASK_IDENTITY".into());
    }
    Ok(super::super::manager::global().state(&run.id))
}

fn finish_cancelled(
    app: &AppHandle,
    db: &Database,
    id: &str,
    tool: &str,
    diagnostic: Option<&PrepareDiagnostic>,
) -> Result<(), String> {
    let mut run = db
        .get_task_run(id)
        .map_err(|_| "SOURCE_DEPENDENCY_TASK_READ")?
        .ok_or("SOURCE_DEPENDENCY_TASK_MISSING")?;
    if run.capability_id != tool || run.status != TaskRunStatus::Running {
        return Err("SOURCE_DEPENDENCY_TASK_IDENTITY".into());
    }
    if tool == registry::PREPARE {
        if let Some(diagnostic) = diagnostic {
            diagnostic.set_stage(DiagnosticStage::TerminalCleanup);
            diagnostics::attach_to_run(&mut run, diagnostic);
        }
    }
    run.summary = Some("Locked dependency operation cancelled after its work stopped".into());
    run.transition(TaskRunStatus::Cancelled)
        .map_err(|_| "SOURCE_DEPENDENCY_TASK_CHANGED")?;
    if !db
        .finish_running_task_run(&run)
        .map_err(|_| "SOURCE_DEPENDENCY_TASK_CHANGED")?
    {
        return Err("SOURCE_DEPENDENCY_TASK_CHANGED".into());
    }
    crate::permission_requests::remove_for_run(app, id);
    let _ = app.emit("task-run-updated", id);
    Ok(())
}

#[cfg(test)]
#[path = "service_diagnostic_tests.rs"]
mod diagnostic_tests;
