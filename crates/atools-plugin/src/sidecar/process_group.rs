use super::SidecarError;
use std::io;

/// Tracks only a process group verified to belong to the spawned root PID.
#[derive(Debug)]
pub(super) struct ProcessGroupClaim {
    pgid: Option<i32>,
    attempted: bool,
    error: Option<SidecarError>,
    provisional_permission_error: Option<SidecarError>,
    gone_confirmed: bool,
}

impl ProcessGroupClaim {
    #[cfg(unix)]
    pub(super) fn capture(child_pid: Option<u32>) -> Self {
        let result = validate_process_group(child_pid, |pid| {
            let pgid = unsafe { libc::getpgid(pid) };
            if pgid < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(pgid)
            }
        });
        match result {
            Ok(Some(pgid)) => Self::owned(pgid),
            Ok(None) => Self::unavailable(),
            Err(message) => Self::failed(message),
        }
    }

    #[cfg(not(unix))]
    pub(super) fn capture(_child_pid: Option<u32>) -> Self {
        Self::unavailable()
    }

    fn owned(pgid: i32) -> Self {
        Self {
            pgid: Some(pgid),
            attempted: false,
            error: None,
            provisional_permission_error: None,
            gone_confirmed: false,
        }
    }

    fn unavailable() -> Self {
        Self {
            pgid: None,
            attempted: true,
            error: None,
            provisional_permission_error: None,
            gone_confirmed: false,
        }
    }

    fn failed(message: String) -> Self {
        Self {
            pgid: None,
            attempted: true,
            error: Some(SidecarError::Crashed(message)),
            provisional_permission_error: None,
            gone_confirmed: false,
        }
    }

    pub(super) fn initial_error(&self) -> Option<SidecarError> {
        self.error.clone()
    }

    pub(super) fn cleanup_confirmed(&self) -> bool {
        self.error.is_none()
            && self.provisional_permission_error.is_none()
            && (self.pgid.is_none() || self.gone_confirmed)
    }

    pub(super) fn is_owned_and_pending(&self) -> bool {
        self.pgid.is_some() && !self.attempted
    }

    pub(super) fn signal_once(&mut self) -> Option<SidecarError> {
        self.signal_once_with(signal_process_group)
    }

    fn signal_once_with(
        &mut self,
        signal: impl FnOnce(i32) -> io::Result<()>,
    ) -> Option<SidecarError> {
        if self.attempted {
            return self.error.clone();
        }
        self.attempted = true;
        let Some(pgid) = self.pgid else {
            return self.error.clone();
        };

        if let Err(error) = signal_owned_process_group(pgid, signal) {
            let sidecar_error = SidecarError::Crashed(format!(
                "failed to signal owned sidecar process group {pgid}: {error}"
            ));
            if is_permission_error(&error) {
                self.provisional_permission_error = Some(sidecar_error);
                return None;
            }
            return Some(self.store_error(sidecar_error));
        }
        None
    }

    #[cfg(unix)]
    pub(super) fn signal_owned_group(&self, signal: i32) -> io::Result<bool> {
        let Some(pgid) = self.pgid else {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "process group is not owned",
            ));
        };
        if pgid <= 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "owned process group ID must be positive",
            ));
        }
        if unsafe { libc::kill(-pgid, signal) } == 0 {
            Ok(true)
        } else {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(false)
            } else {
                Err(error)
            }
        }
    }

    #[cfg(not(unix))]
    pub(super) fn signal_owned_group(&self, _signal: i32) -> io::Result<bool> {
        Ok(false)
    }

    pub(super) fn observe_gone_after_reap_with(
        &mut self,
        observe: impl FnOnce(i32) -> io::Result<()>,
    ) -> Result<bool, SidecarError> {
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        let Some(pgid) = self.pgid else {
            self.gone_confirmed = true;
            return Ok(true);
        };
        if self.gone_confirmed {
            return Ok(true);
        }
        if !self.attempted {
            return Err(self.store_error(SidecarError::Crashed(format!(
                "owned sidecar process group {pgid} was not signaled before root reap"
            ))));
        }

        match observe(pgid) {
            Ok(()) => Ok(false),
            Err(error) if is_no_such_process(&error) => {
                self.provisional_permission_error = None;
                self.gone_confirmed = true;
                Ok(true)
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => Ok(false),
            Err(error) if is_permission_error(&error) => Ok(false),
            Err(error) => {
                let detail = match self.provisional_permission_error.take() {
                    Some(signal_error) => format!(
                        "{signal_error}; failed to observe owned sidecar process group {pgid} after root reap: {error}"
                    ),
                    None => format!(
                        "failed to observe owned sidecar process group {pgid} after root reap: {error}"
                    ),
                };
                Err(self.store_error(SidecarError::Crashed(detail)))
            }
        }
    }

    pub(super) fn fail_unconfirmed_after_reap(
        &mut self,
        wait_budget: std::time::Duration,
    ) -> SidecarError {
        if let Some(error) = &self.error {
            return error.clone();
        }
        let detail = match self.provisional_permission_error.take() {
            Some(signal_error) => format!(
                "{signal_error}; owned sidecar process group did not disappear within {wait_budget:?} after root reap"
            ),
            None => format!(
                "owned sidecar process group did not disappear within {wait_budget:?} after root reap"
            ),
        };
        self.store_error(SidecarError::Crashed(detail))
    }

    pub(super) fn fail_unconfirmed_on_drop(&mut self) -> Option<SidecarError> {
        if self.cleanup_confirmed() {
            return None;
        }
        let detail = match self.provisional_permission_error.take() {
            Some(signal_error) => format!(
                "{signal_error}; owned sidecar process group cleanup was dropped before disappearance was confirmed"
            ),
            None => "owned sidecar process group cleanup was dropped before disappearance was confirmed"
                .to_string(),
        };
        Some(self.store_error(SidecarError::Crashed(detail)))
    }

    pub(super) fn disarm_with_error(&mut self, error: SidecarError) -> SidecarError {
        self.attempted = true;
        let error = match self.provisional_permission_error.take() {
            Some(signal_error) => SidecarError::Crashed(format!("{signal_error}; {error}")),
            None => error,
        };
        self.store_error(error)
    }

    fn store_error(&mut self, error: SidecarError) -> SidecarError {
        if self.error.is_none() {
            self.error = Some(error);
        }
        self.error
            .clone()
            .expect("process group error was set before reading it")
    }
}

#[cfg(unix)]
fn validate_process_group(
    child_pid: Option<u32>,
    getpgid: impl FnOnce(i32) -> io::Result<i32>,
) -> Result<Option<i32>, String> {
    let Some(child_pid) = child_pid else {
        return Err("spawned sidecar has no PID".to_string());
    };
    let pid = i32::try_from(child_pid)
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| format!("sidecar PID {child_pid} is not a positive i32"))?;
    let pgid = getpgid(pid).map_err(|error| {
        format!("failed to verify process group for sidecar PID {pid}: {error}")
    })?;
    if pgid != pid {
        return Err(format!(
            "sidecar PID {pid} is in process group {pgid}; refusing to claim or signal it"
        ));
    }
    Ok(Some(pgid))
}

#[cfg(unix)]
fn signal_owned_process_group(
    pgid: i32,
    signal: impl FnOnce(i32) -> io::Result<()>,
) -> io::Result<()> {
    if pgid <= 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "owned process group ID must be positive",
        ));
    }
    match signal(-pgid) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(not(unix))]
fn signal_owned_process_group(
    pgid: i32,
    signal: impl FnOnce(i32) -> io::Result<()>,
) -> io::Result<()> {
    if pgid <= 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "owned process group ID must be positive",
        ));
    }
    signal(-pgid)
}

#[cfg(unix)]
fn is_permission_error(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn is_permission_error(_error: &io::Error) -> bool {
    false
}

#[cfg(unix)]
fn is_no_such_process(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn is_no_such_process(_error: &io::Error) -> bool {
    false
}

#[cfg(unix)]
fn signal_process_group(target: i32) -> io::Result<()> {
    signal_process_group_with(target, |target, signal| unsafe {
        libc::kill(target, signal)
    })
}

#[cfg(unix)]
fn signal_process_group_with(target: i32, kill: impl FnOnce(i32, i32) -> i32) -> io::Result<()> {
    let result = kill(target, libc::SIGKILL);
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(unix))]
fn signal_process_group(_target: i32) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
pub(super) fn observe_process_group(pgid: i32) -> io::Result<()> {
    if pgid <= 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "owned process group ID must be positive",
        ));
    }
    if unsafe { libc::kill(-pgid, 0) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(unix))]
pub(super) fn observe_process_group(_pgid: i32) -> io::Result<()> {
    Ok(())
}

#[cfg(all(test, unix))]
#[path = "process_group_tests.rs"]
mod tests;
