//! One construction owner. Hidden sessions cannot be reused until display commits and owner exits.
use super::*;
pub(super) struct Opening(Arc<runtime::Runtime>);
impl runtime::Runtime {
    pub fn reserve_opening(self: &Arc<Self>) -> Result<Opening, Error> {
        if self.stopped.load(Ordering::Acquire) || self.opening.swap(true, Ordering::AcqRel) {
            return Err(error("busy"));
        }
        Ok(Opening(self.clone()))
    }
}
impl Opening {
    pub fn install(&self, session: runtime::Session) -> Result<(), Error> {
        let _delivery = self.0.delivery.lock();
        let mut slot = self.0.session.lock();
        if self.0.stopped.load(Ordering::Acquire) || slot.is_some() {
            return Err(error("busy"));
        }
        *slot = Some(session);
        Ok(())
    }
}
impl Drop for Opening {
    fn drop(&mut self) {
        self.0.opening.store(false, Ordering::Release);
    }
}

#[cfg(test)]
#[path = "opening_tests.rs"]
mod tests;
