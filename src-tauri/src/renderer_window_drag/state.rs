use super::request::WindowSize;
use std::sync::{Arc, Mutex};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAX_ACTIVE_OPERATIONS: usize = 16;
const STATE_UNAVAILABLE: &str = "window drag state is unavailable";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum LockInstall {
    Installed,
    AlreadyLocked,
    Invalidated,
}

#[derive(Default)]
struct Geometry {
    locked_size: Option<WindowSize>,
    generation: u64,
}

pub(super) struct DragState {
    operations: Arc<Semaphore>,
    geometry: Mutex<Geometry>,
}

impl DragState {
    pub(super) fn new() -> Self {
        Self {
            operations: Arc::new(Semaphore::new(MAX_ACTIVE_OPERATIONS)),
            geometry: Mutex::new(Geometry::default()),
        }
    }

    pub(super) fn try_admit(&self) -> Result<(OwnedSemaphorePermit, u64), &'static str> {
        let permit = Arc::clone(&self.operations)
            .try_acquire_owned()
            .map_err(|_| "window drag operation capacity is exhausted")?;
        let generation = self
            .geometry
            .lock()
            .map_err(|_| STATE_UNAVAILABLE)?
            .generation;
        Ok((permit, generation))
    }

    pub(super) fn locked_size(&self, generation: u64) -> Result<Option<WindowSize>, &'static str> {
        let geometry = self.geometry.lock().map_err(|_| STATE_UNAVAILABLE)?;
        if geometry.generation != generation {
            return Err("window drag operation was invalidated");
        }
        Ok(geometry.locked_size)
    }

    pub(super) fn is_current(&self, generation: u64) -> Result<bool, &'static str> {
        self.geometry
            .lock()
            .map(|geometry| geometry.generation == generation)
            .map_err(|_| STATE_UNAVAILABLE)
    }

    pub(super) fn install_lock(
        &self,
        generation: u64,
        size: WindowSize,
    ) -> Result<LockInstall, &'static str> {
        let mut geometry = self.geometry.lock().map_err(|_| STATE_UNAVAILABLE)?;
        if geometry.generation != generation {
            return Ok(LockInstall::Invalidated);
        }
        if geometry.locked_size.is_some() {
            return Ok(LockInstall::AlreadyLocked);
        }
        geometry.locked_size = Some(size);
        Ok(LockInstall::Installed)
    }

    pub(super) fn resize_locked_size(&self, size: WindowSize) -> Result<bool, &'static str> {
        let mut geometry = self.geometry.lock().map_err(|_| STATE_UNAVAILABLE)?;
        if geometry.locked_size.is_none() {
            return Ok(false);
        }
        geometry.locked_size = Some(size);
        Ok(true)
    }

    pub(super) fn release_lock(&self, generation: u64) -> Result<bool, &'static str> {
        let mut geometry = self.geometry.lock().map_err(|_| STATE_UNAVAILABLE)?;
        if geometry.generation != generation {
            return Ok(false);
        }
        if geometry.locked_size.take().is_none() {
            return Ok(false);
        }
        geometry.generation = geometry.generation.wrapping_add(1);
        Ok(true)
    }

    pub(super) fn invalidate_lock(&self) -> Result<bool, &'static str> {
        let mut geometry = self.geometry.lock().map_err(|_| STATE_UNAVAILABLE)?;
        let was_locked = geometry.locked_size.take().is_some();
        geometry.generation = geometry.generation.wrapping_add(1);
        Ok(was_locked)
    }

    pub(super) fn is_locked(&self) -> Option<bool> {
        self.geometry
            .lock()
            .ok()
            .map(|geometry| geometry.locked_size.is_some())
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
