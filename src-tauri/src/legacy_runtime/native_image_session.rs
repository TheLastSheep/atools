//! Per-document image-handle store lifecycle, separate from Node permissions and identity.
use super::native_image::{NativeImageEngine, NativeImageError, NativeImageSession};
use parking_lot::Mutex;
use std::sync::Arc;

enum StoreState {
    Active(Option<Arc<NativeImageSession>>),
    Closed,
}

/// A closed slot differs from an unused slot so a late timeout cannot revive a closed page.
pub(super) struct ImageSessionStore(Mutex<StoreState>);

impl Default for ImageSessionStore {
    fn default() -> Self {
        Self(Mutex::new(StoreState::Active(None)))
    }
}

impl ImageSessionStore {
    pub(super) fn get_or_create(
        &self,
        engine: &NativeImageEngine,
    ) -> Result<Arc<NativeImageSession>, NativeImageError> {
        let mut state = self.0.lock();
        match &mut *state {
            StoreState::Active(current) => Ok(Arc::clone(
                current.get_or_insert_with(|| Arc::new(engine.new_session())),
            )),
            StoreState::Closed => Err(NativeImageError::SessionClosed),
        }
    }

    pub(super) fn current(&self) -> Result<Arc<NativeImageSession>, NativeImageError> {
        match &*self.0.lock() {
            StoreState::Active(Some(current)) => Ok(Arc::clone(current)),
            StoreState::Active(None) => Err(NativeImageError::HandleUnavailable),
            StoreState::Closed => Err(NativeImageError::SessionClosed),
        }
    }

    pub(super) fn is_current(&self, expected: &Arc<NativeImageSession>) -> bool {
        matches!(&*self.0.lock(), StoreState::Active(Some(current)) if Arc::ptr_eq(current, expected))
    }

    /// Retiring an open timeout invalidates every prior handle. If Node is already gone,
    /// permanently close the slot instead of creating a replacement image session.
    pub(super) fn retire_timed_out_open(
        &self,
        expected: &Arc<NativeImageSession>,
        engine: &NativeImageEngine,
        node_running: bool,
    ) -> bool {
        let mut state = self.0.lock();
        let current = match &*state {
            StoreState::Active(Some(current)) if Arc::ptr_eq(current, expected) => {
                Arc::clone(current)
            }
            _ => return false,
        };
        current.close();
        if node_running {
            *state = StoreState::Active(Some(Arc::new(engine.new_session())));
        } else {
            *state = StoreState::Closed;
        }
        true
    }

    pub(super) fn close(&self) {
        let mut state = self.0.lock();
        if let StoreState::Active(Some(current)) = &*state {
            current.close();
        }
        *state = StoreState::Closed;
    }
}
