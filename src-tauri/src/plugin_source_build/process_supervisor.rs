//! One blocking supervisor, nonblocking bounded pipes, independently owned child.
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub(super) struct CommandSpec<'a> {
    pub stage: &'a Path,
    pub work: &'a Path,
    pub profile: &'a Path,
    pub node: &'a Path,
    pub entry: &'a Path,
    pub args: Vec<String>,
    pub vite_backend_path: &'a Path,
    pub rolldown_backend: bool,
    pub test_esbuild: Option<&'a Path>,
    pub dependencies: &'a Path,
}
pub(super) struct Limits {
    pub wall: Duration,
    pub cleanup: Duration,
    pub logs: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            wall: Duration::from_secs(120),
            cleanup: Duration::from_secs(3),
            logs: 64 * 1024,
        }
    }
}
pub(super) struct Receipt {
    pub exit_code: Option<i32>,
}
pub(super) struct Outcome {
    pub result: Result<Receipt, String>,
    pub cleanup_confirmed: bool,
    /// Ephemeral untrusted bytes, never a serialized result/error/audit field.
    pub diagnostic_log: Vec<u8>,
    pub exit: Option<std::process::ExitStatus>,
}

#[cfg(target_os = "macos")]
pub(super) fn run(spec: CommandSpec<'_>, cancel: &AtomicBool, limits: Limits) -> Outcome {
    if cancel.load(Ordering::Acquire) {
        return Outcome {
            result: Err("SOURCE_BUILD_CANCELLED".into()),
            cleanup_confirmed: true,
            diagnostic_log: Vec::new(),
            exit: None,
        };
    }
    let mut command = match command(&spec) {
        Ok(command) => command,
        Err(error) => {
            return Outcome {
                result: Err(error),
                cleanup_confirmed: true,
                diagnostic_log: Vec::new(),
                exit: None,
            }
        }
    };
    let child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            return Outcome {
                result: Err("SourceBuildSpawnFailed".into()),
                cleanup_confirmed: true,
                diagnostic_log: Vec::new(),
                exit: None,
            }
        }
    };
    let mut owned = OwnedChild {
        pid: child.id() as i32,
        child,
        reaped: false,
        group_signalled: false,
    };
    let mut stdout = owned.child.stdout.take().expect("piped stdout");
    let mut stderr = owned.child.stderr.take().expect("piped stderr");
    if nonblocking(&stdout).is_err() || nonblocking(&stderr).is_err() {
        owned.terminate();
        return Outcome {
            result: Err("SourceBuildPipeConfigurationFailed".into()),
            cleanup_confirmed: false,
            diagnostic_log: Vec::new(),
            exit: None,
        };
    }
    let start = Instant::now();
    let mut stopped = None;
    let mut status = None;
    let mut error: Option<String> = None;
    let (mut out_closed, mut err_closed) = (false, false);
    let mut log = Vec::new();
    loop {
        if error.is_none() {
            error = if cancel.load(Ordering::Acquire) {
                Some("SOURCE_BUILD_CANCELLED".into())
            } else if start.elapsed() >= limits.wall {
                Some("SourceBuildTimeout".into())
            } else {
                None
            };
        }
        for (pipe, closed) in [
            (&mut stdout as &mut dyn Read, &mut out_closed),
            (&mut stderr as &mut dyn Read, &mut err_closed),
        ] {
            if !*closed {
                match drain(pipe, &mut log, limits.logs) {
                    Ok(eof) => *closed = eof,
                    Err(code) => {
                        if error.is_none() {
                            error = Some(code.into());
                        }
                    }
                }
            }
        }
        if !owned.reaped {
            match owned.poll_exit() {
                Ok(Some(exit)) => {
                    status = Some(exit);
                }
                Ok(None) => {}
                Err(_) => {
                    if error.is_none() {
                        error = Some("SourceBuildWaitFailed".into());
                    }
                }
            }
        }
        if (error.is_some() || owned.reaped) && stopped.is_none() {
            owned.terminate();
            stopped = Some(Instant::now());
        }
        let group_closed = group_closed(owned.pid);
        if owned.reaped && group_closed && out_closed && err_closed {
            let result = if let Some(error) = error {
                Err(error)
            } else if status.as_ref().is_some_and(|exit| exit.success()) {
                Ok(Receipt {
                    exit_code: status.and_then(|exit| exit.code()),
                })
            } else {
                Err("SourceBuildProcessFailed".into())
            };
            return Outcome {
                result,
                cleanup_confirmed: true,
                diagnostic_log: log,
                exit: status,
            };
        }
        if stopped.is_some_and(|when| when.elapsed() >= limits.cleanup) {
            return Outcome {
                result: Err("SOURCE_BUILD_CLEANUP_UNCONFIRMED".into()),
                cleanup_confirmed: false,
                diagnostic_log: log,
                exit: status,
            };
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "macos")]
fn command(spec: &CommandSpec<'_>) -> Result<Command, String> {
    for name in ["home", "tmp", "cache", "config"] {
        std::fs::create_dir(spec.stage.join(name))
            .map_err(|_| "SourceBuildPrivateEnvironmentFailed")?;
    }
    let helper = super::super::bootstrap::executable()?;
    let mut command = Command::new(helper);
    command
        .arg(super::super::bootstrap::FLAG)
        .args(bootstrap_arguments(&spec))
        .current_dir(spec.work)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .env("PATH", "");
    Ok(command)
}

fn bootstrap_arguments(spec: &CommandSpec<'_>) -> Vec<std::ffi::OsString> {
    let mut arguments = vec![
        spec.stage.as_os_str().to_owned(),
        spec.work.as_os_str().to_owned(),
        spec.profile.as_os_str().to_owned(),
        spec.node.as_os_str().to_owned(),
        spec.entry.as_os_str().to_owned(),
        spec.vite_backend_path.as_os_str().to_owned(),
        spec.dependencies.as_os_str().to_owned(),
    ];
    if spec.rolldown_backend {
        arguments.push("--rolldown-binding".into());
    }
    if let Some(extra) = spec
        .test_esbuild
        .filter(|path| *path != spec.vite_backend_path)
    {
        arguments.push("--extra-esbuild".into());
        arguments.push(extra.as_os_str().to_owned());
    }
    arguments.push("--".into());
    arguments.extend(spec.args.iter().cloned().map(Into::into));
    arguments
}

fn drain(pipe: &mut dyn Read, output: &mut Vec<u8>, limit: usize) -> Result<bool, &'static str> {
    let mut chunk = [0u8; 8192];
    // At most 64 KiB per stream per supervisor tick, even if a child floods.
    for _ in 0..8 {
        match pipe.read(&mut chunk) {
            Ok(0) => return Ok(true),
            Ok(count) => {
                if count > limit.saturating_sub(output.len()) {
                    return Err("SourceBuildLogLimitExceeded");
                }
                output.extend_from_slice(&chunk[..count]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("SourceBuildLogReadFailed"),
        }
    }
    Ok(false)
}

#[cfg(target_os = "macos")]
fn nonblocking(pipe: &impl std::os::fd::AsRawFd) -> std::io::Result<()> {
    let fd = pipe.as_raw_fd();
    let current = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if current < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, current | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn group_closed(pid: i32) -> bool {
    unsafe { libc::kill(-pid, 0) == -1 && *libc::__error() == libc::ESRCH }
}

#[cfg(target_os = "macos")]
struct OwnedChild {
    child: Child,
    pid: i32,
    reaped: bool,
    group_signalled: bool,
}
#[cfg(target_os = "macos")]
impl OwnedChild {
    fn terminate(&mut self) {
        // Never send a signal after reaping released this exact root PID. WNOWAIT
        // below preserves its identity until the original group is signalled.
        if !self.reaped && !self.group_signalled {
            unsafe {
                libc::kill(-self.pid, libc::SIGKILL);
            }
            let _ = self.child.kill();
            self.group_signalled = true;
        }
    }
    fn poll_exit(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        let mut information: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::waitid(
                libc::P_PID,
                self.pid as libc::id_t,
                &mut information,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        if information.si_pid != self.pid {
            return Ok(None);
        }
        self.terminate();
        let status = self.child.try_wait()?;
        self.reaped = status.is_some();
        Ok(status)
    }
}
#[cfg(target_os = "macos")]
impl Drop for OwnedChild {
    fn drop(&mut self) {
        self.terminate();
        if !self.reaped {
            // Keep the independently owned supervisor alive until the exact root
            // is actually reaped. The async caller does not own this blocking wait.
            self.reaped = self.child.wait().is_ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_spec<'a>(test_esbuild: Option<&'a Path>, rolldown_backend: bool) -> CommandSpec<'a> {
        CommandSpec {
            stage: Path::new("/stage"),
            work: Path::new("/stage/work"),
            profile: Path::new("/stage/build.sb"),
            node: Path::new("/tools/node"),
            entry: Path::new("/stage/work/runner.mjs"),
            args: vec!["--step".into()],
            vite_backend_path: Path::new("/deps/vite-esbuild"),
            rolldown_backend,
            test_esbuild,
            dependencies: Path::new("/deps"),
        }
    }

    #[test]
    fn aggregate_log_bound_rejects_without_retaining_excess() {
        let mut log = Vec::new();
        let mut input: &[u8] = &[7; 129];
        assert_eq!(
            drain(&mut input, &mut log, 128),
            Err("SourceBuildLogLimitExceeded")
        );
        assert!(log.is_empty());
    }

    #[test]
    fn bootstrap_arguments_add_one_exact_extra_binary_only_when_distinct() {
        let legacy = bootstrap_arguments(&command_spec(None, false));
        assert_eq!(legacy.len(), 9);
        assert_eq!(legacy[7], "--");
        assert!(!legacy.iter().any(|arg| arg == "--extra-esbuild"));

        let same = bootstrap_arguments(&command_spec(Some(Path::new("/deps/vite-esbuild")), false));
        assert_eq!(same.len(), 9);
        assert!(!same.iter().any(|arg| arg == "--extra-esbuild"));

        let extra =
            bootstrap_arguments(&command_spec(Some(Path::new("/deps/test-esbuild")), false));
        assert_eq!(extra.len(), 11);
        assert_eq!(extra[7], "--extra-esbuild");
        assert_eq!(extra[8], "/deps/test-esbuild");
        assert_eq!(extra[9], "--");
        assert_eq!(extra[10], "--step");
        assert_eq!(
            extra.iter().filter(|arg| *arg == "--extra-esbuild").count(),
            1
        );
    }

    #[test]
    fn rolldown_bootstrap_marker_is_explicit_and_precedes_optional_test_binary() {
        let extra = bootstrap_arguments(&command_spec(Some(Path::new("/deps/test-esbuild")), true));
        assert_eq!(extra[7], "--rolldown-binding");
        assert_eq!(extra[8], "--extra-esbuild");
        assert_eq!(extra[9], "/deps/test-esbuild");
        assert_eq!(extra[10], "--");
        assert_eq!(extra[11], "--step");
    }
}
