//! Persistent Node module primitives for an explicitly authorized legacy plugin.
//!
//! This is a full Node process, not a filesystem sandbox. The host must authorize
//! the plugin before starting it and bind subsequent requests to that session.
//! The preload or page remains in the isolated UI frame and is never evaluated here.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use atools_core::{PluginRuntimeKind, PluginRuntimeTransport};
use serde_json::{json, Value};
use tokio::sync::OwnedSemaphorePermit;

use crate::sidecar::node_children::NodeChildrenLaunch;
use crate::sidecar::startup_diagnostics::{
    classify_initialize_startup_failure, StartupDiagnosticSnapshot, StartupFailureDiagnostic,
    StartupFailureKind, StartupPhase, StartupTrace,
};
use crate::sidecar::{
    NodeRuntimeSelector, SidecarError, SidecarLaunchSpec, SidecarProcess, SidecarStatus,
};
use std::sync::atomic::AtomicBool;

mod native_image_source;
pub use native_image_source::NativeImageSource;
use native_image_source::MAX_SOURCE_BYTES as MAX_NATIVE_IMAGE_SOURCE_BYTES;

const BOOTSTRAP: &str = concat!(
    include_str!("codec.cjs"),
    "\n",
    include_str!("bounded_png_path.cjs"),
    "\n",
    include_str!("bounded_native_image_path.cjs"),
    "\n",
    include_str!("managed_child_transport.cjs"),
    "\n",
    include_str!("managed_child_streams.cjs"),
    "\n",
    include_str!("managed_children.cjs"),
    "\n",
    include_str!("bootstrap.cjs")
);
const STARTUP_TIMEOUT: Duration = Duration::from_millis(1500);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_NATIVE_IMAGE_PATH_BYTES: usize = 8192;

pub struct LegacyNodeSession {
    process: Arc<SidecarProcess>,
    startup_snapshot: Option<StartupDiagnosticSnapshot>,
}

impl LegacyNodeSession {
    pub async fn start(
        plugin_id: impl Into<String>,
        plugin_dir: &Path,
        entry_path: &Path,
    ) -> Result<Self, SidecarError> {
        Self::start_with_node_runtime_selector(
            plugin_id,
            plugin_dir,
            entry_path,
            NodeRuntimeSelector::default(),
        )
        .await
    }

    /// Start using a host-provided selector for the Node runtime.
    pub async fn start_with_node_runtime_selector(
        plugin_id: impl Into<String>,
        plugin_dir: &Path,
        entry_path: &Path,
        selector: NodeRuntimeSelector,
    ) -> Result<Self, SidecarError> {
        Self::start_with_node_runtime_selector_and_cancellation(
            plugin_id,
            plugin_dir,
            entry_path,
            selector,
            Arc::new(AtomicBool::new(false)),
        )
        .await
    }

    /// Start with the caller's cancellation flag for bounded runtime preparation.
    pub async fn start_with_node_runtime_selector_and_cancellation(
        plugin_id: impl Into<String>,
        plugin_dir: &Path,
        entry_path: &Path,
        selector: NodeRuntimeSelector,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Self, SidecarError> {
        Self::start_inner(
            plugin_id.into(),
            plugin_dir,
            entry_path,
            None,
            selector,
            cancelled,
            None,
        )
        .await
    }

    /// Start while holding a host-owned process budget slot until the child is reaped.
    pub async fn start_with_permit(
        plugin_id: impl Into<String>,
        plugin_dir: &Path,
        entry_path: &Path,
        selector: NodeRuntimeSelector,
        cancelled: Arc<AtomicBool>,
        permit: OwnedSemaphorePermit,
    ) -> Result<Self, SidecarError> {
        Self::start_inner(
            plugin_id.into(),
            plugin_dir,
            entry_path,
            None,
            selector,
            cancelled,
            Some(permit),
        )
        .await
    }

    #[cfg(feature = "native-smoke")]
    pub async fn start_with_diagnostics(
        plugin_id: impl Into<String>,
        plugin_dir: &Path,
        entry_path: &Path,
        authorized_fixture: bool,
    ) -> Result<Self, SidecarError> {
        if !authorized_fixture {
            return Err(SidecarError::InvalidEntry(
                "startup diagnostics require an authorized native fixture".into(),
            ));
        }
        Self::start_with_diagnostics_and_node_runtime_selector_and_cancellation(
            plugin_id,
            plugin_dir,
            entry_path,
            authorized_fixture,
            NodeRuntimeSelector::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
    }

    #[cfg(feature = "native-smoke")]
    pub async fn start_with_diagnostics_and_node_runtime_selector(
        plugin_id: impl Into<String>,
        plugin_dir: &Path,
        entry_path: &Path,
        authorized_fixture: bool,
        selector: NodeRuntimeSelector,
    ) -> Result<Self, SidecarError> {
        Self::start_with_diagnostics_and_node_runtime_selector_and_cancellation(
            plugin_id,
            plugin_dir,
            entry_path,
            authorized_fixture,
            selector,
            Arc::new(AtomicBool::new(false)),
        )
        .await
    }

    #[cfg(feature = "native-smoke")]
    pub async fn start_with_diagnostics_and_node_runtime_selector_and_cancellation(
        plugin_id: impl Into<String>,
        plugin_dir: &Path,
        entry_path: &Path,
        authorized_fixture: bool,
        selector: NodeRuntimeSelector,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Self, SidecarError> {
        if !authorized_fixture {
            return Err(SidecarError::InvalidEntry(
                "startup diagnostics require an authorized native fixture".into(),
            ));
        }
        Self::start_inner(
            plugin_id.into(),
            plugin_dir,
            entry_path,
            Some(Arc::new(StartupTrace::new())),
            selector,
            cancelled,
            None,
        )
        .await
    }

    #[cfg(feature = "native-smoke")]
    pub async fn start_with_diagnostics_and_permit(
        plugin_id: impl Into<String>,
        plugin_dir: &Path,
        entry_path: &Path,
        authorized_fixture: bool,
        selector: NodeRuntimeSelector,
        cancelled: Arc<AtomicBool>,
        permit: OwnedSemaphorePermit,
    ) -> Result<Self, SidecarError> {
        if !authorized_fixture {
            return Err(SidecarError::InvalidEntry(
                "startup diagnostics require an authorized native fixture".into(),
            ));
        }
        Self::start_inner(
            plugin_id.into(),
            plugin_dir,
            entry_path,
            Some(Arc::new(StartupTrace::new())),
            selector,
            cancelled,
            Some(permit),
        )
        .await
    }

    async fn start_inner(
        plugin_id: String,
        plugin_dir: &Path,
        entry_path: &Path,
        diagnostics: Option<Arc<StartupTrace>>,
        selector: NodeRuntimeSelector,
        cancelled: Arc<AtomicBool>,
        permit: Option<OwnedSemaphorePermit>,
    ) -> Result<Self, SidecarError> {
        let root = plugin_dir
            .canonicalize()
            .map_err(|error| SidecarError::InvalidEntry(error.to_string()))?;
        let requested = if entry_path.is_absolute() {
            entry_path.to_path_buf()
        } else {
            root.join(entry_path)
        };
        let entry = requested
            .canonicalize()
            .map_err(|error| SidecarError::InvalidEntry(error.to_string()))?;
        if !entry.starts_with(&root) || !entry.is_file() {
            return Err(SidecarError::InvalidEntry(
                "module resolution entry escapes the plugin root or is not a file".into(),
            ));
        }
        let spec = SidecarLaunchSpec {
            plugin_id,
            plugin_dir: root,
            entry,
            runtime: PluginRuntimeKind::Node,
            transport: PluginRuntimeTransport::JsonRpcStdio,
            args: Vec::new(),
            env: BTreeMap::new(),
            startup_timeout: STARTUP_TIMEOUT,
            request_timeout: REQUEST_TIMEOUT,
        };
        if let Some(trace) = &diagnostics {
            trace.record(StartupPhase::NodeResolveStarted, None, None);
        }
        let command_result = spec
            .node_bootstrap_command_with_diagnostics(
                BOOTSTRAP,
                diagnostics.as_deref(),
                &selector,
                cancelled,
            )
            .await;
        let mut command = match command_result {
            Ok(command) => {
                if let Some(trace) = &diagnostics {
                    trace.record(StartupPhase::NodeResolved, None, None);
                }
                command
            }
            Err(error) => {
                if let Some(trace) = diagnostics {
                    trace.record(StartupPhase::NodeResolveFailed, None, None);
                    trace.seal();
                    let snapshot = trace.snapshot(
                        None,
                        crate::sidecar::StartupProcessStatus::Unavailable,
                        false,
                    );
                    return Err(SidecarError::Startup {
                        failure: StartupFailureKind::NodeResolve,
                        diagnostic: StartupFailureDiagnostic {
                            schema_version: 1,
                            failure: StartupFailureKind::NodeResolve,
                            snapshot,
                        },
                    });
                }
                return Err(error);
            }
        };
        let node_children_launch = match NodeChildrenLaunch::prepare(&mut command) {
            Ok(launch) => launch,
            Err(error) => {
                if let Some(trace) = diagnostics.as_ref() {
                    trace.seal();
                    let snapshot = trace.snapshot(
                        None,
                        crate::sidecar::StartupProcessStatus::Unavailable,
                        false,
                    );
                    return Err(SidecarError::Startup {
                        failure: StartupFailureKind::NodeSpawn,
                        diagnostic: StartupFailureDiagnostic {
                            schema_version: 1,
                            failure: StartupFailureKind::NodeSpawn,
                            snapshot,
                        },
                    });
                }
                return Err(error);
            }
        };
        let process = SidecarProcess::spawn_with_node_children_launch(
            spec,
            command,
            diagnostics.clone(),
            permit,
            node_children_launch,
        )
        .await?;
        let mut session = Self {
            process,
            startup_snapshot: None,
        };
        let initialize_result = session
            .process
            .request_with_timeout("initialize", json!({}), STARTUP_TIMEOUT)
            .await;
        if let Err(error) = &initialize_result {
            if let Some(trace) = diagnostics {
                let status_before_cleanup = session.process.startup_status();
                trace.seal();
                let _ = session.stop().await;
                let failure =
                    classify_initialize_startup_failure(error, &trace, status_before_cleanup);
                let snapshot =
                    trace.snapshot(session.process.owned_pid, status_before_cleanup, true);
                return Err(SidecarError::Startup {
                    failure,
                    diagnostic: StartupFailureDiagnostic {
                        schema_version: 1,
                        failure,
                        snapshot,
                    },
                });
            }
            let _ = session.stop().await;
            return Err(error.clone());
        }
        if let Some(trace) = diagnostics {
            let version = initialize_result
                .as_ref()
                .ok()
                .and_then(|value| value.get("nodeVersion"))
                .and_then(Value::as_str);
            trace.record_node_version(version);
            trace.record(StartupPhase::InitializeCompleted, None, None);
            trace.seal();
            session.startup_snapshot = Some(trace.snapshot(
                session.process.owned_pid,
                session.process.startup_status(),
                false,
            ));
        }
        Ok(session)
    }

    #[cfg(feature = "native-smoke")]
    pub fn startup_diagnostic_snapshot(&self) -> Option<StartupDiagnosticSnapshot> {
        self.startup_snapshot.clone()
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, SidecarError> {
        if !matches!(
            method,
            "require"
                | "get"
                | "set"
                | "call"
                | "construct"
                | "poll"
                | "pollPromise"
                | "pollPromises"
                | "release"
                | "readPngPath"
        ) {
            return Err(SidecarError::Protocol(format!(
                "unsupported Node primitive: {method}"
            )));
        }
        if serde_json::to_vec(
            &json!({"jsonrpc":"2.0","id":u64::MAX,"method":method,"params":params}),
        )
        .map_err(|error| SidecarError::Protocol(error.to_string()))?
        .len()
            > MAX_REQUEST_BYTES
        {
            return Err(SidecarError::Protocol("Node request exceeded 1 MiB".into()));
        }
        let result = self.process.request(method, params).await;
        if matches!(
            &result,
            Err(SidecarError::Timeout(_) | SidecarError::Crashed(_) | SidecarError::Protocol(_))
        ) {
            let _ = self.stop().await;
        }
        result
    }

    /// Read bounded source bytes through the dedicated typed Node transport.
    /// This deliberately does not extend the generic `request` method allowlist.
    pub async fn read_native_image_path(
        &self,
        path: &str,
    ) -> Result<NativeImageSource, SidecarError> {
        self.read_native_image_path_with_limit(path, MAX_NATIVE_IMAGE_SOURCE_BYTES)
            .await
    }

    /// Read bounded source bytes using the caller's pre-reserved source budget.
    /// The per-call bound can only reduce the transport's 4 MiB maximum.
    pub async fn read_native_image_path_with_limit(
        &self,
        path: &str,
        max_source_bytes: usize,
    ) -> Result<NativeImageSource, SidecarError> {
        if path.is_empty() || path.contains('\0') || path.len() > MAX_NATIVE_IMAGE_PATH_BYTES {
            return Err(SidecarError::Protocol(
                "invalid native image source path".into(),
            ));
        }
        if !(1..=MAX_NATIVE_IMAGE_SOURCE_BYTES).contains(&max_source_bytes) {
            return Err(SidecarError::Protocol(
                "invalid native image source byte limit".into(),
            ));
        }
        let params = json!({"path": path, "maxBytes": max_source_bytes});
        let request = json!({
            "jsonrpc": "2.0",
            "id": u64::MAX,
            "method": "readNativeImagePath",
            "params": params,
        });
        if serde_json::to_vec(&request)
            .map_err(|_| SidecarError::Protocol("invalid native image source request".into()))?
            .len()
            > MAX_REQUEST_BYTES
        {
            return Err(SidecarError::Protocol(
                "native image source request exceeded 1 MiB".into(),
            ));
        }

        match self.process.request("readNativeImagePath", params).await {
            Ok(value) => match native_image_source::parse_source_frame(value) {
                Ok(source) => Ok(source),
                Err(error) => {
                    let _ = self.stop().await;
                    Err(error)
                }
            },
            Err(error) => {
                if matches!(
                    &error,
                    SidecarError::Timeout(_) | SidecarError::Crashed(_) | SidecarError::Protocol(_)
                ) {
                    let _ = self.stop().await;
                }
                Err(error)
            }
        }
    }

    pub async fn stop(&self) -> Result<(), SidecarError> {
        match self.process.shutdown().await {
            Err(SidecarError::NotRunning) if self.status() != SidecarStatus::Running => Ok(()),
            result => result,
        }
    }

    pub fn status(&self) -> SidecarStatus {
        self.process.status()
    }
}
