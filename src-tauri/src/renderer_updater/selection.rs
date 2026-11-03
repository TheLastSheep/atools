//! Exact existing-generation admission between manager selection and Native display.
use super::*;
pub(super) fn existing(
    runtime: &runtime::Runtime,
    state: &crate::updater::UpdateCoordinator,
    expected: &str,
) -> Result<Option<runtime::Session>, Error> {
    let session = runtime.reusable_session()?;
    if let Some(selected) = &session {
        admit(runtime, state, selected, expected)?;
    }
    Ok(session)
}
/// Synchronous, read-only admission; never acquires the install-held operation gate.
/// All short locks end before the caller performs a Native getter/show/focus.
pub(super) fn admit(
    runtime: &runtime::Runtime,
    state: &crate::updater::UpdateCoordinator,
    selected: &runtime::Session,
    expected: &str,
) -> Result<(), Error> {
    let _delivery = runtime.delivery.lock();
    let sessions = runtime.session.lock();
    let current = sessions.as_ref().ok_or_else(|| error("stale_candidate"))?;
    if runtime.stopped.load(Ordering::Acquire)
        || current.id != selected.id
        || current.label != selected.label
        || !Arc::ptr_eq(&current.alive, &selected.alive)
        || !current.alive.load(Ordering::Acquire)
        || current.closing.load(Ordering::Acquire)
        || current.candidate.as_deref() != Some(expected)
        || selected.candidate.as_deref() != Some(expected)
    {
        return Err(error("stale_candidate"));
    }
    super::expected_candidate(&state.view()?, Some(expected))?;
    Ok(())
}
#[cfg(test)]
#[path = "selection_tests.rs"]
mod tests;
