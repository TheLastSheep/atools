use super::protocol::validate_private_directory;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::time::Duration;

pub const RAW_LOG_BYTES: usize = 256 * 1024;
pub const ENCODED_LOG_BYTES: usize = 448 * 1024;
const FRAME_PREFIX: &str = "AToolsNativeTargetLogFrame ";
const READY_PREFIX: &str = "AToolsNativeStdioReady ";
const READ_BUFFER_BYTES: usize = 4096;
const ACTIVE_POLL_INTERVAL: Duration = Duration::from_millis(20);

pub fn create_private_fifo(control_dir: &Path, run_id: &str) -> Result<PathBuf, String> {
    validate_private_directory(control_dir)?;
    let path = control_dir.join(format!("stdio-{run_id}.fifo"));
    let path_c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| "invalid FIFO path")?;
    // SAFETY: path is a private, run-bound child of the validated control directory.
    let result = unsafe { libc::mkfifo(path_c.as_ptr(), 0o600) };
    if result != 0 {
        return Err(format!(
            "create private stdio FIFO: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(path)
}

pub fn route_process_stdio(path: &Path, run_id: &str) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("inspect stdio FIFO: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_fifo()
        || metadata.uid() != unsafe { libc::getuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err("stdio route must be an owned, mode-0600 FIFO".into());
    }
    let expected_name = format!("stdio-{run_id}.fifo");
    let parent = path.parent().ok_or("stdio route has no private parent")?;
    super::protocol::validate_private_directory(parent)?;
    if path.file_name().and_then(|value| value.to_str()) != Some(expected_name.as_str())
        || parent.file_name().and_then(|value| value.to_str())
            != Some(format!("launchservices-{run_id}").as_str())
    {
        return Err("stdio route path is not bound to this exact run id".into());
    }
    let path_c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| "invalid stdio FIFO path")?;
    // A nonblocking writer open fails with ENXIO until the observer's reader is ready.
    let fd = unsafe {
        libc::open(
            path_c.as_ptr(),
            libc::O_WRONLY | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(format!(
            "open stdio FIFO writer (reader must be ready): {}",
            std::io::Error::last_os_error()
        ));
    }
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) } < 0 {
        let error = std::io::Error::last_os_error();
        unsafe {
            libc::close(fd);
        }
        return Err(format!("restore blocking fixture FIFO writer: {error}"));
    }
    for target in [libc::STDOUT_FILENO, libc::STDERR_FILENO] {
        if unsafe { libc::dup2(fd, target) } < 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                libc::close(fd);
            }
            return Err(format!("route fixture stdio: {error}"));
        }
    }
    unsafe {
        libc::close(fd);
    }
    Ok(())
}

pub fn emit_target_environment_observation(run_id: &str) -> Result<(), String> {
    let encoded = std::env::var("ATOOLS_NATIVE_REQUESTED_ENV_KEYS")
        .map_err(|_| "LaunchServices requested environment key contract is missing")?;
    if encoded.len() > 16 * 1024 {
        return Err("requested environment key contract exceeds its size cap".into());
    }
    let requested: Vec<String> = serde_json::from_str(&encoded)
        .map_err(|_| "requested environment key contract is malformed")?;
    if requested.is_empty() || requested.len() > 128 || requested.iter().any(String::is_empty) {
        return Err("requested environment key contract is outside the fixed range".into());
    }
    let requested_bytes: BTreeSet<Vec<u8>> = requested
        .iter()
        .map(|key| key.as_bytes().to_vec())
        .collect();
    if requested_bytes.len() != requested.len() {
        return Err("requested environment key contract contains duplicates".into());
    }
    let observed: BTreeSet<Vec<u8>> = std::env::vars_os()
        .map(|(key, _)| key.as_os_str().as_bytes().to_vec())
        .collect();
    let missing = requested_bytes.difference(&observed).count();
    let mut extra: Vec<_> = observed.difference(&requested_bytes).cloned().collect();
    extra.sort();
    let mut digest = Sha256::new();
    for key in &extra {
        digest.update((key.len() as u64).to_be_bytes());
        digest.update(key);
    }
    let observation = serde_json::json!({
        "runId": run_id,
        "requestedEnvironmentKeysComplete": missing == 0,
        "requestedEnvironmentKeyCount": requested.len(),
        "missingRequestedEnvironmentKeyCount": missing,
        "additionalEnvironmentKeyCount": extra.len(),
        "additionalEnvironmentKeyNamesSha256": format!("{:x}", digest.finalize()),
        "ambientEnvironmentInheritance": "unknown",
        "systemMayAddVariables": true,
        "environmentValuesLogged": false,
        "additionalEnvironmentNamesLogged": false
    });
    let mut stdout = std::io::stdout().lock();
    writeln!(
        stdout,
        "AToolsNativeLaunchServicesEnvironment {observation}"
    )
    .and_then(|()| stdout.flush())
    .map_err(|error| format!("write target environment observation: {error}"))
}

/// Opens the FIFO before signaling readiness, then forwards target bytes only as
/// typed, bounded base64 frames. `ready` is acknowledged only after the control
/// line has reached observer stdout, so the caller can safely proceed to AppKit.
pub fn drain_logs(
    path: &Path,
    run_id: &str,
    raw_limit: usize,
    encoded_limit: usize,
    stop: &AtomicBool,
    ready: SyncSender<Result<(), String>>,
) -> Result<Drain, String> {
    let path_c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| "invalid stdio FIFO path")?;
    let fd = unsafe {
        libc::open(
            path_c.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        let error = format!(
            "open stdio FIFO reader: {}",
            std::io::Error::last_os_error()
        );
        let _ = ready.send(Err(error.clone()));
        return Err(error);
    }
    // SAFETY: the descriptor was created by open above and is uniquely owned here.
    let mut fifo = unsafe { fs::File::from_raw_fd(fd) };
    if let Err(error) = write_observer_line(READY_PREFIX, &serde_json::json!({ "runId": run_id })) {
        let _ = ready.send(Err(error.clone()));
        return Err(error);
    }
    let _ = ready.send(Ok(()));

    let mut drain = Drain::default();
    let mut sequence = 0u64;
    let mut buffer = [0u8; READ_BUFFER_BYTES];
    loop {
        if stop.load(Ordering::Acquire) {
            if let Err(error) = drain_buffered_tail(
                &mut fifo,
                run_id,
                raw_limit,
                encoded_limit,
                &mut drain,
                &mut sequence,
                &mut buffer,
            ) {
                drain.error = Some(error);
            }
            drain.complete = !drain.overflow && drain.error.is_none();
            return Ok(drain);
        }
        match fifo.read(&mut buffer) {
            Ok(0) => std::thread::sleep(ACTIVE_POLL_INTERVAL),
            Ok(count) => {
                match forward_bytes(
                    &buffer[..count],
                    run_id,
                    raw_limit,
                    encoded_limit,
                    &mut drain,
                    &mut sequence,
                ) {
                    Ok(true) => {}
                    Ok(false) => return Ok(drain),
                    Err(error) => {
                        drain.error = Some(error);
                        return Ok(drain);
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACTIVE_POLL_INTERVAL)
            }
            Err(error) => {
                drain.error = Some(format!("read fixture stdio FIFO: {error}"));
                return Ok(drain);
            }
        }
    }
}

#[derive(Debug, Default)]
pub struct Drain {
    pub bytes: u64,
    pub encoded_bytes: u64,
    pub frame_count: u64,
    pub overflow: bool,
    pub complete: bool,
    pub error: Option<String>,
}

fn drain_buffered_tail(
    fifo: &mut fs::File,
    run_id: &str,
    raw_limit: usize,
    encoded_limit: usize,
    drain: &mut Drain,
    sequence: &mut u64,
    buffer: &mut [u8; READ_BUFFER_BYTES],
) -> Result<(), String> {
    loop {
        match fifo.read(buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => {
                match forward_bytes(
                    &buffer[..count],
                    run_id,
                    raw_limit,
                    encoded_limit,
                    drain,
                    sequence,
                ) {
                    Ok(true) => {}
                    Ok(false) => return Ok(()),
                    Err(error) => return Err(error),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) => return Err(format!("drain fixture stdio FIFO tail: {error}")),
        }
    }
}

fn forward_bytes(
    bytes: &[u8],
    run_id: &str,
    raw_limit: usize,
    encoded_limit: usize,
    drain: &mut Drain,
    sequence: &mut u64,
) -> Result<bool, String> {
    let remaining_raw = raw_limit.saturating_sub(drain.bytes as usize);
    let accepted = bytes.len().min(remaining_raw);
    if accepted > 0 {
        let line = encode_log_frame(run_id, *sequence, &bytes[..accepted])?;
        let line_bytes = line.len() + 1;
        if line_bytes > encoded_limit.saturating_sub(drain.encoded_bytes as usize) {
            drain.overflow = true;
            return Ok(false);
        }
        write_stdout_frame(&line)?;
        drain.bytes += accepted as u64;
        drain.encoded_bytes += line_bytes as u64;
        drain.frame_count += 1;
        *sequence += 1;
    }
    if accepted < bytes.len() {
        drain.overflow = true;
        return Ok(false);
    }
    Ok(true)
}

fn encode_log_frame(run_id: &str, sequence: u64, bytes: &[u8]) -> Result<String, String> {
    let frame = serde_json::json!({
        "runId": run_id,
        "sequence": sequence,
        "byteLength": bytes.len(),
        "bytesBase64": BASE64_STANDARD.encode(bytes),
    });
    serde_json::to_string(&frame)
        .map(|json| format!("{FRAME_PREFIX}{json}"))
        .map_err(|error| format!("encode fixture log frame: {error}"))
}

fn write_stdout_frame(line: &str) -> Result<(), String> {
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(line.as_bytes())
        .and_then(|()| stdout.write_all(b"\n"))
        .and_then(|()| stdout.flush())
        .map_err(|error| format!("write fixture log frame: {error}"))
}

fn write_observer_line(prefix: &str, payload: &serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string(payload)
        .map_err(|error| format!("encode observer stdio control: {error}"))?;
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{prefix}{json}")
        .and_then(|()| stdout.flush())
        .map_err(|error| format!("write observer stdio control: {error}"))
}

#[cfg(test)]
mod tests {
    use super::encode_log_frame;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    #[test]
    fn target_logs_are_encoded_as_typed_run_bound_frames() {
        let raw = b"line one\nline two\n";
        let frame = encode_log_frame("run-7", 3, raw).expect("frame encodes");
        assert!(frame.starts_with("AToolsNativeTargetLogFrame "));
        let payload: serde_json::Value =
            serde_json::from_str(frame.strip_prefix("AToolsNativeTargetLogFrame ").unwrap())
                .unwrap();
        assert_eq!(payload["runId"], "run-7");
        assert_eq!(payload["sequence"], 3);
        assert_eq!(payload["byteLength"], raw.len());
        assert_eq!(
            STANDARD
                .decode(payload["bytesBase64"].as_str().unwrap())
                .unwrap(),
            raw
        );
    }
}
