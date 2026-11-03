// File inspection and migration policy stay separate from native registration.
// The durable filesystem adapter and explicit UI resolution are required before
// enabling legacy mutation; ordinary toggles continue to reject legacy items.
mod configuration;
#[cfg(target_os = "macos")]
mod durable;
#[cfg(target_os = "macos")]
mod durable_io;
#[cfg(target_os = "macos")]
pub(super) mod host;
#[cfg(target_os = "macos")]
mod host_paths;
#[cfg(unix)]
mod journal;
mod migration;
#[cfg(target_os = "macos")]
mod recovery;
