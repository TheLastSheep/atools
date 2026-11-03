use atools_plugin::source_build::BuildTargetV1;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const NODE_BINARY_LIMIT: u64 = 256 * 1024 * 1024;
const IO_CHUNK: usize = 64 * 1024;
const NODE_HASH_DEADLINE: Duration = Duration::from_secs(120);
pub(super) const WORKER_PROTOCOL: &str = "locked-dependency-worker-v3";

#[derive(Clone, Debug)]
pub(super) struct NodePin {
    pub bytes: u64,
    pub sha256: String,
    pub fingerprint_sha256: String,
    pub elapsed_ms: u64,
}

#[cfg(target_os = "macos")]
pub(super) fn pin_node(
    path: &Path,
    target: &BuildTargetV1,
    cancelled: &AtomicBool,
) -> Result<NodePin, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let started = Instant::now();
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| "SOURCE_DEPENDENCY_NODE_UNAVAILABLE")?;
    let before = file
        .metadata()
        .map_err(|_| "SOURCE_DEPENDENCY_NODE_UNAVAILABLE")?;
    if !before.is_file() || before.len() == 0 || before.len() > NODE_BINARY_LIMIT {
        return Err("SOURCE_DEPENDENCY_NODE_INVALID".into());
    }
    let mut digest = Sha256::new();
    let mut read = 0u64;
    let mut buffer = [0u8; IO_CHUNK];
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("SOURCE_DEPENDENCY_CANCELLED".into());
        }
        if started.elapsed() > NODE_HASH_DEADLINE {
            return Err("SOURCE_DEPENDENCY_NODE_TIMEOUT".into());
        }
        let count = file
            .read(&mut buffer)
            .map_err(|_| "SOURCE_DEPENDENCY_NODE_READ")?;
        if count == 0 {
            break;
        }
        read = read
            .checked_add(count as u64)
            .ok_or("SOURCE_DEPENDENCY_NODE_LIMIT")?;
        if read > NODE_BINARY_LIMIT || read > before.len() {
            return Err("SOURCE_DEPENDENCY_NODE_CHANGED".into());
        }
        digest.update(&buffer[..count]);
    }
    let after = file.metadata().map_err(|_| "SOURCE_DEPENDENCY_NODE_READ")?;
    if read != before.len() || !same(&before, &after) {
        return Err("SOURCE_DEPENDENCY_NODE_CHANGED".into());
    }
    let node_sha256 = hex(&digest.finalize());
    let binding = format!(
        "atools-source-dependency-toolchain-v1\n{WORKER_PROTOCOL}\n{}\n{}\n{node_sha256}",
        target.os, target.cpu
    );
    let fingerprint_sha256 = hex(&Sha256::digest(binding.as_bytes()));
    Ok(NodePin {
        bytes: read,
        sha256: node_sha256,
        fingerprint_sha256,
        elapsed_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
    })
}

#[cfg(not(target_os = "macos"))]
pub(super) fn pin_node(
    _path: &Path,
    _target: &BuildTargetV1,
    _cancelled: &AtomicBool,
) -> Result<NodePin, String> {
    Err("SOURCE_DEPENDENCY_PLATFORM_UNSUPPORTED".into())
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 15) as usize] as char);
    }
    out
}

#[cfg(unix)]
fn same(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.uid() == after.uid()
        && before.mode() == after.mode()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
}

#[cfg(not(unix))]
fn same(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    before.len() == after.len() && before.modified().ok() == after.modified().ok()
}
#[cfg(test)]
#[path = "toolchain_fingerprint_bench.rs"]
mod benchmark;
