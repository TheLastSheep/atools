use super::{StageObservation, FOCUS_TARGET_LABEL, MAX_WINDOW_EVENTS};
use serde_json::{json, Value};
use std::time::Instant;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindowEventObservation {
    label: &'static str,
    event: &'static str,
    elapsed_ms: f64,
}

#[derive(Default)]
pub(in crate::renderer_desktop_smoke) struct EventLedger {
    started: Option<Instant>,
    entries: Vec<WindowEventObservation>,
    total: u32,
    overflow: u32,
}

impl EventLedger {
    pub(in crate::renderer_desktop_smoke) fn start(&mut self, started: Instant) {
        self.started = Some(started);
    }

    pub(in crate::renderer_desktop_smoke) fn record(
        &mut self,
        label: &'static str,
        event: &'static str,
    ) {
        self.total = self.total.saturating_add(1);
        if self.entries.len() >= MAX_WINDOW_EVENTS {
            self.overflow = self.overflow.saturating_add(1);
            return;
        }
        let elapsed_ms = self
            .started
            .map(|started| started.elapsed().as_secs_f64() * 1000.0)
            .unwrap_or_default();
        self.entries.push(WindowEventObservation {
            label,
            event,
            elapsed_ms,
        });
    }

    pub(super) fn contains(&self, label: &str, event: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.label == label && entry.event == event)
    }

    pub(in crate::renderer_desktop_smoke) fn count(&self, label: &str, event: &str) -> u32 {
        self.entries
            .iter()
            .filter(|entry| entry.label == label && entry.event == event)
            .count() as u32
    }

    fn contains_between(&self, label: &str, event: &str, after_ms: f64, through_ms: f64) -> bool {
        self.entries.iter().any(|entry| {
            entry.label == label
                && entry.event == event
                && entry.elapsed_ms >= after_ms
                && entry.elapsed_ms <= through_ms
        })
    }

    pub(in crate::renderer_desktop_smoke) fn snapshot(&self) -> Value {
        json!({
            "events": &self.entries,
            "total": self.total,
            "overflow": self.overflow,
            "maxEvents": MAX_WINDOW_EVENTS,
            "scope": "Only main and this smoke process renderer-smoke-focus-target focus, close, and destroy events"
        })
    }
}

pub(in crate::renderer_desktop_smoke) fn window_event_flow_errors(
    stages: &[StageObservation],
    events: &EventLedger,
) -> Vec<&'static str> {
    let mut errors = Vec::new();
    if events.overflow > 0 {
        errors.push("window-event-observation-log-overflowed");
    }
    let find = |name| stages.iter().find(|stage| stage.stage == name);
    let between = |label,
                   event,
                   start: Option<&StageObservation>,
                   end: Option<&StageObservation>| match (start, end) {
        (Some(start), Some(end)) => {
            events.contains_between(label, event, start.elapsed_ms, end.elapsed_ms)
        }
        _ => false,
    };
    if !between("main", "focus-lost", find("prepared"), find("hidden")) {
        errors.push("manual-hide-did-not-produce-main-focus-loss-event");
    }
    if !between("main", "focus-gained", find("hidden"), find("reshown")) {
        errors.push("manual-reshow-did-not-produce-main-focus-gain-event");
    }
    if !between(
        FOCUS_TARGET_LABEL,
        "focus-gained",
        find("prepared-blur"),
        find("blur-hidden"),
    ) || !between(
        "main",
        "focus-lost",
        find("prepared-blur"),
        find("blur-hidden"),
    ) {
        errors.push("auxiliary-window-did-not-produce-real-main-blur-events");
    }
    if !between(
        "main",
        "focus-gained",
        find("blur-hidden"),
        find("blur-return"),
    ) {
        errors.push("blur-return-did-not-produce-main-focus-gain-event");
    }
    if !between(
        FOCUS_TARGET_LABEL,
        "focus-gained",
        find("disposed"),
        find("disposed-return"),
    ) || !between(
        "main",
        "focus-lost",
        find("disposed"),
        find("disposed-return"),
    ) || !between(
        "main",
        "focus-gained",
        find("disposed"),
        find("disposed-return"),
    ) {
        errors.push("post-dispose-focus-cycle-was-not-observed");
    }
    if events.count(FOCUS_TARGET_LABEL, "destroyed") < 2 {
        errors.push("auxiliary-focus-window-destroy-events-incomplete");
    }
    errors
}
