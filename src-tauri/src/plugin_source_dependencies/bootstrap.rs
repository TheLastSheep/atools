use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

use atools_plugin::source_build::{
    dependency_set_id_sha256, verify_plan_checksum, DependencySetReceiptV1, LockedDependencyPlanV1,
};
use serde::Serialize;

#[path = "network_policy_probe.rs"]
mod network_policy_probe;

use super::archive::{materialize_package, ArchiveSpec, DestinationLedger, Totals};
#[cfg(target_os = "macos")]
use super::limits::{apply_process_limits, Deadline, PACKAGE_COUNT, PLAN_BYTES};
use super::manifest::{PackageRecord, SetManifest, TargetRecord};
use super::package_identity::validate_package_identity;
use super::tar_format::package_components;

pub(crate) const WORKER_FLAG: &str = "--atools-locked-dependency-worker";
const POLICY_PROBE_FLAG: &str = "--atools-locked-dependency-policy-probe";
const ARGUMENT_LIMIT: usize = 7;
const STAGE_MODE: u32 = 0o700;

#[derive(Debug)]
struct Invocation {
    mode: Mode,
    archive_root: PathBuf,
    stage_root: PathBuf,
    cancel_fd: Option<i32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    Materialize,
    PolicyProbe,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum WorkerResponse<'a> {
    Complete {
        receipt: DependencySetReceiptV1,
    },
    Failed {
        code: &'a str,
    },
    PolicyProbe {
        fork_denied: bool,
        network_connect_denied: bool,
    },
}

/// Dispatches only a first-argument internal mode. All failures emit fixed codes
/// and exit without entering Tauri or falling through to the normal UI.
pub(crate) fn run_if_requested() {
    let mut arguments = std::env::args_os();
    let _ = arguments.next();
    let Some(first) = arguments.next() else {
        return;
    };
    if first != WORKER_FLAG && first != POLICY_PROBE_FLAG {
        if arguments.any(|argument| argument == WORKER_FLAG || argument == POLICY_PROBE_FLAG) {
            exit_failed("dependency_worker_arguments_invalid");
        }
        return;
    }
    let mode = if first == WORKER_FLAG {
        Mode::Materialize
    } else {
        Mode::PolicyProbe
    };
    let rest = arguments.collect::<Vec<_>>();
    match parse_invocation(mode, rest) {
        Ok(invocation) => {
            #[cfg(target_os = "macos")]
            {
                if let Err(code) = execute(invocation) {
                    exit_failed(code);
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = invocation;
                exit_failed("dependency_worker_platform_unsupported");
            }
        }
        Err(code) => exit_failed(code),
    }
    std::process::exit(0);
}

fn parse_invocation(mode: Mode, args: Vec<OsString>) -> Result<Invocation, &'static str> {
    let expected = if mode == Mode::Materialize { 6 } else { 4 };
    if args.len() != expected || args.len() > ARGUMENT_LIMIT {
        return Err("dependency_worker_arguments_invalid");
    }
    let mut index = 0;
    let archive_root = take_root(&args, &mut index, "--archive-root")?;
    let stage_root = take_root(&args, &mut index, "--stage-root")?;
    let cancel_fd = if mode == Mode::Materialize {
        if args.get(index).and_then(|value| value.to_str()) != Some("--cancel-fd") {
            return Err("dependency_worker_arguments_invalid");
        }
        index += 1;
        let raw = args
            .get(index)
            .and_then(|value| value.to_str())
            .ok_or("dependency_worker_arguments_invalid")?;
        index += 1;
        let fd = raw
            .parse::<i32>()
            .map_err(|_| "dependency_worker_arguments_invalid")?;
        if fd < 3 || fd > 2047 {
            return Err("dependency_worker_arguments_invalid");
        }
        Some(fd)
    } else {
        None
    };
    if index != args.len() || archive_root == stage_root {
        return Err("dependency_worker_arguments_invalid");
    }
    Ok(Invocation {
        mode,
        archive_root,
        stage_root,
        cancel_fd,
    })
}

fn take_root(args: &[OsString], index: &mut usize, flag: &str) -> Result<PathBuf, &'static str> {
    if args.get(*index).and_then(|value| value.to_str()) != Some(flag) {
        return Err("dependency_worker_arguments_invalid");
    }
    *index += 1;
    let value = args
        .get(*index)
        .ok_or("dependency_worker_arguments_invalid")?;
    *index += 1;
    let text = value.to_str().ok_or("dependency_worker_roots_invalid")?;
    let path = PathBuf::from(text);
    if !path.is_absolute()
        || text.chars().any(char::is_control)
        || path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err("dependency_worker_roots_invalid");
    }
    Ok(path)
}

#[cfg(target_os = "macos")]
fn execute(invocation: Invocation) -> Result<(), &'static str> {
    apply_process_limits()?;
    let archive_root = validate_root(&invocation.archive_root, false)?;
    let stage_root = validate_root(&invocation.stage_root, true)?;
    if let Some(fd) = invocation.cancel_fd {
        validate_cancel_pipe(fd)?;
    }
    if archive_root == stage_root
        || archive_root.starts_with(&stage_root)
        || stage_root.starts_with(&archive_root)
    {
        return Err("dependency_worker_roots_invalid");
    }
    super::sandbox_macos::install(&archive_root, &stage_root)?;
    if invocation.mode == Mode::PolicyProbe {
        let (fork_denied, network_connect_denied) = policy_probe();
        emit(&WorkerResponse::PolicyProbe {
            fork_denied,
            network_connect_denied,
        })?;
        return Ok(());
    }
    if fs::read_dir(&stage_root)
        .map_err(|_| "dependency_stage_unavailable")?
        .next()
        .is_some()
    {
        return Err("dependency_stage_not_empty");
    }
    let mut request = Vec::new();
    std::io::stdin()
        .take((PLAN_BYTES + 1) as u64)
        .read_to_end(&mut request)
        .map_err(|_| "dependency_plan_read_failed")?;
    if request.is_empty() || request.len() > PLAN_BYTES {
        return Err("dependency_plan_limit");
    }
    let plan: LockedDependencyPlanV1 =
        serde_json::from_slice(&request).map_err(|_| "dependency_plan_invalid")?;
    if !verify_plan_checksum(&plan).map_err(|_| "dependency_plan_invalid")? {
        return Err("dependency_plan_checksum_invalid");
    }
    validate_plan(&plan)?;
    let deadline = Deadline::with_cancel_fd(
        invocation
            .cancel_fd
            .ok_or("dependency_worker_arguments_invalid")?,
    );
    deadline.check()?;
    let mut totals = Totals::default();
    let mut ledger = DestinationLedger::default();
    let mut package_records = Vec::with_capacity(plan.packages.len());
    for package in &plan.packages {
        deadline.check()?;
        let before = totals;
        let spec = ArchiveSpec {
            package_path: &package.package_path,
            archive_id_sha256: &package.archive_id_sha256,
            algorithm: &package.integrity.algorithm,
            digest_hex: &package.integrity.digest_hex,
        };
        materialize_package(
            &archive_root,
            &stage_root,
            &spec,
            &mut totals,
            &mut ledger,
            &deadline,
        )?;
        validate_package_identity(
            &stage_root,
            &package.package_path,
            &package.name,
            &package.version,
            &deadline,
        )?;
        package_records.push(PackageRecord {
            package_path: package.package_path.clone(),
            name: package.name.clone(),
            version: package.version.clone(),
            archive_id_sha256: package.archive_id_sha256.clone(),
            archive_bytes: totals.archive_bytes - before.archive_bytes,
            unpacked_bytes: totals.unpacked_bytes - before.unpacked_bytes,
            file_count: totals.file_count - before.file_count,
        });
    }
    deadline.check()?;
    let set_id = dependency_set_id_sha256(&plan).map_err(|_| "dependency_plan_invalid")?;
    let manifest = SetManifest {
        schema_version: 1,
        set_id_sha256: set_id.clone(),
        plan_sha256: plan.plan_sha256.clone(),
        source_revision_sha256: plan.source_revision_sha256.clone(),
        package_lock_sha256: plan.package_lock_sha256.clone(),
        target: TargetRecord {
            os: plan.target.os.clone(),
            cpu: plan.target.cpu.clone(),
        },
        packages: package_records,
        skipped_optional_count: plan.skipped_optional.len(),
        package_count: plan.package_count,
        archive_bytes: totals.archive_bytes,
        unpacked_bytes: totals.unpacked_bytes,
        file_count: totals.file_count,
    };
    let manifest_bytes = manifest.encoded()?;
    if manifest_bytes.len() > PLAN_BYTES {
        return Err("dependency_manifest_limit");
    }
    let manifest_hash = SetManifest::sha256(&manifest_bytes);
    let path = stage_root.join(".atools-dependency-set-v1.json");
    let mut options = fs::OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let mut file = options
        .open(path)
        .map_err(|_| "dependency_manifest_write_failed")?;
    file.write_all(&manifest_bytes)
        .map_err(|_| "dependency_manifest_write_failed")?;
    file.sync_all()
        .map_err(|_| "dependency_manifest_write_failed")?;
    let receipt = DependencySetReceiptV1 {
        schema_version: 1,
        set_id_sha256: set_id,
        manifest_sha256: manifest_hash,
        source_revision_sha256: plan.source_revision_sha256,
        package_lock_sha256: plan.package_lock_sha256,
        target: plan.target,
        package_count: plan.package_count,
        archive_bytes: totals.archive_bytes,
        unpacked_bytes: totals.unpacked_bytes,
        file_count: totals.file_count,
    };
    emit(&WorkerResponse::Complete { receipt })
}

#[cfg(target_os = "macos")]
fn validate_cancel_pipe(fd: i32) -> Result<(), &'static str> {
    let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut metadata) } != 0
        || (metadata.st_mode & libc::S_IFMT) != libc::S_IFIFO
    {
        return Err("dependency_worker_arguments_invalid");
    }
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err("dependency_worker_arguments_invalid");
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn validate_root(path: &Path, stage: bool) -> Result<PathBuf, &'static str> {
    let before = fs::symlink_metadata(path).map_err(|_| "dependency_worker_roots_invalid")?;
    if !before.is_dir()
        || before.file_type().is_symlink()
        || before.uid() != unsafe { libc::geteuid() }
    {
        return Err("dependency_worker_roots_invalid");
    }
    if stage {
        if before.permissions().mode() & 0o777 != STAGE_MODE {
            return Err("dependency_stage_permissions_invalid");
        }
    } else if before.permissions().mode() & 0o022 != 0 {
        return Err("dependency_cache_permissions_invalid");
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "dependency_worker_roots_invalid")?;
    if canonical != path {
        return Err("dependency_worker_roots_invalid");
    }
    let after = fs::symlink_metadata(path).map_err(|_| "dependency_worker_roots_invalid")?;
    if after.dev() != before.dev() || after.ino() != before.ino() || !after.is_dir() {
        return Err("dependency_worker_roots_invalid");
    }
    Ok(canonical)
}

#[cfg(target_os = "macos")]
fn validate_plan(plan: &LockedDependencyPlanV1) -> Result<(), &'static str> {
    if plan.packages.len() > PACKAGE_COUNT
        || plan.packages.len() + plan.skipped_optional.len() > PACKAGE_COUNT
        || plan.package_count != plan.packages.len()
        || plan.target.os != "darwin"
        || plan.target.cpu != current_cpu()
        || plan
            .packages
            .windows(2)
            .any(|pair| pair[0].package_path >= pair[1].package_path)
    {
        return Err("dependency_plan_invalid");
    }
    let mut paths = std::collections::HashSet::new();
    for package in &plan.packages {
        if !paths.insert(package.package_path.as_str())
            || package_components(&package.package_path).is_err()
            || !package_path_matches_name(&package.package_path, &package.name)
            || package.name.is_empty()
            || package.version.is_empty()
            || package.name.chars().any(char::is_control)
            || package.version.chars().any(char::is_control)
        {
            return Err("dependency_plan_invalid");
        }
        let url = url::Url::parse(&package.resolved_url).map_err(|_| "dependency_plan_invalid")?;
        if url.scheme() != "https"
            || url.host_str() != Some("registry.npmjs.org")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.port().is_some()
        {
            return Err("dependency_plan_invalid");
        }
    }
    for skipped in &plan.skipped_optional {
        if !paths.insert(skipped.package_path.as_str())
            || package_components(&skipped.package_path).is_err()
            || !package_path_matches_name(&skipped.package_path, &skipped.name)
            || !matches!(
                skipped.reason.as_str(),
                "target_os_mismatch" | "target_cpu_mismatch"
            )
        {
            return Err("dependency_plan_invalid");
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn package_path_matches_name(path: &str, name: &str) -> bool {
    let suffix = format!("node_modules/{name}");
    path == suffix || path.ends_with(&format!("/node_modules/{name}"))
}

#[cfg(target_os = "macos")]
fn current_cpu() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => "unsupported",
    }
}

#[cfg(target_os = "macos")]
fn policy_probe() -> (bool, bool) {
    let fork_result = unsafe { libc::fork() };
    let fork_denied = if fork_result < 0 {
        matches!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EPERM) | Some(libc::EACCES)
        )
    } else if fork_result == 0 {
        unsafe { libc::_exit(0) }
    } else {
        let mut status = 0;
        unsafe { libc::waitpid(fork_result, &mut status, 0) };
        false
    };
    let network_connect_denied = network_policy_probe::loopback_connect_denied();
    (fork_denied, network_connect_denied)
}

#[cfg(target_os = "macos")]
fn emit(response: &WorkerResponse<'_>) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec(response).map_err(|_| "dependency_worker_output_failed")?;
    if bytes.len() > 16 * 1024 {
        return Err("dependency_worker_output_limit");
    }
    let mut output = std::io::stdout().lock();
    output
        .write_all(&bytes)
        .map_err(|_| "dependency_worker_output_failed")?;
    output
        .write_all(b"\n")
        .map_err(|_| "dependency_worker_output_failed")?;
    output
        .flush()
        .map_err(|_| "dependency_worker_output_failed")
}

#[cfg(target_os = "macos")]
fn exit_failed(code: &str) -> ! {
    let response = WorkerResponse::Failed { code };
    #[cfg(target_os = "macos")]
    let _ = emit(&response);
    #[cfg(not(target_os = "macos"))]
    {
        let bytes = serde_json::to_vec(&response).unwrap_or_else(|_| {
            b"{\"status\":\"failed\",\"code\":\"dependency_worker_failed\"}".to_vec()
        });
        let _ = std::io::stdout().write_all(&bytes);
        let _ = std::io::stdout().write_all(b"\n");
    }
    std::process::exit(70)
}

#[cfg(test)]
mod policy_response_tests {
    use super::WorkerResponse;

    #[test]
    fn policy_probe_serializes_connect_denial_field() {
        let response = WorkerResponse::PolicyProbe {
            fork_denied: true,
            network_connect_denied: true,
        };
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["networkConnectDenied"], true);
        assert!(value.get("networkSocketDenied").is_none());
    }
}
