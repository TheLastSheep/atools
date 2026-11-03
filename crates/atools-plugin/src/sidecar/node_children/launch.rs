use super::NodeChildrenOwner;
use crate::sidecar::SidecarError;
use tokio::process::Command;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::fs::{self, DirBuilder, File};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::io::{self, Read};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::unix::fs::DirBuilderExt;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::unix::net::UnixListener;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::path::{Path, PathBuf};

const CONTROL_SOCKET_ENV: &str = "ATOOLS_MANAGED_CHILD_CONTROL_SOCKET";
const EVENT_SOCKET_ENV: &str = "ATOOLS_MANAGED_CHILD_EVENT_SOCKET";
const TOKEN_ENV: &str = "ATOOLS_MANAGED_CHILD_TOKEN";

pub(crate) struct NodeChildrenLaunch {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    control_listener: UnixListener,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    event_listener: UnixListener,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    token: String,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    directory: SocketDirectory,
}

impl NodeChildrenLaunch {
    pub(crate) fn prepare(command: &mut Command) -> Result<Option<Self>, SidecarError> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let (directory, token) = SocketDirectory::create().map_err(|error| {
                SidecarError::Spawn(format!("managed child socket directory failed: {error}"))
            })?;
            let control_listener =
                UnixListener::bind(&directory.control_path).map_err(|error| {
                    SidecarError::Spawn(format!(
                        "managed child control socket bind failed: {error}"
                    ))
                })?;
            let event_listener = UnixListener::bind(&directory.event_path).map_err(|error| {
                SidecarError::Spawn(format!("managed child event socket bind failed: {error}"))
            })?;
            control_listener.set_nonblocking(true).map_err(|error| {
                SidecarError::Spawn(format!(
                    "managed child control socket setup failed: {error}"
                ))
            })?;
            event_listener.set_nonblocking(true).map_err(|error| {
                SidecarError::Spawn(format!("managed child event socket setup failed: {error}"))
            })?;

            command
                .env(CONTROL_SOCKET_ENV, &directory.control_path)
                .env(EVENT_SOCKET_ENV, &directory.event_path)
                .env(TOKEN_ENV, &token);
            return Ok(Some(Self {
                control_listener,
                event_listener,
                token,
                directory,
            }));
        }

        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = command;
            Ok(None)
        }
    }

    pub(crate) fn start(self) -> NodeChildrenOwner {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            NodeChildrenOwner::start(self)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = self;
            NodeChildrenOwner::unsupported()
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) fn into_parts(self) -> NodeChildrenLaunchParts {
        NodeChildrenLaunchParts {
            control_listener: self.control_listener,
            event_listener: self.event_listener,
            token: self.token,
            directory: self.directory,
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) struct NodeChildrenLaunchParts {
    pub(super) control_listener: UnixListener,
    pub(super) event_listener: UnixListener,
    pub(super) token: String,
    pub(super) directory: SocketDirectory,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) struct SocketDirectory {
    path: PathBuf,
    pub(super) control_path: PathBuf,
    pub(super) event_path: PathBuf,
    cleaned: bool,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl SocketDirectory {
    fn create() -> io::Result<(Self, String)> {
        let root = if cfg!(target_os = "macos") {
            Path::new("/private/tmp")
        } else {
            Path::new("/tmp")
        };
        let mut created = None;
        for _ in 0..4 {
            let name = format!("atools-child-{}", random_hex(16)?);
            let path = root.join(name);
            let mut builder = DirBuilder::new();
            builder.mode(0o700);
            match builder.create(&path) {
                Ok(()) => {
                    created = Some(path);
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        let path = created.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::AlreadyExists,
                "could not allocate unique private directory",
            )
        })?;
        let directory = Self {
            control_path: path.join("control.sock"),
            event_path: path.join("events.sock"),
            path,
            cleaned: false,
        };
        let token = random_hex(32)?;
        Ok((directory, token))
    }

    pub(super) fn cleanup(&mut self) -> io::Result<()> {
        if self.cleaned {
            return Ok(());
        }
        let mut first_error = None;
        for socket in [&self.control_path, &self.event_path] {
            match fs::remove_file(socket) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        match fs::remove_dir(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        self.cleaned = true;
        Ok(())
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Drop for SocketDirectory {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn random_hex(bytes: usize) -> io::Result<String> {
    let mut value = vec![0u8; bytes];
    File::open("/dev/urandom")?.read_exact(&mut value)?;
    use std::fmt::Write as _;
    let mut result = String::with_capacity(bytes * 2);
    for byte in value {
        write!(&mut result, "{byte:02x}").expect("write into String cannot fail");
    }
    Ok(result)
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::NodeChildrenLaunch;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    const CASE_ENV: &str = "ATOOLS_TEST_MANAGED_SOCKET_CLOSED_STDIO";
    const TEST_FILTER: &str = "prepare_uses_private_socket_paths_with_closed_stdio";

    #[test]
    fn prepare_uses_private_socket_paths_with_closed_stdio() {
        if std::env::var_os(CASE_ENV).is_some() {
            let mut command = tokio::process::Command::new("/usr/bin/true");
            let launch = NodeChildrenLaunch::prepare(&mut command)
                .expect("prepare socket transport")
                .expect("Unix targets support socket transport");
            let mode = std::fs::metadata(&launch.directory.path)
                .expect("private socket directory metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o700);
            assert_eq!(
                launch.control_listener.local_addr().unwrap().as_pathname(),
                Some(launch.directory.control_path.as_path())
            );
            assert_eq!(
                launch.event_listener.local_addr().unwrap().as_pathname(),
                Some(launch.directory.event_path.as_path())
            );
            let env = command.as_std().get_envs().collect::<Vec<_>>();
            assert!(env.iter().any(|(key, value)| {
                *key == std::ffi::OsStr::new("ATOOLS_MANAGED_CHILD_CONTROL_SOCKET")
                    && *value == Some(launch.directory.control_path.as_os_str())
            }));
            assert!(env.iter().any(|(key, value)| {
                *key == std::ffi::OsStr::new("ATOOLS_MANAGED_CHILD_EVENT_SOCKET")
                    && *value == Some(launch.directory.event_path.as_os_str())
            }));
            assert!(env.iter().any(|(key, value)| {
                *key == std::ffi::OsStr::new("ATOOLS_MANAGED_CHILD_TOKEN") && value.is_some()
            }));
            let directory = launch.directory.path.clone();
            drop(launch);
            assert!(
                !directory.exists(),
                "dropped launch leaked its private directory"
            );
            return;
        }

        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        command
            .arg(TEST_FILTER)
            .env(CASE_ENV, "closed-stdio")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(|| {
                for fd in 0..=2 {
                    if libc::close(fd) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        let status = command
            .status()
            .expect("run isolated test with closed stdio");
        assert!(
            status.success(),
            "closed-stdio socket test failed: {status}"
        );
    }
}
