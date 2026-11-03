//! Sandboxed, cache-only materialization of a validated npm lock plan.
//!
//! The caller creates a unique empty staging directory and passes only its
//! host-resolved path plus the app-owned read-only archive cache. This worker
//! never downloads packages, runs lifecycle scripts, or publishes into the
//! immutable dependency-set store. The parent validates the receipt and renames
//! the completed staging directory after the worker has exited.
#[cfg(target_os = "macos")]
mod archive;
#[cfg(target_os = "macos")]
mod archive_digest;
#[cfg(target_os = "macos")]
mod bootstrap;
#[cfg(target_os = "macos")]
mod limits;
#[cfg(target_os = "macos")]
mod manifest;
#[cfg(target_os = "macos")]
pub(crate) mod observation;
#[cfg(target_os = "macos")]
mod package_identity;
#[cfg(target_os = "macos")]
mod receipt;
#[cfg(target_os = "macos")]
mod sandbox_macos;
#[cfg(target_os = "macos")]
pub(crate) mod supervisor;
#[cfg(target_os = "macos")]
mod tar_format;
#[cfg(target_os = "macos")]
mod worker_io;

#[cfg(target_os = "macos")]
pub(crate) use bootstrap::run_if_requested;

#[cfg(not(target_os = "macos"))]
pub(crate) fn run_if_requested() {
    let mut arguments = std::env::args_os();
    let _ = arguments.next();
    if arguments.any(|argument| {
        argument == "--atools-locked-dependency-worker"
            || argument == "--atools-locked-dependency-policy-probe"
    }) {
        let _ = std::io::Write::write_all(
            &mut std::io::stdout(),
            b"{\"status\":\"failed\",\"code\":\"dependency_worker_platform_unsupported\"}\n",
        );
        std::process::exit(70);
    }
}
