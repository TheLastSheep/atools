#[cfg(unix)]
use std::os::fd::RawFd;
use std::time::{Duration, Instant};

pub(super) const PLAN_BYTES: usize = 1024 * 1024;
pub(super) const PACKAGE_COUNT: usize = 4096;
pub(super) const ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
pub(super) const AGGREGATE_ARCHIVE_BYTES: u64 = 128 * 1024 * 1024;
pub(super) const FILE_BYTES: u64 = 32 * 1024 * 1024;
pub(super) const AGGREGATE_UNPACKED_BYTES: u64 = 512 * 1024 * 1024;
pub(super) const ARCHIVE_ENTRIES: usize = 65_536;
pub(super) const PATH_BYTES: usize = 1024;
pub(super) const PATH_DEPTH: usize = 32;
pub(super) const PATH_METADATA_BYTES: u64 = 4 * 1024 * 1024;
pub(super) const TARBALL_STREAM_BYTES: u64 = 640 * 1024 * 1024;
pub(super) const WALL_TIME: Duration = Duration::from_secs(120);
pub(super) const IO_CHUNK: usize = 64 * 1024;

pub(super) struct Deadline {
    end: Instant,
    #[cfg(unix)]
    cancel_fd: Option<RawFd>,
}

impl Deadline {
    #[cfg(test)]
    pub fn start() -> Self {
        Self {
            end: Instant::now() + WALL_TIME,
            #[cfg(unix)]
            cancel_fd: None,
        }
    }

    #[cfg(unix)]
    pub fn with_cancel_fd(fd: RawFd) -> Self {
        Self {
            end: Instant::now() + WALL_TIME,
            cancel_fd: Some(fd),
        }
    }

    pub fn check(&self) -> Result<(), &'static str> {
        if Instant::now() >= self.end {
            Err("dependency_worker_timeout")
        } else {
            #[cfg(unix)]
            if let Some(fd) = self.cancel_fd {
                let mut byte = 0u8;
                let result =
                    unsafe { libc::read(fd, &mut byte as *mut u8 as *mut libc::c_void, 1) };
                if result >= 0 {
                    return Err("dependency_worker_cancelled");
                }
                let error = std::io::Error::last_os_error();
                let would_block = error
                    .raw_os_error()
                    .is_some_and(|code| code == libc::EAGAIN || code == libc::EWOULDBLOCK);
                if !would_block {
                    return Err("dependency_worker_cancelled");
                }
            }
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) fn apply_process_limits() -> Result<(), &'static str> {
    fn set(resource: libc::c_int, value: libc::rlim_t) -> Result<(), &'static str> {
        let limit = libc::rlimit {
            rlim_cur: value,
            rlim_max: value,
        };
        if unsafe { libc::setrlimit(resource, &limit) } == 0 {
            Ok(())
        } else {
            Err("dependency_worker_limits_unavailable")
        }
    }

    set(libc::RLIMIT_CPU, 60)?;
    set(libc::RLIMIT_CORE, 0)?;
    set(libc::RLIMIT_NOFILE, 2048)?;
    set(libc::RLIMIT_FSIZE, FILE_BYTES as libc::rlim_t)
}
