#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("LOCKED_DEPENDENCY_WORKER_SMOKE_UNSUPPORTED_PLATFORM");
    std::process::exit(2);
}

#[cfg(target_os = "macos")]
#[path = "../src/plugin_source_dependencies/manifest.rs"]
mod manifest;

#[cfg(target_os = "macos")]
#[path = "../src/plugin_source_dependencies/observation.rs"]
mod observation;

#[cfg(target_os = "macos")]
#[path = "../src/plugin_source_dependencies/receipt.rs"]
mod receipt;

#[cfg(target_os = "macos")]
#[path = "../src/plugin_source_dependencies/supervisor.rs"]
mod supervisor;

#[cfg(target_os = "macos")]
#[path = "../src/plugin_source_dependencies/worker_io.rs"]
mod worker_io;

#[cfg(target_os = "macos")]
fn main() {
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new(supervisor::IGNORE_CANCEL_PROBE_FLAG))
    {
        ignore_cancel_probe();
    }
    atools_lib::run_source_build_bootstrap_if_requested();
    if let Err(code) = run_smoke() {
        eprintln!("LOCKED_DEPENDENCY_WORKER_SMOKE_FAILED:{code}");
        std::process::exit(1);
    }
    println!("LOCKED_DEPENDENCY_WORKER_SMOKE_PASS");
}

#[cfg(target_os = "macos")]
fn ignore_cancel_probe() -> ! {
    use std::io::{Read, Write};

    let arguments = std::env::args_os().collect::<Vec<_>>();
    let expected = arguments
        .windows(2)
        .find(|pair| pair[0] == "--probe-bytes")
        .and_then(|pair| pair[1].to_str())
        .and_then(|value| value.parse::<usize>().ok());
    let Some(expected) = expected.filter(|value| *value > 0 && *value <= 1024 * 1024) else {
        std::process::exit(71);
    };
    let mut input = Vec::new();
    if std::io::stdin()
        .take((1024 * 1024 + 1) as u64)
        .read_to_end(&mut input)
        .is_err()
        || input.len() != expected
    {
        std::process::exit(72);
    }
    let mut stdout = std::io::stdout();
    if stdout
        .write_all(supervisor::CANCEL_IGNORE_READY_MARKER)
        .is_err()
        || stdout.flush().is_err()
    {
        std::process::exit(73);
    }
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}

#[cfg(target_os = "macos")]
fn run_smoke() -> Result<(), &'static str> {
    use atools_plugin::source_build::{build_locked_dependency_plan, BuildTargetV1};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use flate2::{write::GzEncoder, Compression};
    use sha2::{Digest, Sha256, Sha512};
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::sync::atomic::AtomicBool;

    let nonce = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "clock")?
            .as_nanos()
    );
    let root = std::env::temp_dir().join(format!("atools-dependency-smoke-{nonce}"));
    fs::create_dir(&root).map_err(|_| "fixture_create")?;
    let root = fs::canonicalize(root).map_err(|_| "fixture_create")?;
    let _owned_root = OwnedFixtureRoot(root.clone());
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .map_err(|_| "fixture_permissions")?;
    let cache = root.join("cache");
    fs::create_dir(&cache).map_err(|_| "fixture_create")?;
    fs::set_permissions(&cache, fs::Permissions::from_mode(0o700))
        .map_err(|_| "fixture_permissions")?;

    let package_json =
        br#"{"name":"worker-smoke","version":"1.0.0","dependencies":{"demo-fixture":"1.0.0"}}"#;
    let archive = tgz(&[
        ("package/package.json", br#"{"name":"demo-fixture","version":"1.0.0","scripts":{"preinstall":"node -e process.exit(99)"}}"#, 0o644),
        ("package/bin/run-fixture", b"#!/bin/sh\nexit 99\n", 0o755),
    ])?;
    let integrity = format!("sha512-{}", STANDARD.encode(Sha512::digest(&archive)));
    let resolved = "https://registry.npmjs.org/demo-fixture/-/demo-fixture-1.0.0.tgz";
    let package_lock = serde_json::to_vec(&serde_json::json!({
        "name": "worker-smoke",
        "version": "1.0.0",
        "lockfileVersion": 3,
        "packages": {
            "": {"name":"worker-smoke","version":"1.0.0","dependencies":{"demo-fixture":"1.0.0"}},
            "node_modules/demo-fixture": {"name":"demo-fixture","version":"1.0.0","resolved":resolved,"integrity":integrity}
        }
    })).map_err(|_| "fixture_json")?;
    let target = BuildTargetV1 {
        os: "darwin".to_owned(),
        cpu: match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            _ => return Err("unsupported_cpu"),
        }
        .to_owned(),
    };
    let source_revision = hex(&Sha256::digest(b"locked-dependency-worker-smoke-source-v1"));
    let toolchain_fingerprint = hex(&Sha256::digest(
        b"locked-dependency-worker-smoke-toolchain-v1",
    ));
    let plan = build_locked_dependency_plan(
        package_json,
        &package_lock,
        &source_revision,
        target,
        &toolchain_fingerprint,
    )
    .map_err(|_| "fixture_plan")?;
    let archive_id = plan
        .packages
        .first()
        .ok_or("fixture_plan")?
        .archive_id_sha256
        .clone();
    let archive_path = cache.join(&archive_id);
    let mut archive_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&archive_path)
        .map_err(|_| "fixture_archive")?;
    archive_file
        .write_all(&archive)
        .map_err(|_| "fixture_archive")?;
    archive_file.sync_all().map_err(|_| "fixture_archive")?;
    drop(archive_file);

    let policy_stage = new_stage(&root, "policy")?;
    let executable = std::env::current_exe().map_err(|_| "worker_executable")?;
    if supervisor::run_policy_probe(&executable, &cache, &policy_stage).map_err(|failure| {
        match failure {
            supervisor::WorkerFailure::Worker(code) => code,
            supervisor::WorkerFailure::Cancelled => "dependency_worker_cancelled",
            supervisor::WorkerFailure::TimedOut => "dependency_worker_timeout",
            supervisor::WorkerFailure::Spawn => "dependency_worker_spawn_failed",
            supervisor::WorkerFailure::Wait => "dependency_worker_wait_failed",
            supervisor::WorkerFailure::OutputLimit => "dependency_worker_output_limit",
            supervisor::WorkerFailure::ObservedFootprintLimit => {
                "dependency_worker_observed_footprint_limit"
            }
            supervisor::WorkerFailure::ResourceMonitorUnavailable => {
                "dependency_worker_resource_monitor_unavailable"
            }
            supervisor::WorkerFailure::Pipe => "dependency_worker_pipe_failed",
            supervisor::WorkerFailure::Protocol => "dependency_worker_protocol_invalid",
            supervisor::WorkerFailure::Unreaped => "dependency_worker_unreaped",
        }
    })? != (true, true)
    {
        return Err("sandbox_policy_not_enforced");
    }
    fs::remove_dir(&policy_stage).map_err(|_| "fixture_cleanup")?;

    let stage = new_stage(&root, "complete")?;
    let plan_bytes = serde_json::to_vec(&plan).map_err(|_| "fixture_plan")?;
    let not_cancelled = AtomicBool::new(false);
    let success =
        supervisor::run_materializer(&executable, &cache, &stage, &plan_bytes, &not_cancelled);
    if !success.reaped || !success.exit_status.is_some_and(|status| status.success()) {
        return Err("worker_materialization_failed");
    }
    let receipt = success
        .receipt
        .map_err(|_| "worker_materialization_failed")?;
    if success.resource_observation.sample_count == 0
        || success.resource_observation.sample_interval_milliseconds != 100
        || success.resource_observation.observed_footprint_limit_bytes != 512 * 1024 * 1024
    {
        return Err("resource_observation_missing");
    }
    println!(
        "LOCKED_DEPENDENCY_RESOURCE_OBSERVATION elapsedMs={} sampleCount={} unavailableSamples={} peakPhysicalFootprintBytes={}",
        success
            .resource_observation
            .elapsed_milliseconds
            .ok_or("elapsed_unknown")?,
        success.resource_observation.sample_count,
        success.resource_observation.unavailable_sample_count,
        success
            .resource_observation
            .peak_observed_physical_footprint_bytes
            .ok_or("footprint_unknown")?,
    );
    if fs::read(stage.join("node_modules/demo-fixture/bin/run-fixture"))
        .map_err(|_| "materialized_file_missing")?
        != b"#!/bin/sh\nexit 99\n"
    {
        return Err("materialized_file_mismatch");
    }
    if receipt.package_count != 1
        || receipt.file_count != 2
        || receipt.archive_bytes != archive.len() as u64
    {
        return Err("worker_receipt_mismatch");
    }
    if stage
        .join(".atools-dependency-set-v1.json")
        .metadata()
        .is_err()
    {
        return Err("manifest_missing");
    }
    if fs::read(cache.join(&archive_id)).map_err(|_| "cache_archive_missing")? != archive {
        return Err("cache_archive_changed");
    }
    fs::remove_dir_all(&stage).map_err(|_| "fixture_cleanup")?;

    let cancel_stage = new_stage(&root, "cancel")?;
    let cancelled_flag = AtomicBool::new(true);
    let cancelled = supervisor::run_materializer(
        &executable,
        &cache,
        &cancel_stage,
        &plan_bytes,
        &cancelled_flag,
    );
    if !matches!(cancelled.receipt, Err(supervisor::WorkerFailure::Cancelled)) || !cancelled.reaped
    {
        return Err("cancellation_not_observed");
    }
    fs::remove_dir_all(&cancel_stage).map_err(|_| "fixture_cleanup")?;

    let ignored_cancel_stage = new_stage(&root, "ignore-cancel")?;
    let full_probe_plan = vec![b'x'; 256 * 1024];
    let ignored_cancel = supervisor::run_cancel_ignoring_probe(
        &executable,
        &cache,
        &ignored_cancel_stage,
        &full_probe_plan,
    );
    if !matches!(
        ignored_cancel.receipt,
        Err(supervisor::WorkerFailure::Cancelled)
    ) || !ignored_cancel.reaped
        || !ignored_cancel
            .exit_status
            .is_some_and(|status| !status.success())
    {
        return Err("noncooperative_cancel_not_reaped");
    }
    println!(
        "LOCKED_DEPENDENCY_CANCEL_CONTROL fullPlanReceived=true childIgnoredCancel=true reaped=true"
    );
    fs::remove_dir_all(&ignored_cancel_stage).map_err(|_| "fixture_cleanup")?;

    let mut malformed_tar = tar_archive(&[("package/../escape", b"x", 0o644)]);
    malformed_tar.shrink_to_fit();
    let malicious = gzip(&malformed_tar)?;
    let bad_lock = lock_with_archive(&malicious, resolved)?;
    let bad_plan = build_locked_dependency_plan(
        package_json,
        &bad_lock,
        &source_revision,
        BuildTargetV1 {
            os: "darwin".to_owned(),
            cpu: match std::env::consts::ARCH {
                "aarch64" => "arm64",
                "x86_64" => "x64",
                _ => return Err("unsupported_cpu"),
            }
            .to_owned(),
        },
        &toolchain_fingerprint,
    )
    .map_err(|_| "malicious_plan")?;
    let bad_id = bad_plan.packages[0].archive_id_sha256.clone();
    let mut bad_archive_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(cache.join(bad_id))
        .map_err(|_| "malicious_archive")?;
    bad_archive_file
        .write_all(&malicious)
        .map_err(|_| "malicious_archive")?;
    drop(bad_archive_file);
    let bad_stage = new_stage(&root, "malicious")?;
    let bad_bytes = serde_json::to_vec(&bad_plan).map_err(|_| "malicious_plan")?;
    let no_cancel = AtomicBool::new(false);
    let rejected =
        supervisor::run_materializer(&executable, &cache, &bad_stage, &bad_bytes, &no_cancel);
    if !matches!(
        rejected.receipt,
        Err(supervisor::WorkerFailure::Worker(
            "dependency_archive_path_invalid"
        ))
    ) || !rejected.reaped
    {
        return Err("unsafe_archive_not_rejected");
    }
    if root.join("escape").exists() {
        return Err("archive_escaped_stage");
    }
    fs::remove_dir_all(&bad_stage).map_err(|_| "fixture_cleanup")?;

    let oversize_tar = tar_header_only("package/large.bin", 32 * 1024 * 1024 + 1);
    let oversize = gzip(&oversize_tar)?;
    let oversize_lock = lock_with_archive(&oversize, resolved)?;
    let oversize_plan = build_locked_dependency_plan(
        package_json,
        &oversize_lock,
        &source_revision,
        BuildTargetV1 {
            os: "darwin".to_owned(),
            cpu: match std::env::consts::ARCH {
                "aarch64" => "arm64",
                "x86_64" => "x64",
                _ => return Err("unsupported_cpu"),
            }
            .to_owned(),
        },
        &toolchain_fingerprint,
    )
    .map_err(|_| "oversize_plan")?;
    let oversized_id = oversize_plan.packages[0].archive_id_sha256.clone();
    let mut oversized_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(cache.join(oversized_id))
        .map_err(|_| "oversized_archive")?;
    oversized_file
        .write_all(&oversize)
        .map_err(|_| "oversized_archive")?;
    drop(oversized_file);
    let oversize_stage = new_stage(&root, "oversize")?;
    let oversize_bytes = serde_json::to_vec(&oversize_plan).map_err(|_| "oversize_plan")?;
    let oversize_result = supervisor::run_materializer(
        &executable,
        &cache,
        &oversize_stage,
        &oversize_bytes,
        &no_cancel,
    );
    if !matches!(
        oversize_result.receipt,
        Err(supervisor::WorkerFailure::Worker(
            "dependency_archive_limit"
        ))
    ) || !oversize_result.reaped
    {
        return Err("archive_limit_not_enforced");
    }
    fs::remove_dir_all(&oversize_stage).map_err(|_| "fixture_cleanup")?;
    fn new_stage(root: &std::path::Path, label: &str) -> Result<std::path::PathBuf, &'static str> {
        let stage = root.join(format!("stage-{label}"));
        std::fs::create_dir(&stage).map_err(|_| "stage_create")?;
        std::fs::set_permissions(&stage, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "stage_permissions")?;
        Ok(stage)
    }

    fn lock_with_archive(archive: &[u8], resolved: &str) -> Result<Vec<u8>, &'static str> {
        let integrity = format!("sha512-{}", STANDARD.encode(Sha512::digest(archive)));
        serde_json::to_vec(&serde_json::json!({
            "name":"worker-smoke","version":"1.0.0","lockfileVersion":3,
            "packages": {
                "": {"name":"worker-smoke","version":"1.0.0","dependencies":{"demo-fixture":"1.0.0"}},
                "node_modules/demo-fixture": {"name":"demo-fixture","version":"1.0.0","resolved":resolved,"integrity":integrity}
            }
        })).map_err(|_| "fixture_json")
    }

    fn tgz(entries: &[(&str, &[u8], u32)]) -> Result<Vec<u8>, &'static str> {
        gzip(&tar_archive(entries))
    }

    fn tar_archive(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let mut tar = Vec::new();
        for (path, bytes, mode) in entries {
            let header = tar_header(path, bytes.len() as u64, *mode);
            tar.extend_from_slice(&header);
            tar.extend_from_slice(bytes);
            let pad = (512 - bytes.len() % 512) % 512;
            tar.resize(tar.len() + pad, 0);
        }
        tar.resize(tar.len() + 1024, 0);
        tar
    }

    fn tar_header(path: &str, size: u64, mode: u32) -> [u8; 512] {
        let mut header = [0u8; 512];
        header[..path.len()].copy_from_slice(path.as_bytes());
        put_octal(&mut header[100..108], mode as u64);
        put_octal(&mut header[108..116], 0);
        put_octal(&mut header[116..124], 0);
        put_octal(&mut header[124..136], size);
        put_octal(&mut header[136..148], 0);
        header[148..156].fill(b' ');
        header[156] = b'0';
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        let checksum = header.iter().map(|byte| *byte as u64).sum();
        put_octal(&mut header[148..156], checksum);
        header
    }

    fn tar_header_only(path: &str, size: u64) -> Vec<u8> {
        let mut tar = tar_header(path, size, 0o644).to_vec();
        tar.resize(tar.len() + 1024, 0);
        tar
    }

    fn put_octal(field: &mut [u8], value: u64) {
        let text = format!("{:0width$o}\0", value, width = field.len() - 1);
        field.copy_from_slice(text.as_bytes());
    }

    fn gzip(bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(bytes).map_err(|_| "fixture_archive")?;
        encoder.finish().map_err(|_| "fixture_archive")
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    Ok(())
}

#[cfg(target_os = "macos")]
struct OwnedFixtureRoot(std::path::PathBuf);

#[cfg(target_os = "macos")]
impl Drop for OwnedFixtureRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
