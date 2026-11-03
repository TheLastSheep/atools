use std::io::{Read, Write};
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd};
use std::process::{ChildStdin, ChildStdout};

pub(super) const OUTPUT_LIMIT: usize = 16 * 1024;

pub(super) struct ChildPipes {
    pub stdin: Option<ChildStdin>,
    pub stdout: ChildStdout,
}

impl ChildPipes {
    pub fn from_child(child: &mut std::process::Child, wants_stdin: bool) -> Result<Self, ()> {
        let stdout = child.stdout.take().ok_or(())?;
        let stdin = if wants_stdin {
            child.stdin.take()
        } else {
            None
        };
        if wants_stdin && stdin.is_none() {
            return Err(());
        }
        set_nonblocking(stdout.as_raw_fd()).map_err(|_| ())?;
        if let Some(input) = stdin.as_ref() {
            set_nonblocking(input.as_raw_fd()).map_err(|_| ())?;
        }
        Ok(Self { stdin, stdout })
    }

    /// Attempts a bounded nonblocking write. An unchanged offset means the pipe
    /// was full; the caller monitors cancellation/deadline before retrying.
    pub fn pump_input(&mut self, bytes: &[u8], offset: &mut usize) -> Result<(), ()> {
        if *offset >= bytes.len() {
            self.stdin.take();
            return Ok(());
        }
        let Some(input) = self.stdin.as_mut() else {
            return Err(());
        };
        loop {
            match input.write(&bytes[*offset..]) {
                Ok(0) => return Err(()),
                Ok(count) => {
                    *offset += count;
                    if *offset == bytes.len() {
                        self.stdin.take();
                    }
                    return Ok(());
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(()),
            }
        }
    }

    pub fn drain_output(&mut self, output: &mut Vec<u8>) -> Result<(), ()> {
        drain_bounded(&mut self.stdout, output)
    }
}

pub(super) fn drain_bounded(pipe: &mut impl Read, output: &mut Vec<u8>) -> Result<(), ()> {
    let mut chunk = [0u8; 4096];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => return Ok(()),
            Ok(size) => {
                if size > OUTPUT_LIMIT.saturating_sub(output.len()) {
                    return Err(());
                }
                output.extend_from_slice(&chunk[..size]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(()),
        }
    }
}

pub(super) fn set_nonblocking(fd: i32) -> std::io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

pub(super) struct CancelPipe {
    read: OwnedFd,
    write: OwnedFd,
}

impl CancelPipe {
    pub fn new() -> std::io::Result<Self> {
        let mut descriptors = [-1; 2];
        if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let read = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
        let write = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
        for fd in [read.as_raw_fd(), write.as_raw_fd()] {
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0
            {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok(Self { read, write })
    }

    pub fn read_fd(&self) -> i32 {
        self.read.as_raw_fd()
    }

    pub fn signal(&self) -> std::io::Result<()> {
        let byte = [1u8];
        let result = unsafe { libc::write(self.write.as_raw_fd(), byte.as_ptr().cast(), 1) };
        if result == 1 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}
