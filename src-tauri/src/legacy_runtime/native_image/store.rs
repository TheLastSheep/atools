use super::SourceFormat;
use super::{EngineLimits, ImageDescriptor, NativeImageError};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use uuid::Uuid;

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub(super) struct BudgetLedger {
    state: Mutex<LedgerState>,
}

#[derive(Default)]
struct LedgerState {
    global_bytes: usize,
    global_reserved: usize,
    sessions: HashMap<u64, SessionBudget>,
}

#[derive(Clone, Default)]
struct SessionBudget {
    bytes: usize,
    reserved: usize,
    handles: usize,
    unique_sources: usize,
    open_reservations: usize,
    closed: bool,
}

pub(crate) struct NativeImageSession {
    inner: Arc<SessionInner>,
}

struct SessionInner {
    id: u64,
    ledger: Arc<BudgetLedger>,
    sources: Mutex<HashMap<[u8; 32], Arc<NativeImageSource>>>,
    handles: Mutex<HashMap<String, Arc<NativeImageSnapshot>>>,
}

pub(super) struct NativeImageSource {
    pub(super) bytes: Box<[u8]>,
    pub(super) format: SourceFormat,
    pub(super) width: u32,
    pub(super) height: u32,
    _lease: SourceLease,
}

pub(crate) struct NativeImageSnapshot {
    pub(super) handle_id: String,
    pub(super) source: Arc<NativeImageSource>,
    _lease: HandleLease,
}

struct SourceLease {
    ledger: Arc<BudgetLedger>,
    session_id: u64,
    bytes: usize,
}

struct HandleLease {
    ledger: Arc<BudgetLedger>,
    session_id: u64,
}

pub(crate) struct OpenReservation {
    session: Arc<SessionInner>,
    max_bytes: usize,
    exact_bytes: Option<usize>,
    active: bool,
}

impl BudgetLedger {
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    pub(super) fn smoke_counts(&self) -> (usize, usize, usize, usize, usize, usize) {
        let state = lock(&self.state);
        state.sessions.values().fold(
            (
                state.global_bytes,
                state.global_reserved,
                0usize,
                0usize,
                0usize,
                state.sessions.len(),
            ),
            |(bytes, reserved, handles, sources, opens, sessions), session| {
                (
                    bytes,
                    reserved,
                    handles.saturating_add(session.handles),
                    sources.saturating_add(session.unique_sources),
                    opens.saturating_add(session.open_reservations),
                    sessions,
                )
            },
        )
    }
}

impl NativeImageSession {
    pub(super) fn new(ledger: Arc<BudgetLedger>) -> Self {
        let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
        lock(&ledger.state)
            .sessions
            .insert(id, SessionBudget::default());
        Self {
            inner: Arc::new(SessionInner {
                id,
                ledger,
                sources: Mutex::new(HashMap::new()),
                handles: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub(super) fn reserve_open(
        &self,
        requested_bytes: Option<usize>,
        exact_bytes: Option<usize>,
        limits: EngineLimits,
    ) -> Result<OpenReservation, NativeImageError> {
        let mut state = lock(&self.inner.ledger.state);
        let Some(existing) = state.sessions.get(&self.inner.id) else {
            return Err(NativeImageError::SessionClosed);
        };
        if existing.closed {
            return Err(NativeImageError::SessionClosed);
        }
        if existing.open_reservations >= limits.max_open_per_session {
            return Err(NativeImageError::OpenBusy);
        }
        if existing.handles + existing.open_reservations >= limits.max_handles_per_session {
            return Err(NativeImageError::BudgetExceeded);
        }
        let session_available = limits
            .max_session_bytes
            .saturating_sub(existing.bytes + existing.reserved);
        let global_available = limits
            .max_global_bytes
            .saturating_sub(state.global_bytes + state.global_reserved);
        let reservation_bytes = match requested_bytes {
            Some(requested) if requested > 0 && requested <= limits.max_source_bytes => requested,
            Some(_) => return Err(NativeImageError::InvalidRequest),
            None => limits
                .max_source_bytes
                .min(session_available)
                .min(global_available),
        };
        if reservation_bytes == 0
            || reservation_bytes > session_available
            || reservation_bytes > global_available
        {
            return Err(NativeImageError::BudgetExceeded);
        }
        {
            let session = state
                .sessions
                .get_mut(&self.inner.id)
                .expect("checked session");
            session.reserved += reservation_bytes;
            session.open_reservations += 1;
        }
        state.global_reserved += reservation_bytes;
        Ok(OpenReservation {
            session: Arc::clone(&self.inner),
            max_bytes: reservation_bytes,
            exact_bytes,
            active: true,
        })
    }

    pub(super) fn commit_open(
        &self,
        mut reservation: OpenReservation,
        bytes: Vec<u8>,
        validated: (SourceFormat, u32, u32),
    ) -> Result<ImageDescriptor, NativeImageError> {
        if !Arc::ptr_eq(&reservation.session, &self.inner) || !reservation.active {
            return Err(NativeImageError::InvalidRequest);
        }
        let byte_count = bytes.len();
        if byte_count == 0
            || byte_count > reservation.max_bytes
            || reservation
                .exact_bytes
                .is_some_and(|expected| expected != byte_count)
        {
            return Err(NativeImageError::SourceTooLarge);
        }
        let source_key: [u8; 32] = Sha256::digest(&bytes).into();
        let snapshot = {
            let mut ledger = lock(&self.inner.ledger.state);
            let Some(existing) = ledger.sessions.get(&self.inner.id) else {
                return Err(NativeImageError::SessionClosed);
            };
            if existing.closed {
                return Err(NativeImageError::SessionClosed);
            }
            let mut sources = lock(&self.inner.sources);
            let mut handles = lock(&self.inner.handles);
            let handle_id = loop {
                let candidate = Uuid::new_v4().to_string();
                if !handles.contains_key(&candidate) {
                    break candidate;
                }
            };
            let existing_source = sources.get(&source_key).cloned();
            if existing_source
                .as_ref()
                .is_some_and(|source| source.bytes.as_ref() != bytes.as_slice())
            {
                // A digest collision must fail closed rather than alias bytes.
                return Err(NativeImageError::InvalidImage);
            }
            let (format, width, height) = validated;
            let source = if let Some(source) = existing_source {
                if (source.format, source.width, source.height) != (format, width, height) {
                    return Err(NativeImageError::InvalidImage);
                }
                source
            } else {
                Arc::new(NativeImageSource {
                    bytes: bytes.into_boxed_slice(),
                    format,
                    width,
                    height,
                    _lease: SourceLease {
                        ledger: Arc::clone(&self.inner.ledger),
                        session_id: self.inner.id,
                        bytes: byte_count,
                    },
                })
            };
            let is_new_source = !sources.contains_key(&source_key);
            {
                let budget = ledger
                    .sessions
                    .get_mut(&self.inner.id)
                    .expect("checked session");
                budget.reserved = budget.reserved.saturating_sub(reservation.max_bytes);
                budget.open_reservations = budget.open_reservations.saturating_sub(1);
                budget.handles += 1;
                if is_new_source {
                    budget.bytes += byte_count;
                    budget.unique_sources += 1;
                }
            }
            ledger.global_reserved = ledger.global_reserved.saturating_sub(reservation.max_bytes);
            if is_new_source {
                ledger.global_bytes += byte_count;
                sources.insert(source_key, Arc::clone(&source));
            }
            reservation.active = false;
            let source = Arc::new(NativeImageSnapshot {
                handle_id: handle_id.clone(),
                source,
                _lease: HandleLease {
                    ledger: Arc::clone(&self.inner.ledger),
                    session_id: self.inner.id,
                },
            });
            handles.insert(handle_id, Arc::clone(&source));
            source
        };
        let descriptor = ImageDescriptor {
            handle_id: snapshot.handle_id.clone(),
            format: snapshot.source.format,
            width: snapshot.source.width,
            height: snapshot.source.height,
        };
        Ok(descriptor)
    }

    pub(super) fn snapshot(
        &self,
        handle_id: &str,
    ) -> Result<Arc<NativeImageSnapshot>, NativeImageError> {
        if self.is_closed() {
            return Err(NativeImageError::SessionClosed);
        }
        lock(&self.inner.handles)
            .get(handle_id)
            .cloned()
            .ok_or(NativeImageError::HandleUnavailable)
    }

    pub(super) fn is_closed(&self) -> bool {
        lock(&self.inner.ledger.state)
            .sessions
            .get(&self.inner.id)
            .map_or(true, |state| state.closed)
    }

    pub(super) fn belongs_to(&self, ledger: &Arc<BudgetLedger>) -> bool {
        Arc::ptr_eq(&self.inner.ledger, ledger)
    }

    pub(crate) fn close(&self) {
        let (released_handles, released_sources) = {
            let mut ledger = lock(&self.inner.ledger.state);
            if let Some(state) = ledger.sessions.get_mut(&self.inner.id) {
                state.closed = true;
            }
            let mut sources = lock(&self.inner.sources);
            let mut handles = lock(&self.inner.handles);
            let released_handles = handles.drain().map(|(_, value)| value).collect::<Vec<_>>();
            let released_sources = sources.drain().map(|(_, value)| value).collect::<Vec<_>>();
            (released_handles, released_sources)
        };
        drop(released_handles);
        drop(released_sources);
        cleanup_empty_session(&self.inner.ledger, self.inner.id);
    }

    #[cfg(test)]
    pub(super) fn accounting(&self) -> (usize, usize, usize, usize, usize, usize) {
        let state = lock(&self.inner.ledger.state);
        let session = state
            .sessions
            .get(&self.inner.id)
            .cloned()
            .unwrap_or_default();
        (
            session.bytes,
            session.reserved,
            state.global_bytes,
            state.global_reserved,
            session.handles,
            session.unique_sources,
        )
    }
}

impl OpenReservation {
    pub(crate) fn max_bytes(&self) -> usize {
        self.max_bytes
    }

    pub(super) fn is_for(&self, session: &NativeImageSession) -> bool {
        Arc::ptr_eq(&self.session, &session.inner) && self.active
    }
}

impl Drop for OpenReservation {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut state = lock(&self.session.ledger.state);
        {
            if let Some(session) = state.sessions.get_mut(&self.session.id) {
                session.reserved = session.reserved.saturating_sub(self.max_bytes);
                session.open_reservations = session.open_reservations.saturating_sub(1);
            }
        }
        state.global_reserved = state.global_reserved.saturating_sub(self.max_bytes);
        self.active = false;
        cleanup_empty_session_locked(&mut state, self.session.id);
    }
}

impl Drop for SourceLease {
    fn drop(&mut self) {
        let mut state = lock(&self.ledger.state);
        {
            if let Some(session) = state.sessions.get_mut(&self.session_id) {
                session.bytes = session.bytes.saturating_sub(self.bytes);
                session.unique_sources = session.unique_sources.saturating_sub(1);
            }
        }
        state.global_bytes = state.global_bytes.saturating_sub(self.bytes);
        cleanup_empty_session_locked(&mut state, self.session_id);
    }
}

impl Drop for HandleLease {
    fn drop(&mut self) {
        let mut state = lock(&self.ledger.state);
        if let Some(session) = state.sessions.get_mut(&self.session_id) {
            session.handles = session.handles.saturating_sub(1);
        }
        cleanup_empty_session_locked(&mut state, self.session_id);
    }
}

impl Drop for SessionInner {
    fn drop(&mut self) {
        let mut state = lock(&self.ledger.state);
        if let Some(session) = state.sessions.get_mut(&self.id) {
            session.closed = true;
        }
        // The handle map drops after this method. Its final SnapshotLease then
        // releases compressed-byte accounting and removes this closed record.
        cleanup_empty_session_locked(&mut state, self.id);
    }
}

fn cleanup_empty_session(ledger: &BudgetLedger, id: u64) {
    let mut state = lock(&ledger.state);
    cleanup_empty_session_locked(&mut state, id);
}

fn cleanup_empty_session_locked(state: &mut LedgerState, id: u64) {
    let remove = state.sessions.get(&id).is_some_and(|session| {
        session.closed
            && session.bytes == 0
            && session.reserved == 0
            && session.handles == 0
            && session.unique_sources == 0
            && session.open_reservations == 0
    });
    if remove {
        state.sessions.remove(&id);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
