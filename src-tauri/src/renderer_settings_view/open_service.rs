//! Ownership of an individual open request and exact-generation cleanup.
use std::sync::{atomic::AtomicBool, Arc};

use serde_json::Value;
use tauri::{AppHandle, Wry};

use super::{
    cleanup,
    open_claims::{Adoption, ClaimId, ClosingTicket, SessionKey},
    session::SettingsViewRuntime,
};

pub(crate) struct OpenFlight {
    pub(crate) key: SessionKey,
    pub(crate) main: super::main_authority::CapturedMain,
    pub(crate) revoked: Arc<AtomicBool>,
    pub(crate) result: tokio::sync::watch::Sender<Option<Result<Value, String>>>,
    pub(crate) activity: tokio::sync::watch::Sender<u64>,
}

pub(crate) fn cleanup_tickets(app: &AppHandle<Wry>, tickets: Vec<ClosingTicket>) {
    for ClosingTicket(key) in tickets {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(runtime) = super::runtime(&app) else {
                return;
            };
            let current = runtime.current().ok().flatten();
            if let Some(session) = current.filter(|session| {
                session.id == key.id
                    && Arc::as_ptr(&session.revoked) as usize == key.revoked_identity
            }) {
                let _ = cleanup::close_session(&app, &session.id, "failed").await;
            }
            if runtime.current().ok().flatten().is_none_or(|session| {
                session.id != key.id
                    || Arc::as_ptr(&session.revoked) as usize != key.revoked_identity
            }) {
                runtime.retire_open(&key);
            }
        });
    }
}

pub(crate) struct RequestObserver {
    app: AppHandle<Wry>,
    runtime: Arc<SettingsViewRuntime>,
    claim: Option<ClaimId>,
}

impl RequestObserver {
    pub(crate) fn new(app: AppHandle<Wry>, claim: ClaimId) -> Result<Self, String> {
        let runtime = super::runtime(&app)?;
        Ok(Self {
            app,
            runtime,
            claim: Some(claim),
        })
    }

    pub(crate) fn claim(&self) -> ClaimId {
        self.claim.expect("live observer")
    }

    pub(crate) fn adopt(mut self, reason: Adoption) -> Result<(), String> {
        let claim = self.claim();
        self.runtime.adopt_open(claim, reason)?;
        self.claim = None;
        Ok(())
    }
}

impl Drop for RequestObserver {
    fn drop(&mut self) {
        if let Some(ticket) = self
            .claim
            .take()
            .and_then(|claim| self.runtime.abandon_open(claim))
        {
            cleanup_tickets(&self.app, vec![ticket]);
        }
    }
}

pub(crate) type ReadyEnvelope = super::open_coordination::Envelope<RequestObserver>;

impl super::open_coordination::Envelope<RequestObserver> {
    pub(crate) fn adopt_general(self) -> Result<Value, String> {
        let Self { receipt, observer } = self;
        observer.adopt(Adoption::GeneralReplyConsumed)?;
        Ok(receipt)
    }
}

pub(crate) async fn open_prepared(
    app: AppHandle<Wry>,
    db: Arc<atools_core::Database>,
    main: super::main_authority::CapturedMain,
    observer: RequestObserver,
) -> Result<ReadyEnvelope, String> {
    let runtime = Arc::clone(&observer.runtime);
    let (key, revoked, mut result, start) =
        runtime.join_open_flight(observer.claim(), main.clone())?;
    if start {
        let owner_main = main.clone();
        let owner_app = app.clone();
        let owner_runtime = Arc::clone(&runtime);
        let owner_key = key.clone();
        let guard_app = owner_app.clone();
        let guard = super::open_coordination::ConstructorGuard::new(move |result| {
            if let Some(ticket) = owner_runtime.finish_open_flight(&owner_key, result) {
                cleanup_tickets(&guard_app, vec![ticket]);
            }
        });
        let construct_key = key.clone();
        tauri::async_runtime::spawn(async move {
            let mut guard = guard;
            let outcome =
                super::open_native::construct(owner_app, db, owner_main, construct_key, revoked)
                    .await;
            guard.finish(outcome);
        });
    }
    loop {
        let current = result.borrow().clone();
        if let Some(result) = current {
            let receipt = result?;
            if !start {
                super::open_native::focus_ready(
                    &app,
                    Arc::clone(&runtime),
                    main.clone(),
                    key.clone(),
                )
                .await?;
            }
            let receiver = super::open_coordination::send_envelope(receipt, observer);
            return receiver
                .await
                .map_err(|_| "Settings open receipt was canceled".into());
        }
        result
            .changed()
            .await
            .map_err(|_| "Settings constructor stopped before replying".to_owned())?;
    }
}
