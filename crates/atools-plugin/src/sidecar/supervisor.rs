use super::process::SharedCleanupError;
use super::startup_diagnostics::{
    StartupFailureDiagnostic, StartupFailureKind, StartupProcessStatus, StartupTrace,
};
use super::{node_children::NodeChildrenLaunch, NodeRuntimeSelector};
use atools_core::{PluginManifest, PluginRuntimeKind, PluginRuntimeTransport};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, watch, OwnedSemaphorePermit, RwLock};

#[path = "supervisor/start_process.rs"]
mod start_process;

const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SidecarError {
    #[error("plugin runtime entry is invalid: {0}")]
    InvalidEntry(String),
    #[error("failed to spawn plugin sidecar: {0}")]
    Spawn(String),
    #[error("plugin sidecar is not running")]
    NotRunning,
    #[error("plugin sidecar request timed out after {0} ms")]
    Timeout(u64),
    #[error("plugin sidecar request was cancelled")]
    Cancelled,
    #[error("plugin sidecar crashed: {0}")]
    Crashed(String),
    #[error("plugin sidecar protocol error: {0}")]
    Protocol(String),
    #[error("plugin sidecar returned JSON-RPC error {code}: {message}")]
    Remote { code: i64, message: String },
    #[error("Node sidecar startup failed during {failure:?}")]
    Startup {
        failure: StartupFailureKind,
        diagnostic: StartupFailureDiagnostic,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarStatus {
    Starting,
    Running,
    Stopped,
    Crashed,
}

#[derive(Debug, Clone)]
pub struct SidecarLaunchSpec {
    pub plugin_id: String,
    pub plugin_dir: PathBuf,
    pub entry: PathBuf,
    pub runtime: PluginRuntimeKind,
    pub transport: PluginRuntimeTransport,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub startup_timeout: Duration,
    pub request_timeout: Duration,
}

impl SidecarLaunchSpec {
    pub fn from_manifest(
        plugin_id: impl Into<String>,
        plugin_dir: &Path,
        manifest: &PluginManifest,
    ) -> Result<Self, SidecarError> {
        manifest
            .validate_runtime_contract()
            .map_err(SidecarError::InvalidEntry)?;
        let runtime = manifest.effective_runtime_kind();
        if !matches!(
            runtime,
            PluginRuntimeKind::Rust | PluginRuntimeKind::Node | PluginRuntimeKind::Wasm
        ) {
            return Err(SidecarError::InvalidEntry(
                "sidecar runtime must be rust, node, or wasm".to_string(),
            ));
        }
        let transport = manifest.effective_runtime_transport();
        if !matches!(
            transport,
            PluginRuntimeTransport::JsonRpcStdio | PluginRuntimeTransport::McpStdio
        ) {
            return Err(SidecarError::InvalidEntry(
                "sidecar transport must be json_rpc_stdio or mcp_stdio".to_string(),
            ));
        }
        let root = plugin_dir
            .canonicalize()
            .map_err(|error| SidecarError::InvalidEntry(error.to_string()))?;
        let relative_entry = manifest
            .effective_runtime_entry()
            .ok_or_else(|| SidecarError::InvalidEntry("missing runtime entry".to_string()))?;
        let relative_entry = Path::new(relative_entry);
        if relative_entry.is_absolute() {
            return Err(SidecarError::InvalidEntry(
                "runtime entry must be relative to the plugin directory".to_string(),
            ));
        }
        let entry = root
            .join(relative_entry)
            .canonicalize()
            .map_err(|error| SidecarError::InvalidEntry(error.to_string()))?;
        if !entry.starts_with(&root) || !entry.is_file() {
            return Err(SidecarError::InvalidEntry(
                "runtime entry escapes the plugin directory or is not a file".to_string(),
            ));
        }
        Ok(Self {
            plugin_id: plugin_id.into(),
            plugin_dir: root,
            entry,
            runtime,
            transport,
            args: Vec::new(),
            env: BTreeMap::new(),
            startup_timeout: DEFAULT_STARTUP_TIMEOUT,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
        })
    }
}

pub(super) enum ProcessCommand {
    Request {
        id: u64,
        method: String,
        params: Value,
        response: oneshot::Sender<Result<Value, SidecarError>>,
    },
    Notify {
        method: String,
        params: Value,
        response: oneshot::Sender<Result<(), SidecarError>>,
    },
    Cancel {
        id: u64,
    },
    Shutdown {
        response: oneshot::Sender<Result<(), SidecarError>>,
    },
}

pub struct SidecarProcess {
    plugin_id: String,
    transport: PluginRuntimeTransport,
    request_timeout: Duration,
    next_id: AtomicU64,
    pub(super) command_tx: mpsc::Sender<ProcessCommand>,
    status_rx: watch::Receiver<SidecarStatus>,
    stderr: Arc<RwLock<VecDeque<String>>>,
    mcp_initialize_result: tokio::sync::Mutex<Option<Value>>,
    cleanup_error: SharedCleanupError,
    pub(crate) owned_pid: Option<u32>,
}

impl SidecarProcess {
    pub async fn spawn(spec: SidecarLaunchSpec) -> Result<Arc<Self>, SidecarError> {
        Self::spawn_with_node_runtime_selector(
            spec,
            NodeRuntimeSelector::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
    }

    pub(crate) async fn spawn_with_node_runtime_selector(
        spec: SidecarLaunchSpec,
        selector: NodeRuntimeSelector,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Arc<Self>, SidecarError> {
        if spec.startup_timeout.is_zero() {
            return Err(SidecarError::Timeout(0));
        }
        let command = spec
            .command_with_node_selector(&selector, cancelled)
            .await?;
        // Runtime preparation has its own bounded selector phase. The startup
        // budget begins when the selected executable is actually spawned.
        Self::spawn_with_command(spec, command).await
    }

    pub(crate) async fn spawn_with_command(
        spec: SidecarLaunchSpec,
        command: Command,
    ) -> Result<Arc<Self>, SidecarError> {
        Self::spawn_with_command_and_diagnostics(spec, command, None).await
    }

    pub(crate) async fn spawn_with_command_and_diagnostics(
        spec: SidecarLaunchSpec,
        command: Command,
        diagnostics: Option<Arc<StartupTrace>>,
    ) -> Result<Arc<Self>, SidecarError> {
        Self::spawn_with_command_and_diagnostics_and_permit(spec, command, diagnostics, None).await
    }

    pub(crate) async fn spawn_with_command_and_diagnostics_and_permit(
        spec: SidecarLaunchSpec,
        command: Command,
        diagnostics: Option<Arc<StartupTrace>>,
        permit: Option<OwnedSemaphorePermit>,
    ) -> Result<Arc<Self>, SidecarError> {
        start_process::spawn(spec, command, diagnostics, permit, None).await
    }

    pub(crate) async fn spawn_with_node_children_launch(
        spec: SidecarLaunchSpec,
        command: Command,
        diagnostics: Option<Arc<StartupTrace>>,
        permit: Option<OwnedSemaphorePermit>,
        node_children_launch: Option<NodeChildrenLaunch>,
    ) -> Result<Arc<Self>, SidecarError> {
        start_process::spawn(spec, command, diagnostics, permit, node_children_launch).await
    }

    async fn wait_until_running(&self, timeout: Duration) -> Result<(), SidecarError> {
        let mut status = self.status_rx.clone();
        tokio::time::timeout(timeout, async move {
            loop {
                let current = *status.borrow();
                match current {
                    SidecarStatus::Running => return Ok(()),
                    SidecarStatus::Crashed => {
                        return Err(SidecarError::Crashed(
                            "process exited during startup".to_string(),
                        ))
                    }
                    SidecarStatus::Stopped => return Err(SidecarError::NotRunning),
                    SidecarStatus::Starting => status
                        .changed()
                        .await
                        .map_err(|_| SidecarError::NotRunning)?,
                }
            }
        })
        .await
        .map_err(|_| SidecarError::Timeout(timeout.as_millis() as u64))?
    }

    pub(crate) fn startup_status(&self) -> StartupProcessStatus {
        match self.status() {
            SidecarStatus::Starting => StartupProcessStatus::Starting,
            SidecarStatus::Running => StartupProcessStatus::Running,
            SidecarStatus::Stopped => StartupProcessStatus::Stopped,
            SidecarStatus::Crashed => StartupProcessStatus::Crashed,
        }
    }

    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    pub fn transport(&self) -> PluginRuntimeTransport {
        self.transport
    }

    pub fn status(&self) -> SidecarStatus {
        *self.status_rx.borrow()
    }

    fn terminal_shutdown_result(&self) -> Result<(), SidecarError> {
        // Snapshot terminal status first: the process loop records cleanup errors
        // before publishing Stopped/Crashed, so checking sticky state afterward
        // cannot miss a concurrent failure paired with this terminal snapshot.
        let status = self.status();
        if let Some(error) = self.cleanup_error.get() {
            return Err(error);
        }
        if matches!(status, SidecarStatus::Stopped | SidecarStatus::Crashed) {
            Ok(())
        } else {
            Err(SidecarError::NotRunning)
        }
    }

    #[cfg(test)]
    pub(super) fn status_receiver_for_test(&self) -> watch::Receiver<SidecarStatus> {
        self.status_rx.clone()
    }

    pub async fn stderr_tail(&self) -> Vec<String> {
        self.stderr.read().await.iter().cloned().collect()
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, SidecarError> {
        self.request_with_timeout(method, params, self.request_timeout)
            .await
    }

    pub async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, SidecarError> {
        if self.status() != SidecarStatus::Running {
            return Err(SidecarError::NotRunning);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (response_tx, response_rx) = oneshot::channel();
        self.command_tx
            .send(ProcessCommand::Request {
                id,
                method: method.to_string(),
                params,
                response: response_tx,
            })
            .await
            .map_err(|_| SidecarError::NotRunning)?;
        match tokio::time::timeout(timeout, response_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(SidecarError::NotRunning),
            Err(_) => {
                let _ = self.command_tx.send(ProcessCommand::Cancel { id }).await;
                Err(SidecarError::Timeout(timeout.as_millis() as u64))
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), SidecarError> {
        let (response_tx, response_rx) = oneshot::channel();
        self.command_tx
            .send(ProcessCommand::Notify {
                method: method.to_string(),
                params,
                response: response_tx,
            })
            .await
            .map_err(|_| SidecarError::NotRunning)?;
        response_rx.await.map_err(|_| SidecarError::NotRunning)?
    }

    pub(crate) async fn initialize_mcp(&self, params: Value) -> Result<Value, SidecarError> {
        let mut initialized = self.mcp_initialize_result.lock().await;
        if let Some(result) = initialized.as_ref() {
            return Ok(result.clone());
        }
        let result = self.request("initialize", params).await?;
        self.notify("notifications/initialized", json!({})).await?;
        *initialized = Some(result.clone());
        Ok(result)
    }

    pub async fn shutdown(&self) -> Result<(), SidecarError> {
        if matches!(
            self.status(),
            SidecarStatus::Stopped | SidecarStatus::Crashed
        ) {
            return self.terminal_shutdown_result();
        }
        let (response_tx, response_rx) = oneshot::channel();
        if self
            .command_tx
            .send(ProcessCommand::Shutdown {
                response: response_tx,
            })
            .await
            .is_err()
        {
            return self.terminal_shutdown_result();
        }
        match response_rx.await {
            Ok(result) => result,
            Err(_) => self.terminal_shutdown_result(),
        }
    }
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        let (response, _) = oneshot::channel();
        let _ = self
            .command_tx
            .try_send(ProcessCommand::Shutdown { response });
    }
}
