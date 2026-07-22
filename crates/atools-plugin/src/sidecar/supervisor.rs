use atools_core::{PluginManifest, PluginRuntimeKind, PluginRuntimeTransport};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, watch, RwLock};

const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
const MAX_PROTOCOL_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_STDERR_LINES: usize = 200;

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
        if !matches!(runtime, PluginRuntimeKind::Rust | PluginRuntimeKind::Node) {
            return Err(SidecarError::InvalidEntry(
                "sidecar runtime must be rust or node".to_string(),
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

    fn command(&self) -> Command {
        let mut command = match self.runtime {
            PluginRuntimeKind::Rust => Command::new(&self.entry),
            PluginRuntimeKind::Node => {
                let mut command = Command::new(
                    std::env::var_os("ATOOLS_NODE_BINARY").unwrap_or_else(|| "node".into()),
                );
                command.arg(&self.entry);
                command
            }
            PluginRuntimeKind::Web => unreachable!("web plugins are not sidecars"),
        };
        command
            .args(&self.args)
            .current_dir(&self.plugin_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env_clear();
        for key in ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command.env("ATOOLS_PLUGIN_ID", &self.plugin_id);
        command.env("ATOOLS_PLUGIN_DIR", &self.plugin_dir);
        for (key, value) in &self.env {
            command.env(key, value);
        }
        #[cfg(unix)]
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                let nofile = libc::rlimit {
                    rlim_cur: 256,
                    rlim_max: 256,
                };
                if libc::setrlimit(libc::RLIMIT_NOFILE, &nofile) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let core = libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                if libc::setrlimit(libc::RLIMIT_CORE, &core) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command
    }
}

enum ProcessCommand {
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
    Cancel { id: u64 },
    Shutdown {
        response: oneshot::Sender<Result<(), SidecarError>>,
    },
}

pub struct SidecarProcess {
    plugin_id: String,
    transport: PluginRuntimeTransport,
    request_timeout: Duration,
    next_id: AtomicU64,
    command_tx: mpsc::Sender<ProcessCommand>,
    status_rx: watch::Receiver<SidecarStatus>,
    stderr: Arc<RwLock<VecDeque<String>>>,
    mcp_initialize_result: tokio::sync::Mutex<Option<Value>>,
}

impl SidecarProcess {
    pub async fn spawn(spec: SidecarLaunchSpec) -> Result<Arc<Self>, SidecarError> {
        let mut child = spec
            .command()
            .spawn()
            .map_err(|error| SidecarError::Spawn(error.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| SidecarError::Spawn("stdin pipe is unavailable".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SidecarError::Spawn("stdout pipe is unavailable".to_string()))?;
        let stderr_pipe = child
            .stderr
            .take()
            .ok_or_else(|| SidecarError::Spawn("stderr pipe is unavailable".to_string()))?;
        let (command_tx, command_rx) = mpsc::channel(128);
        let (status_tx, status_rx) = watch::channel(SidecarStatus::Starting);
        let stderr = Arc::new(RwLock::new(VecDeque::new()));
        let stderr_for_task = stderr.clone();
        tokio::spawn(async move {
            capture_stderr(stderr_pipe, stderr_for_task).await;
        });
        tokio::spawn(run_process(
            child,
            stdin,
            stdout,
            command_rx,
            status_tx,
            spec.transport,
        ));
        let process = Arc::new(Self {
            plugin_id: spec.plugin_id,
            transport: spec.transport,
            request_timeout: spec.request_timeout,
            next_id: AtomicU64::new(1),
            command_tx,
            status_rx,
            stderr,
            mcp_initialize_result: tokio::sync::Mutex::new(None),
        });
        process.wait_until_running(spec.startup_timeout).await?;
        Ok(process)
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

    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    pub fn transport(&self) -> PluginRuntimeTransport {
        self.transport
    }

    pub fn status(&self) -> SidecarStatus {
        *self.status_rx.borrow()
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
        if matches!(self.status(), SidecarStatus::Stopped | SidecarStatus::Crashed) {
            return Ok(());
        }
        let (response_tx, response_rx) = oneshot::channel();
        self.command_tx
            .send(ProcessCommand::Shutdown { response: response_tx })
            .await
            .map_err(|_| SidecarError::NotRunning)?;
        response_rx.await.map_err(|_| SidecarError::NotRunning)?
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

#[derive(Default)]
pub struct SidecarSupervisor {
    processes: RwLock<HashMap<String, Arc<SidecarProcess>>>,
}

impl SidecarSupervisor {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn start(&self, spec: SidecarLaunchSpec) -> Result<Arc<SidecarProcess>, SidecarError> {
        if let Some(existing) = self.processes.read().await.get(&spec.plugin_id).cloned() {
            if existing.status() == SidecarStatus::Running {
                return Ok(existing);
            }
        }
        let plugin_id = spec.plugin_id.clone();
        let process = SidecarProcess::spawn(spec).await?;
        self.processes
            .write()
            .await
            .insert(plugin_id, process.clone());
        Ok(process)
    }

    pub async fn get(&self, plugin_id: &str) -> Option<Arc<SidecarProcess>> {
        self.processes.read().await.get(plugin_id).cloned()
    }

    pub async fn stop(&self, plugin_id: &str) -> Result<(), SidecarError> {
        let process = self.processes.write().await.remove(plugin_id);
        if let Some(process) = process {
            process.shutdown().await?;
        }
        Ok(())
    }

    pub async fn stop_all(&self) {
        let processes = std::mem::take(&mut *self.processes.write().await);
        for process in processes.into_values() {
            let _ = process.shutdown().await;
        }
    }
}

impl Drop for SidecarSupervisor {
    fn drop(&mut self) {
        if let Ok(mut processes) = self.processes.try_write() {
            for process in processes.values() {
                let (response, _) = oneshot::channel();
                let _ = process
                    .command_tx
                    .try_send(ProcessCommand::Shutdown { response });
            }
            processes.clear();
        }
    }
}

async fn run_process(
    mut child: Child,
    mut stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    mut command_rx: mpsc::Receiver<ProcessCommand>,
    status_tx: watch::Sender<SidecarStatus>,
    transport: PluginRuntimeTransport,
) {
    let (line_tx, mut line_rx) = mpsc::channel(128);
    tokio::spawn(read_stdout_lines(stdout, line_tx));
    let mut pending = HashMap::<u64, oneshot::Sender<Result<Value, SidecarError>>>::new();
    let mut poll = tokio::time::interval(PROCESS_POLL_INTERVAL);
    let _ = status_tx.send(SidecarStatus::Running);

    loop {
        tokio::select! {
            _ = poll.tick() => {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let error = SidecarError::Crashed(format!("exit status {status}"));
                        fail_pending(&mut pending, error);
                        let _ = status_tx.send(SidecarStatus::Crashed);
                        break;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        fail_pending(&mut pending, SidecarError::Crashed(error.to_string()));
                        let _ = status_tx.send(SidecarStatus::Crashed);
                        break;
                    }
                }
            }
            Some(line) = line_rx.recv() => {
                match line {
                    Ok(value) => route_response(value, &mut pending),
                    Err(error) => {
                        fail_pending(&mut pending, error);
                        let _ = terminate_child(&mut child).await;
                        let _ = status_tx.send(SidecarStatus::Crashed);
                        break;
                    }
                }
            }
            Some(command) = command_rx.recv() => {
                match command {
                    ProcessCommand::Request { id, method, params, response } => {
                        let message = json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params});
                        if let Err(error) = write_message(&mut stdin, &message).await {
                            let _ = response.send(Err(error.clone()));
                            fail_pending(&mut pending, error);
                            let _ = terminate_child(&mut child).await;
                            let _ = status_tx.send(SidecarStatus::Crashed);
                            break;
                        }
                        pending.insert(id, response);
                    }
                    ProcessCommand::Notify { method, params, response } => {
                        let message = json!({"jsonrpc":"2.0", "method":method, "params":params});
                        let result = write_message(&mut stdin, &message).await;
                        let _ = response.send(result);
                    }
                    ProcessCommand::Cancel { id } => {
                        pending.remove(&id);
                        if transport == PluginRuntimeTransport::McpStdio {
                            let message = json!({"jsonrpc":"2.0", "method":"notifications/cancelled", "params":{"requestId":id, "reason":"ATools request timeout or cancellation"}});
                            let _ = write_message(&mut stdin, &message).await;
                        } else {
                            let message = json!({"jsonrpc":"2.0", "method":"$/cancelRequest", "params":{"id":id}});
                            let _ = write_message(&mut stdin, &message).await;
                        }
                    }
                    ProcessCommand::Shutdown { response } => {
                        fail_pending(&mut pending, SidecarError::Cancelled);
                        let result = terminate_child(&mut child).await;
                        let _ = status_tx.send(SidecarStatus::Stopped);
                        let _ = response.send(result);
                        break;
                    }
                }
            }
            else => {
                let _ = terminate_child(&mut child).await;
                fail_pending(&mut pending, SidecarError::NotRunning);
                let _ = status_tx.send(SidecarStatus::Stopped);
                break;
            }
        }
    }
}

async fn terminate_child(child: &mut Child) -> Result<(), SidecarError> {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = child.start_kill();
    child
        .wait()
        .await
        .map(|_| ())
        .map_err(|error| SidecarError::Crashed(error.to_string()))
}

async fn write_message(
    stdin: &mut tokio::process::ChildStdin,
    value: &Value,
) -> Result<(), SidecarError> {
    let mut bytes = serde_json::to_vec(value)
        .map_err(|error| SidecarError::Protocol(error.to_string()))?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|error| SidecarError::Crashed(error.to_string()))?;
    stdin
        .flush()
        .await
        .map_err(|error| SidecarError::Crashed(error.to_string()))
}

async fn read_stdout_lines(
    stdout: tokio::process::ChildStdout,
    line_tx: mpsc::Sender<Result<Value, SidecarError>>,
) {
    let mut reader = BufReader::new(stdout);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer).await {
            Ok(0) => break,
            Ok(_) if buffer.len() > MAX_PROTOCOL_LINE_BYTES => {
                let _ = line_tx
                    .send(Err(SidecarError::Protocol(
                        "stdout JSON message exceeded size limit".to_string(),
                    )))
                    .await;
                break;
            }
            Ok(_) => {
                while matches!(buffer.last(), Some(b'\n' | b'\r')) {
                    buffer.pop();
                }
                if buffer.is_empty() {
                    continue;
                }
                let value = serde_json::from_slice::<Value>(&buffer).map_err(|error| {
                    SidecarError::Protocol(format!(
                        "stdout must contain only JSON-RPC messages: {error}"
                    ))
                });
                if line_tx.send(value).await.is_err() {
                    break;
                }
            }
            Err(error) => {
                let _ = line_tx
                    .send(Err(SidecarError::Crashed(error.to_string())))
                    .await;
                break;
            }
        }
    }
}

async fn capture_stderr(
    stderr: tokio::process::ChildStderr,
    captured: Arc<RwLock<VecDeque<String>>>,
) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let mut captured = captured.write().await;
        captured.push_back(line);
        while captured.len() > MAX_STDERR_LINES {
            captured.pop_front();
        }
    }
}

fn route_response(
    value: Value,
    pending: &mut HashMap<u64, oneshot::Sender<Result<Value, SidecarError>>>,
) {
    let Some(id) = value.get("id").and_then(Value::as_u64) else {
        return;
    };
    let Some(response) = pending.remove(&id) else {
        return;
    };
    if let Some(error) = value.get("error") {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32_000);
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown JSON-RPC error")
            .to_string();
        let _ = response.send(Err(SidecarError::Remote { code, message }));
    } else if let Some(result) = value.get("result") {
        let _ = response.send(Ok(result.clone()));
    } else {
        let _ = response.send(Err(SidecarError::Protocol(
            "JSON-RPC response has neither result nor error".to_string(),
        )));
    }
}

fn fail_pending(
    pending: &mut HashMap<u64, oneshot::Sender<Result<Value, SidecarError>>>,
    error: SidecarError,
) {
    for (_, response) in pending.drain() {
        let _ = response.send(Err(error.clone()));
    }
}
