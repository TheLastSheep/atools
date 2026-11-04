use super::startup_diagnostics::StartupTrace;
use super::{NodeRuntimeSelector, SidecarError, SidecarLaunchSpec};
use atools_core::PluginRuntimeKind;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::process::Command;

impl SidecarLaunchSpec {
    pub(super) async fn command_with_node_selector(
        &self,
        selector: &NodeRuntimeSelector,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Command, SidecarError> {
        self.command_with_node_bootstrap(None, None, selector, cancelled)
            .await
    }

    pub(crate) async fn node_bootstrap_command_with_diagnostics(
        &self,
        bootstrap: &str,
        diagnostics: Option<&StartupTrace>,
        selector: &NodeRuntimeSelector,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Command, SidecarError> {
        let mut command = self
            .command_with_node_bootstrap(Some(bootstrap), diagnostics, selector, cancelled)
            .await?;
        command.env("ATOOLS_PRELOAD_ENTRY", &self.entry);
        Ok(command)
    }

    async fn command_with_node_bootstrap(
        &self,
        bootstrap: Option<&str>,
        diagnostics: Option<&StartupTrace>,
        selector: &NodeRuntimeSelector,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Command, SidecarError> {
        let node_binary = if self.runtime == PluginRuntimeKind::Node {
            Some(
                selector
                    .resolve_node_binary_for_startup(cancelled, self.startup_timeout)
                    .await?,
            )
        } else {
            None
        };
        if let (Some(trace), Some(path)) = (diagnostics, node_binary.as_deref()) {
            trace.record_selected_executable_path(path);
        }
        let mut command = match self.runtime {
            PluginRuntimeKind::Rust => Command::new(&self.entry),
            PluginRuntimeKind::Node => {
                let mut command =
                    Command::new(node_binary.as_ref().expect("Node runtime resolved"));
                // Opt-in test fixture only: identify sidecars even if the native
                // harness crashes before a process-tree snapshot can see them.
                #[cfg(feature = "native-smoke")]
                if let Ok(tag) = std::env::var("ATOOLS_NATIVE_SMOKE_PROCESS_TAG") {
                    if tag.starts_with("atools-native-smoke-")
                        && tag.len() < 80
                        && tag.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    {
                        command.arg(format!("--title={tag}"));
                    }
                }
                if let Some(source) = bootstrap {
                    command
                        .arg("--max-old-space-size=128")
                        .arg("-e")
                        .arg(source);
                } else {
                    command.arg(&self.entry);
                }
                command
            }
            PluginRuntimeKind::Wasm => {
                let mut command = Command::new(
                    std::env::var_os("ATOOLS_WASM_RUNTIME").unwrap_or_else(|| "wasmtime".into()),
                );
                command.arg("run").arg(&self.entry);
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
        // Nested Node/npm commands must use the same selected runtime even when
        // the desktop launcher's inherited PATH contains only system binaries.
        if let Some(bin_dir) = node_binary.as_deref().and_then(std::path::Path::parent) {
            let mut paths = vec![bin_dir.to_path_buf()];
            if let Some(inherited) = std::env::var_os("PATH") {
                for dir in std::env::split_paths(&inherited).filter(|dir| dir.is_absolute()) {
                    if !paths.contains(&dir) {
                        paths.push(dir);
                    }
                }
            }
            if let Ok(value) = std::env::join_paths(paths) {
                command.env("PATH", value);
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
        Ok(command)
    }
}
