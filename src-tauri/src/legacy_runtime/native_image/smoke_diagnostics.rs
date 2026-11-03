//! Numeric-only counters for the private native image smoke fixture.
//!
//! This module is absent from ordinary production builds. It intentionally
//! exposes no paths, content hashes, handles, or session identifiers.

use super::NativeImageEngine;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeImageSmokeSnapshot {
    /// Compressed source bytes still charged, including late source leases.
    pub(crate) global_source_bytes: usize,
    /// Bytes reserved by in-flight opens before their source is read.
    pub(crate) global_reserved_bytes: usize,
    /// Handle leases retained by active maps or late workers.
    pub(crate) handles: usize,
    /// Distinct source leases retained across tracked sessions.
    pub(crate) unique_sources: usize,
    /// Open reservations still outstanding.
    pub(crate) open_reservations: usize,
    /// Ledger records, including closed records held by late leases.
    pub(crate) session_count: usize,
    /// Whether the single-worker gate is currently held by any permit lease.
    pub(crate) worker_busy: bool,
}

impl NativeImageEngine {
    pub(crate) fn smoke_snapshot(&self) -> NativeImageSmokeSnapshot {
        let (
            global_source_bytes,
            global_reserved_bytes,
            handles,
            unique_sources,
            open_reservations,
            session_count,
        ) = self.ledger.smoke_counts();
        NativeImageSmokeSnapshot {
            global_source_bytes,
            global_reserved_bytes,
            handles,
            unique_sources,
            open_reservations,
            session_count,
            worker_busy: self.gate.is_busy(),
        }
    }
}
