//! Experimental native observations, with no navigation or authorization policy.
//!
//! Frame snapshots are copied values. WKFrameInfo is transient and is never used
//! as frame identity. Callers must not persist these URLs in execution history.
use std::sync::Arc;
use tauri::WebviewWindow;

#[cfg(all(target_os = "macos", feature = "legacy-node-smoke"))]
mod contract;
#[cfg(all(target_os = "macos", feature = "legacy-node-smoke"))]
mod delegate;
#[cfg(all(target_os = "macos", feature = "legacy-node-smoke"))]
mod installation;
#[cfg(all(target_os = "macos", feature = "legacy-node-smoke"))]
mod snapshot;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SecurityOrigin {
    pub(crate) scheme: String,
    pub(crate) host: String,
    /// Zero and the scheme's default port are represented by None.
    pub(crate) port: Option<u16>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FrameSnapshot {
    pub(crate) request_url: Option<String>,
    pub(crate) request_url_oversized: bool,
    /// Extracted independently so an oversized URL still identifies its origin.
    pub(crate) request_origin: Option<SecurityOrigin>,
    /// None means native origin data was invalid, never a matching origin.
    pub(crate) security_origin: Option<SecurityOrigin>,
    pub(crate) is_main_frame: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FrameNavigation {
    pub(crate) requested_url: Option<String>,
    pub(crate) source_frame: Option<FrameSnapshot>,
    pub(crate) target_frame: Option<FrameSnapshot>,
}

pub(super) type Observer = Arc<dyn Fn(FrameNavigation) + Send + Sync>;

/// Await installation before preparing a document. Repeated calls retain the
/// first observer for the same native instance and do not wrap its delegate.
pub(crate) async fn ensure(window: &WebviewWindow, observer: Observer) -> Result<(), String> {
    #[cfg(all(target_os = "macos", feature = "legacy-node-smoke"))]
    {
        installation::ensure(window, observer).await
    }
    #[cfg(not(all(target_os = "macos", feature = "legacy-node-smoke")))]
    {
        let _ = (window, observer);
        Err("Native navigation observation is unsupported outside the macOS smoke feature".into())
    }
}
