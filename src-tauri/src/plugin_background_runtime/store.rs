//! Bounded in-memory reservations and ready admissions for resident sessions.
use super::{
    dto::{Operation, Outcome, Receipt, Request},
    receipt::IntentState,
};
use parking_lot::Mutex;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Notify;
use tokio::time::Instant;

pub(super) const MAX_RESIDENT: usize = 2;

#[derive(Default)]
pub(super) struct Runtime(pub Mutex<Store>);

#[derive(Default)]
pub(super) struct Store {
    pub intents: HashMap<String, Arc<Intent>>,
    pub admissions: HashMap<(String, String), Admission>,
    pub closing: HashMap<(String, String), Request>,
    pub stopped: bool,
}

pub(super) struct Intent {
    pub window: String,
    pub request: Request,
    pub action: Value,
    pub created: Instant,
    pub state: Mutex<IntentState>,
    pub changed: Notify,
}

#[derive(Clone)]
pub(super) struct Admission {
    pub window: String,
    pub request: Request,
    pub run_id: String,
    pub action: Value,
}

impl Runtime {
    pub fn begin(
        &self,
        window: &str,
        request: Request,
        action: Value,
    ) -> Result<Arc<Intent>, String> {
        request.validate()?;
        if window != "main" || window.len() > 128 {
            return Err("ERR_PLUGIN_BACKGROUND_UI_REQUIRED".into());
        }

        let mut store = self.0.lock();
        if store.stopped || store.intents.contains_key(&request.request_id) {
            return Err("ERR_PLUGIN_BACKGROUND_REQUEST_CLOSED".into());
        }
        let key = (window.to_string(), request.session_id.clone());
        match request.operation {
            Operation::Start => {
                let plugin_has_admission = store
                    .admissions
                    .values()
                    .any(|admission| admission.request.plugin_id == request.plugin_id);
                let plugin_has_live_start = store.intents.values().any(|intent| {
                    intent.request.plugin_id == request.plugin_id
                        && intent.request.operation == Operation::Start
                        && intent.is_live()
                });
                let plugin_is_closing = store
                    .closing
                    .values()
                    .any(|closing| closing.plugin_id == request.plugin_id);
                let session_reserved = store.admissions.contains_key(&key)
                    || store.closing.contains_key(&key)
                    || store.intents.values().any(|intent| {
                        intent.request.session_id == request.session_id
                            && intent.request.operation == Operation::Start
                            && intent.is_live()
                    });
                if plugin_has_admission
                    || plugin_has_live_start
                    || plugin_is_closing
                    || session_reserved
                {
                    return Err("ERR_PLUGIN_BACKGROUND_SESSION_EXISTS".into());
                }

                let active = store.admissions.len()
                    + store.closing.len()
                    + store
                        .intents
                        .values()
                        .filter(|intent| {
                            intent.request.operation == Operation::Start && intent.is_live()
                        })
                        .count();
                if active >= MAX_RESIDENT {
                    return Err("ERR_PLUGIN_BACKGROUND_LIMIT".into());
                }
            }
            Operation::Stop => {
                let admission = store
                    .admissions
                    .get(&key)
                    .ok_or("ERR_PLUGIN_BACKGROUND_SESSION_NOT_READY")?;
                if admission.request.plugin_id != request.plugin_id
                    || admission.request.code_revision != request.code_revision
                {
                    return Err("ERR_PLUGIN_BACKGROUND_OWNER".into());
                }
                if store.intents.values().any(|intent| {
                    intent.request.session_id == request.session_id
                        && intent.request.operation == Operation::Stop
                        && intent.is_live()
                }) {
                    return Err("ERR_PLUGIN_BACKGROUND_REQUEST_CLOSED".into());
                }
            }
        }

        let intent = Arc::new(Intent {
            window: window.into(),
            request: request.clone(),
            action,
            created: Instant::now(),
            state: Mutex::new(IntentState::default()),
            changed: Notify::new(),
        });
        store.intents.insert(request.request_id, intent.clone());
        Ok(intent)
    }

    pub fn intent(&self, request_id: &str) -> Result<Arc<Intent>, String> {
        let intent = self
            .0
            .lock()
            .intents
            .get(request_id)
            .cloned()
            .ok_or("ERR_PLUGIN_BACKGROUND_REQUEST_CLOSED")?;
        if !intent.is_live() {
            return Err("ERR_PLUGIN_BACKGROUND_REQUEST_CLOSED".into());
        }
        Ok(intent)
    }

    pub fn complete(&self, intent: &Intent, receipt: Receipt) -> Result<(), String> {
        intent.complete(&intent.window, receipt)
    }

    pub fn finish(
        &self,
        intent: &Arc<Intent>,
        outcome: Outcome,
        run_id: &str,
    ) -> Result<(), String> {
        if !outcome.valid_for(intent.request.operation) {
            return Err("ERR_PLUGIN_BACKGROUND_RECEIPT".into());
        }
        let mut store = self.0.lock();
        if !store
            .intents
            .get(&intent.request.request_id)
            .is_some_and(|current| Arc::ptr_eq(current, intent))
            || intent.run_id().as_deref() != Some(run_id)
            || intent.state.lock().closed
        {
            return Err("ERR_PLUGIN_BACKGROUND_CANCELLED".into());
        }

        let key = (intent.window.clone(), intent.request.session_id.clone());
        match (intent.request.operation, outcome) {
            (Operation::Start, Outcome::Ready) => {
                if store.admissions.len() >= MAX_RESIDENT || store.admissions.contains_key(&key) {
                    return Err("ERR_PLUGIN_BACKGROUND_LIMIT".into());
                }
                if store
                    .admissions
                    .values()
                    .any(|admission| admission.request.plugin_id == intent.request.plugin_id)
                {
                    return Err("ERR_PLUGIN_BACKGROUND_SESSION_EXISTS".into());
                }
                store.admissions.insert(
                    key,
                    Admission {
                        window: intent.window.clone(),
                        request: intent.request.clone(),
                        run_id: run_id.into(),
                        action: intent.action.clone(),
                    },
                );
            }
            (Operation::Stop, Outcome::Closed) => {
                if store.admissions.remove(&key).is_none() {
                    return Err("ERR_PLUGIN_BACKGROUND_SESSION_NOT_READY".into());
                }
            }
            _ => {}
        }
        store.intents.remove(&intent.request.request_id);
        drop(store);
        intent.retire();
        Ok(())
    }

    #[cfg(test)]
    pub fn close_request(&self, request_id: &str) -> Option<Arc<Intent>> {
        let intent = self.0.lock().intents.remove(request_id)?;
        intent.close();
        Some(intent)
    }

    pub fn close_session(
        &self,
        window: &str,
        session_id: &str,
    ) -> (Option<Admission>, Vec<Arc<Intent>>) {
        let mut store = self.0.lock();
        let admission = store.admissions.remove(&(window.into(), session_id.into()));
        let key = (window.to_string(), session_id.to_string());
        if let Some(admission) = &admission {
            store.closing.insert(key.clone(), admission.request.clone());
        }
        let ids = store
            .intents
            .iter()
            .filter(|(_, intent)| {
                intent.window == window && intent.request.session_id == session_id
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let intents = ids
            .into_iter()
            .filter_map(|id| store.intents.remove(&id))
            .collect::<Vec<_>>();
        for intent in &intents {
            store.closing.insert(key.clone(), intent.request.clone());
        }
        drop(store);
        close_intents(&intents);
        (admission, intents)
    }

    pub fn close_plugin(&self, plugin: Option<&str>) -> (Vec<Admission>, Vec<Arc<Intent>>) {
        let mut store = self.0.lock();
        let keys = store
            .admissions
            .iter()
            .filter(|(_, admission)| plugin.is_none_or(|id| admission.request.plugin_id == id))
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let closing_admissions = keys
            .iter()
            .filter_map(|key| store.admissions.get(key).cloned())
            .collect::<Vec<_>>();
        for admission in &closing_admissions {
            store.closing.insert(
                (
                    admission.window.clone(),
                    admission.request.session_id.clone(),
                ),
                admission.request.clone(),
            );
        }
        let admissions = keys
            .into_iter()
            .filter_map(|key| store.admissions.remove(&key))
            .collect::<Vec<_>>();
        let ids = store
            .intents
            .iter()
            .filter(|(_, intent)| plugin.is_none_or(|id| intent.request.plugin_id == id))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let intents = ids
            .into_iter()
            .filter_map(|id| store.intents.remove(&id))
            .collect::<Vec<_>>();
        for intent in &intents {
            store.closing.insert(
                (intent.window.clone(), intent.request.session_id.clone()),
                intent.request.clone(),
            );
        }
        drop(store);
        close_intents(&intents);
        (admissions, intents)
    }

    pub fn close_window(&self, window: &str) -> (Vec<Admission>, Vec<Arc<Intent>>) {
        let mut store = self.0.lock();
        let keys = store
            .admissions
            .keys()
            .filter(|(owner, _)| owner == window)
            .cloned()
            .collect::<Vec<_>>();
        let closing_admissions = keys
            .iter()
            .filter_map(|key| store.admissions.get(key).cloned())
            .collect::<Vec<_>>();
        for admission in &closing_admissions {
            store.closing.insert(
                (
                    admission.window.clone(),
                    admission.request.session_id.clone(),
                ),
                admission.request.clone(),
            );
        }
        let admissions = keys
            .into_iter()
            .filter_map(|key| store.admissions.remove(&key))
            .collect::<Vec<_>>();
        let ids = store
            .intents
            .iter()
            .filter(|(_, intent)| intent.window == window)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let intents = ids
            .into_iter()
            .filter_map(|id| store.intents.remove(&id))
            .collect::<Vec<_>>();
        for intent in &intents {
            store.closing.insert(
                (intent.window.clone(), intent.request.session_id.clone()),
                intent.request.clone(),
            );
        }
        drop(store);
        close_intents(&intents);
        (admissions, intents)
    }

    pub fn admission(&self, window: &str, session_id: &str) -> Result<Admission, String> {
        self.0
            .lock()
            .admissions
            .get(&(window.into(), session_id.into()))
            .cloned()
            .ok_or_else(|| "ERR_PLUGIN_BACKGROUND_SESSION_NOT_READY".into())
    }

    pub fn closing_entries(
        &self,
        window: Option<&str>,
        plugin: Option<&str>,
        session_id: Option<&str>,
    ) -> Vec<(String, Request)> {
        self.0
            .lock()
            .closing
            .iter()
            .filter(|((owner, session), request)| {
                window.is_none_or(|expected| owner == expected)
                    && plugin.is_none_or(|expected| request.plugin_id == expected)
                    && session_id.is_none_or(|expected| session == expected)
            })
            .map(|((owner, _), request)| (owner.clone(), request.clone()))
            .collect()
    }

    pub fn remember_closing(&self, window: &str, request: &Request) {
        self.0
            .lock()
            .closing
            .insert((window.into(), request.session_id.clone()), request.clone());
    }

    pub fn forget_closing(&self, window: &str, session_id: &str) {
        self.0
            .lock()
            .closing
            .remove(&(window.into(), session_id.into()));
    }

    pub fn stop(&self) -> (Vec<Admission>, Vec<Arc<Intent>>) {
        let mut store = self.0.lock();
        store.stopped = true;
        let admissions = store
            .admissions
            .drain()
            .map(|(_, admission)| admission)
            .collect::<Vec<_>>();
        for admission in &admissions {
            store.closing.insert(
                (
                    admission.window.clone(),
                    admission.request.session_id.clone(),
                ),
                admission.request.clone(),
            );
        }
        let intents = store
            .intents
            .drain()
            .map(|(_, intent)| intent)
            .collect::<Vec<_>>();
        for intent in &intents {
            store.closing.insert(
                (intent.window.clone(), intent.request.session_id.clone()),
                intent.request.clone(),
            );
        }
        drop(store);
        close_intents(&intents);
        (admissions, intents)
    }
}

fn close_intents(intents: &[Arc<Intent>]) {
    for intent in intents {
        intent.close();
    }
}
