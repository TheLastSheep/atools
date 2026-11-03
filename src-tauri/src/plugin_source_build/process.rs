//! Permission-gated local Vite execution. No package manager or inherited env.
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use atools_plugin::source_build::{SourceBuildPlan, ViteBuildBackend};
use serde::Serialize;

use super::{
    failure::{RunnerFailure, SourceBuildFailure},
    profile,
    staging::{self, TreeStats, Workspace},
};
#[cfg(unix)]
#[path = "dependency_view.rs"]
mod dependency_view;
#[path = "manifest_output.rs"]
mod manifest_output;
#[path = "process_output.rs"]
mod output;
#[path = "runner_plan.rs"]
mod runner_plan;
#[path = "process_supervisor.rs"]
mod supervisor;

#[cfg(test)]
#[path = "process_completion_tests.rs"]
mod completion_tests;
#[cfg(all(test, unix))]
#[path = "manifest_output_tests.rs"]
mod manifest_output_tests;
#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuildDiagnostics {
    pub adapter: &'static str,
    pub profile_sha256: String,
    pub elapsed_ms: u64,
    pub source_revision: String,
    pub input: TreeStats,
    pub output: TreeStats,
    pub captured_log_bytes: usize,
    pub exit_code: Option<i32>,
    pub root_reaped: bool,
    pub original_group_closed: bool,
    pub streams_closed: bool,
    pub full_tree_containment: bool,
    pub aggregate_resource_caps: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_rewrite: Option<manifest_output::ManifestRewriteReceipt>,
}

pub(crate) struct PreparedBuild {
    pub(crate) output_dir: PathBuf,
    pub(crate) diagnostics: BuildDiagnostics,
    _workspace: Workspace,
}

struct CancelOnDrop(Option<Arc<AtomicBool>>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(cancel) = &self.0 {
            cancel.store(true, Ordering::Release);
        }
    }
}
struct FinishOnDrop {
    finished: Arc<AtomicBool>,
    cleanup_unconfirmed: Arc<AtomicBool>,
    known_safe: bool,
}
impl Drop for FinishOnDrop {
    fn drop(&mut self) {
        if !self.known_safe {
            self.cleanup_unconfirmed.store(true, Ordering::Release);
        }
        self.finished.store(true, Ordering::Release);
    }
}

type Worker = Box<dyn FnOnce() + Send + 'static>;
trait WorkerFailureState: From<&'static str> + Send + 'static {
    fn cleanup_unconfirmed(&self) -> bool;
}

impl WorkerFailureState for String {
    fn cleanup_unconfirmed(&self) -> bool {
        self == "SOURCE_BUILD_CLEANUP_UNCONFIRMED"
    }
}

impl WorkerFailureState for SourceBuildFailure {
    fn cleanup_unconfirmed(&self) -> bool {
        SourceBuildFailure::cleanup_unconfirmed(self)
    }
}

async fn wait_for_worker<T, E: WorkerFailureState>(
    receiver: tokio::sync::oneshot::Receiver<Result<T, E>>,
    finished: &AtomicBool,
) -> Result<Result<T, E>, E> {
    // Observe completion even when the channel closes: the worker may still be
    // unwinding and publishing its cleanup state after the receiver is dropped.
    let result = receiver
        .await
        .map_err(|_| E::from("SourceBuildSupervisorTerminated"));
    while !finished.load(Ordering::Acquire) {
        tokio::task::yield_now().await;
    }
    result
}

fn spawn_worker<T: Send + 'static, E: WorkerFailureState>(
    work: impl FnOnce() -> Result<T, E> + Send + 'static,
    finished: Arc<AtomicBool>,
    cleanup_unconfirmed: Arc<AtomicBool>,
    spawn: impl FnOnce(Worker) -> std::io::Result<()>,
) -> Result<tokio::sync::oneshot::Receiver<Result<T, E>>, E> {
    finished.store(false, Ordering::Release);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let worker_finished = finished.clone();
    let job = Box::new(move || {
        // Unknown panic/early unwinding is unsafe by default. Publish that fact
        // before finished, even when the awaiting TaskRun has been aborted.
        let mut completion = FinishOnDrop {
            finished: worker_finished,
            cleanup_unconfirmed,
            known_safe: false,
        };
        let result = work();
        let known_safe = result
            .as_ref()
            .err()
            .is_none_or(|error| !error.cleanup_unconfirmed());
        // A failed send drops the host-only PreparedBuild before finished. Its
        // cleanup signal must not arrive after an abandoned job is admitted.
        if let Err(undelivered) = sender.send(result) {
            drop(undelivered);
        }
        completion.known_safe = known_safe;
        drop(completion);
    });
    if spawn(job).is_err() {
        // No worker started: no untrusted process or uncertain writer exists.
        finished.store(true, Ordering::Release);
        return Err("SourceBuildSupervisorUnavailable".into());
    }
    Ok(receiver)
}

/// The supervisor owns its stage and child independently of the awaiting task.
/// A dropped/aborted future cancels; `finished` changes only after supervision
/// terminates, so the host retains its single-job admission until then.
pub(crate) async fn build(
    plan: SourceBuildPlan,
    node: PathBuf,
    cancel: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    cleanup_unconfirmed: Arc<AtomicBool>,
    expected_revision: String,
) -> Result<PreparedBuild, SourceBuildFailure> {
    let mut cancel_on_drop = CancelOnDrop(Some(cancel.clone()));
    let observed_finished = finished.clone();
    let cleanup_signal = cleanup_unconfirmed.clone();
    let receiver = match spawn_worker(
        move || {
            let result = execute(
                plan,
                node,
                &cancel,
                &expected_revision,
                cleanup_signal.clone(),
            );
            if cleanup_signal.load(Ordering::Acquire) {
                match result {
                    Err(SourceBuildFailure::Runner(failure)) => Err(SourceBuildFailure::Runner(
                        failure.with_cleanup_unconfirmed(),
                    )),
                    _ => Err("SOURCE_BUILD_CLEANUP_UNCONFIRMED".into()),
                }
            } else {
                result
            }
        },
        finished,
        cleanup_unconfirmed,
        |job| {
            std::thread::Builder::new()
                .name("atools-source-build".into())
                .spawn(job)
                .map(|_| ())
        },
    ) {
        Ok(receiver) => receiver,
        Err(error) => {
            cancel_on_drop.0 = None;
            return Err(error);
        }
    };
    let result = wait_for_worker(receiver, &observed_finished).await;
    cancel_on_drop.0 = None;
    result?
}

#[cfg(not(target_os = "macos"))]
fn execute(
    _: SourceBuildPlan,
    _: PathBuf,
    _: &AtomicBool,
    _: &str,
    _: Arc<AtomicBool>,
) -> Result<PreparedBuild, SourceBuildFailure> {
    Err("SourceBuildSandboxUnsupported".into())
}

#[cfg(target_os = "macos")]
fn execute(
    plan: SourceBuildPlan,
    node: PathBuf,
    cancel: &AtomicBool,
    expected_revision: &str,
    cleanup_unconfirmed: Arc<AtomicBool>,
) -> Result<PreparedBuild, SourceBuildFailure> {
    use sha2::{Digest, Sha256};
    let started = std::time::Instant::now();
    if cancel.load(Ordering::Acquire) {
        return Err("SOURCE_BUILD_CANCELLED".into());
    }
    let node = staging::canonical_file(&node)?;
    let dependencies = staging::canonical_directory(&plan.dependency_root)?;
    let vite = staging::canonical_file(&plan.vite_cli)?;
    let vite_backend = match &plan.vite_backend {
        ViteBuildBackend::Esbuild { binary } => ViteBuildBackend::Esbuild {
            binary: staging::canonical_file(binary)?,
        },
        ViteBuildBackend::Rolldown { binding } => ViteBuildBackend::Rolldown {
            binding: staging::canonical_file(binding)?,
        },
    };
    runner_plan::validate_test_esbuild_presence(
        &plan.build_steps,
        plan.test_esbuild_binary.is_some(),
    )?;
    let test_esbuild = plan
        .test_esbuild_binary
        .as_ref()
        .map(|path| staging::canonical_file(path))
        .transpose()?;
    if !vite.starts_with(&dependencies)
        || !vite_backend.path().starts_with(&dependencies)
        || test_esbuild
            .as_ref()
            .is_some_and(|path| !path.starts_with(&dependencies))
        || node.starts_with(&plan.source_root)
    {
        return Err("SourceBuildUnsafeToolchain".into());
    }
    let mut workspace = Workspace::with_signal(cleanup_unconfirmed.clone())?;
    if node.starts_with(&workspace.root) || dependencies.starts_with(&workspace.root) {
        return Err("SourceBuildUnsafeToolchain".into());
    }
    let work = workspace.root.join("work");
    let input = staging::snapshot(&plan.source_root, &work, cancel)?;
    let (source_revision, _) = staging::source_digest(&work, cancel)?;
    if source_revision != expected_revision {
        return Err("SourceBuildSourceRevisionChanged".into());
    }
    let approved_manifest = output::approved_manifest(&work, &plan)?;
    dependency_view::create(&dependencies, &work.join("node_modules"), cancel)?;
    let sandbox = profile::render_with_vite_backend(
        &workspace.root,
        &dependencies,
        &node,
        &vite_backend,
        test_esbuild.as_deref(),
    )?;
    let profile_sha256 = format!("{:x}", Sha256::digest(sandbox.as_bytes()));
    let profile_path = workspace.root.join("build.sb");
    std::fs::write(&profile_path, sandbox).map_err(|_| "SourceBuildProfileWriteFailed")?;
    let runner = work.join(".atools-source-build-runner.mjs");
    let plan_file = work.join(".atools-source-build-plan.json");
    let runner_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&runner)
        .map_err(|_| "SourceBuildRunnerCollision")?;
    use std::io::Write;
    let mut runner_file = runner_file;
    runner_file
        .write_all(include_bytes!("source_build_runner.mjs"))
        .map_err(|_| "SourceBuildRunnerWriteFailed")?;
    drop(runner_file);
    let plan_bytes = runner_plan::serialize(
        &plan.build_steps,
        &dependencies,
        &vite_backend,
        test_esbuild.as_deref(),
    )?;
    if plan_bytes.len() > 64 * 1024 {
        return Err("SourceBuildPlanLimitExceeded".into());
    }
    let mut plan_output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&plan_file)
        .map_err(|_| "SourceBuildPlanCollision")?;
    plan_output
        .write_all(&plan_bytes)
        .map_err(|_| "SourceBuildPlanWriteFailed")?;
    drop(plan_output);
    // Only mark the staging workspace as potentially busy once all host-owned
    // runner inputs have been written successfully and immediately before the
    // process supervisor can start the child.
    workspace.mark_running();
    let command = supervisor::CommandSpec {
        stage: &workspace.root,
        work: &work,
        profile: &profile_path,
        node: &node,
        entry: &runner,
        args: vec![],
        vite_backend_path: vite_backend.path(),
        rolldown_backend: matches!(&vite_backend, ViteBuildBackend::Rolldown { .. }),
        test_esbuild: test_esbuild.as_deref(),
        dependencies: &dependencies,
    };
    let outcome = supervisor::run(command, cancel, supervisor::Limits::default());
    let supervisor::Outcome {
        result,
        cleanup_confirmed,
        diagnostic_log,
        exit,
    } = outcome;
    let runner_exit_code = exit.as_ref().and_then(std::process::ExitStatus::code);
    #[cfg(unix)]
    let runner_signal = {
        use std::os::unix::process::ExitStatusExt;
        exit.as_ref().and_then(|status| status.signal())
    };
    #[cfg(not(unix))]
    let runner_signal = None;
    if cleanup_confirmed {
        workspace.mark_quiescent();
    } else {
        return Err(SourceBuildFailure::Runner(RunnerFailure::observed(
            "SOURCE_BUILD_CLEANUP_UNCONFIRMED",
            false,
            runner_exit_code,
            runner_signal,
            diagnostic_log,
        )));
    }
    let captured_log_bytes = diagnostic_log.len();
    let result = match result {
        Ok(receipt) => receipt,
        Err(error) => {
            return Err(SourceBuildFailure::Runner(RunnerFailure::observed(
                &error,
                cleanup_confirmed,
                runner_exit_code,
                runner_signal,
                diagnostic_log,
            )))
        }
    };
    if cancel.load(Ordering::Acquire) {
        return Err(SourceBuildFailure::Runner(RunnerFailure::observed(
            "SOURCE_BUILD_CANCELLED",
            cleanup_confirmed,
            runner_exit_code,
            runner_signal,
            diagnostic_log,
        )));
    }
    let output_dir = work.join("dist");
    let initial_output = staging::verify_output(&output_dir, cancel)?;
    let manifest_rewrite =
        manifest_output::rewrite_verified_output(&output_dir, &plan, &approved_manifest)?;
    let output = if manifest_rewrite.is_some() {
        staging::verify_output(&output_dir, cancel)?
    } else {
        initial_output
    };
    output::validate(&output_dir, &plan, &approved_manifest)?;
    // The build's SBPL never granted this freshly created sibling workspace.
    // Recreate normal owned files there, validate again, and remove all
    // untrusted staging before the host is allowed to import any package.
    let published = Workspace::with_signal(cleanup_unconfirmed)?;
    let published_output = published.root.join("package");
    let copied = staging::copy_output(&output_dir, &published_output, cancel)?;
    let verified = staging::verify_output(&published_output, cancel)?;
    if let Some(receipt) = manifest_rewrite.as_ref() {
        manifest_output::verify_published_manifest(&published_output, receipt, &plan)?;
    }
    output::validate(&published_output, &plan, &approved_manifest)?;
    if copied.bytes != output.bytes
        || copied.entries != output.entries
        || verified.bytes != copied.bytes
        || verified.entries != copied.entries
    {
        return Err("SourceBuildOutputChanged".into());
    }
    workspace.cleanup()?;
    Ok(PreparedBuild {
        output_dir: published_output,
        diagnostics: BuildDiagnostics {
            adapter: profile::ADAPTER_VERSION,
            profile_sha256,
            elapsed_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            source_revision,
            input,
            output,
            captured_log_bytes,
            exit_code: result.exit_code,
            root_reaped: true,
            original_group_closed: true,
            streams_closed: true,
            full_tree_containment: false,
            aggregate_resource_caps: false,
            manifest_rewrite,
        },
        _workspace: published,
    })
}
