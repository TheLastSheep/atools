use std::fs::File;
use std::sync::atomic::AtomicBool;
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

use parking_lot::{Mutex, MutexGuard};

use super::unix::{check_cancel, Directory};
use super::NodeRuntimeCacheError as Error;

static PROCESS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(super) struct CacheLock {
    _process: MutexGuard<'static, ()>,
    file: File,
}

impl Drop for CacheLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(std::os::fd::AsRawFd::as_raw_fd(&self.file), libc::LOCK_UN);
        }
    }
}

pub(super) fn acquire(directory: &Directory, cancelled: &AtomicBool) -> Result<CacheLock, Error> {
    let process = PROCESS_LOCK.get_or_init(|| Mutex::new(()));
    let process_guard = loop {
        check_cancel(cancelled)?;
        if let Some(guard) = process.try_lock() {
            break guard;
        }
        thread::sleep(Duration::from_millis(20));
    };
    let file = directory.create_lock_file(".cache.lock")?;
    loop {
        check_cancel(cancelled)?;
        let result = unsafe {
            libc::flock(
                std::os::fd::AsRawFd::as_raw_fd(&file),
                libc::LOCK_EX | libc::LOCK_NB,
            )
        };
        if result == 0 {
            return Ok(CacheLock {
                _process: process_guard,
                file,
            });
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EWOULDBLOCK) {
            return Err(error.into());
        }
        thread::sleep(Duration::from_millis(20));
    }
}
