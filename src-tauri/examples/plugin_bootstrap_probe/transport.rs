//! No real capability: exercise the production HTTP parser/CORS and record entry.
use async_trait::async_trait;
use atools_lib::plugin_origin_transport::{OriginPolicy, RequestHandler, TransportObservation};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

struct Session {
    id: &'static str,
    token: String,
    policy: OriginPolicy,
    active: AtomicBool,
}
pub struct Router {
    sessions: Vec<Session>,
    entered: Mutex<Vec<Value>>,
    revoked_requests: AtomicUsize,
    preflight_accepted: AtomicUsize,
    origin_rejected: AtomicUsize,
    authentication_rejected: AtomicUsize,
}
impl Router {
    pub fn new(run_id: &str) -> Result<Arc<Self>, String> {
        let suffix = run_id.replace('-', "");
        let mut sessions = Vec::new();
        for id in ["a", "b"] {
            sessions.push(Session {
                id,
                token: format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                ),
                policy: OriginPolicy::exact(&format!("atools-origin://{id}-{suffix}.localhost"))?,
                active: AtomicBool::new(true),
            });
        }
        Ok(Arc::new(Self {
            sessions,
            entered: Mutex::new(Vec::new()),
            revoked_requests: AtomicUsize::new(0),
            preflight_accepted: AtomicUsize::new(0),
            origin_rejected: AtomicUsize::new(0),
            authentication_rejected: AtomicUsize::new(0),
        }))
    }
    pub fn endpoint(&self, origin: &str, id: &str) -> String {
        let session = self
            .sessions
            .iter()
            .find(|session| session.id == id)
            .unwrap();
        format!("{origin}/host/{}", session.token)
    }
    pub fn revoke(&self, id: &str) -> bool {
        self.sessions
            .iter()
            .find(|session| session.id == id)
            .is_some_and(|session| session.active.swap(false, Ordering::SeqCst))
    }
    pub fn snapshot(&self) -> Value {
        json!({"entered":self.entered.lock().clone(),"revokedRequestCount":self.revoked_requests.load(Ordering::SeqCst),
            "preflightAccepted":self.preflight_accepted.load(Ordering::SeqCst),"originRejected":self.origin_rejected.load(Ordering::SeqCst),
            "authenticationRejected":self.authentication_rejected.load(Ordering::SeqCst)})
    }
    pub fn contains_credential(&self, text: &str) -> bool {
        self.sessions
            .iter()
            .any(|session| text.contains(&session.token))
    }
}
#[async_trait]
impl RequestHandler for Router {
    fn observe_transport(&self, event: TransportObservation) {
        let counter = match event {
            TransportObservation::PreflightAccepted => Some(&self.preflight_accepted),
            TransportObservation::OriginRejected => Some(&self.origin_rejected),
            TransportObservation::AuthenticationRejected => Some(&self.authentication_rejected),
            _ => None,
        };
        if let Some(counter) = counter {
            counter.fetch_add(1, Ordering::SeqCst);
        }
    }
    fn authenticated(&self, token: &str) -> bool {
        let Some(session) = self.sessions.iter().find(|session| session.token == token) else {
            return false;
        };
        if session.active.load(Ordering::SeqCst) {
            true
        } else {
            self.revoked_requests.fetch_add(1, Ordering::SeqCst);
            false
        }
    }
    fn origin_policy(&self, token: &str) -> OriginPolicy {
        self.sessions
            .iter()
            .find(|session| session.token == token)
            .map(|session| session.policy.clone())
            .unwrap_or(OriginPolicy::Opaque)
    }
    async fn handle(&self, token: &str, request: Value) -> Result<Value, String> {
        let session = self
            .sessions
            .iter()
            .find(|session| session.token == token)
            .ok_or("Unknown synthetic session")?;
        let id = request["id"].as_str().unwrap_or("other");
        let phase = request["phase"].as_str().unwrap_or("other");
        let safe_id = if matches!(id, "a" | "b") { id } else { "other" };
        let safe_phase = if matches!(phase, "sync" | "async" | "foreign" | "opaque" | "revoked") {
            phase
        } else {
            "other"
        };
        let mut entries = self.entered.lock();
        if entries.len() < 32 {
            entries.push(json!({"session":session.id,"id":safe_id,"phase":safe_phase}));
        }
        if !session.active.load(Ordering::SeqCst)
            || id != session.id
            || !matches!(phase, "sync" | "async")
        {
            return Err("Unexpected synthetic command entry".into());
        }
        Ok(json!({"id":id,"phase":phase}))
    }
}
