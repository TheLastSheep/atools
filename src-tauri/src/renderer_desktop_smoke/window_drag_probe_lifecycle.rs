use parking_lot::Mutex;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Observation {
    pub(super) document_generation: u64,
    pub(super) page_load_starts: u64,
    pub(super) page_load_finishes: u64,
    pub(super) document_id: String,
}

struct Inner {
    observation: Observation,
    navigation_authorized: bool,
    page_started: bool,
    page_finished: bool,
    initial_probe_injected: bool,
    resume_probe_injected: bool,
    protocol_rejected: bool,
}

pub(super) struct DocumentLifecycle(Mutex<Inner>);

impl DocumentLifecycle {
    pub(super) fn new() -> Self {
        Self(Mutex::new(Inner {
            observation: Observation {
                document_generation: 0,
                page_load_starts: 0,
                page_load_finishes: 0,
                document_id: new_document_id(),
            },
            navigation_authorized: false,
            page_started: false,
            page_finished: false,
            initial_probe_injected: false,
            resume_probe_injected: false,
            protocol_rejected: false,
        }))
    }

    pub(super) fn snapshot(&self) -> Observation {
        self.0.lock().observation.clone()
    }

    pub(super) fn document_id(&self) -> String {
        self.0.lock().observation.document_id.clone()
    }

    pub(super) fn authorize_navigation(&self) -> Result<(), &'static str> {
        let mut inner = self.0.lock();
        if inner.protocol_rejected {
            return Err("window-drag-page-load-protocol-poisoned");
        }
        if inner.observation.document_generation != 0
            || inner.navigation_authorized
            || !inner.initial_probe_injected
            || inner.observation.page_load_starts != 0
            || inner.observation.page_load_finishes != 0
        {
            inner.protocol_rejected = true;
            return Err("window-drag-navigation-protocol-rejected");
        }
        inner.navigation_authorized = true;
        Ok(())
    }

    pub(super) fn observe_page_load_started(&self) -> Result<(), &'static str> {
        let mut inner = self.0.lock();
        if inner.protocol_rejected {
            return Err("window-drag-page-load-protocol-poisoned");
        }
        if !inner.navigation_authorized {
            inner.protocol_rejected = true;
            return Err("window-drag-unrequested-page-load-start");
        }
        if inner.observation.document_generation != 0
            || inner.page_started
            || inner.observation.page_load_starts != 0
        {
            inner.protocol_rejected = true;
            return Err("window-drag-page-load-start-protocol-rejected");
        }
        inner.page_started = true;
        inner.observation.page_load_starts = 1;
        Ok(())
    }

    pub(super) fn observe_page_load_finished(&self) -> Result<Observation, &'static str> {
        let mut inner = self.0.lock();
        if inner.protocol_rejected {
            return Err("window-drag-page-load-protocol-poisoned");
        }
        if !inner.navigation_authorized {
            inner.protocol_rejected = true;
            return Err("window-drag-unrequested-page-load-finish");
        }
        if inner.observation.document_generation != 0
            || !inner.page_started
            || inner.page_finished
            || inner.observation.page_load_finishes != 0
        {
            inner.protocol_rejected = true;
            return Err("window-drag-page-load-finish-protocol-rejected");
        }
        inner.page_finished = true;
        inner.observation.page_load_finishes = 1;
        inner.observation.document_generation = 1;
        inner.observation.document_id = new_document_id();
        Ok(inner.observation.clone())
    }

    pub(super) fn mark_initial_probe_injected(&self) -> bool {
        let mut inner = self.0.lock();
        if inner.observation.document_generation != 0 || inner.initial_probe_injected {
            return false;
        }
        inner.initial_probe_injected = true;
        true
    }

    pub(super) fn mark_resume_probe_injected(&self) -> bool {
        let mut inner = self.0.lock();
        if !inner.navigation_authorized
            || !inner.initial_probe_injected
            || inner.protocol_rejected
            || inner.observation.document_generation != 1
            || !inner.page_started
            || !inner.page_finished
            || inner.resume_probe_injected
        {
            return false;
        }
        inner.resume_probe_injected = true;
        true
    }
}

#[cfg(test)]
#[path = "window_drag_probe_lifecycle_tests.rs"]
mod tests;

fn new_document_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
