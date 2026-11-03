use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub(crate) const WINDOW_TIMEOUT_SECS: u64 = 20;

const REPORT_STAGES: &[&str] = &[
    "window_open",
    "child_ready",
    "windowproxy_same_origin",
    "iframe_element_access",
    "iframe_load_observed",
    "iframe_true_source",
    "iframe_opaque_origin",
    "iframe_tauri_internals_denied",
    "iframe_self_tauri_unavailable",
    "opaque_dom_access_denied",
    "messageport_typedarray_roundtrip",
    "native_window_properties",
    "passed",
    "failed",
];

const REQUIRED_STAGES: &[&str] = &[
    "window_open",
    "child_ready",
    "windowproxy_same_origin",
    "iframe_element_access",
    "iframe_load_observed",
    "iframe_true_source",
    "iframe_opaque_origin",
    "iframe_tauri_internals_denied",
    "iframe_self_tauri_unavailable",
    "opaque_dom_access_denied",
    "messageport_typedarray_roundtrip",
    "native_window_properties",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeEvent {
    pub(crate) stage: String,
    pub(crate) ok: bool,
    pub(crate) details: Value,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Verdict {
    Passed,
    Failed,
    Timeout,
}

impl Verdict {
    fn status(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Timeout => "timeout",
        }
    }

    fn exit_code(self) -> i32 {
        match self {
            Self::Passed => 0,
            Self::Failed | Self::Timeout => 1,
        }
    }
}

pub(crate) struct Completion {
    pub(crate) status: &'static str,
    pub(crate) last_stage: String,
    pub(crate) events: Vec<ProbeEvent>,
    pub(crate) exit_code: i32,
}

pub(crate) struct RecordOutcome {
    pub(crate) accepted: bool,
    pub(crate) completion: Option<Completion>,
}

pub(crate) struct NoteOutcome {
    pub(crate) accepted: bool,
    pub(crate) completion: Option<Completion>,
}

struct ReportState {
    deadline: Instant,
    last_stage: String,
    events: Vec<ProbeEvent>,
    verdict: Option<Verdict>,
}

pub(crate) struct ProbeState {
    nonce: String,
    report: Mutex<ReportState>,
}

impl ProbeState {
    pub(crate) fn new(nonce: String) -> Self {
        Self::with_deadline(
            nonce,
            Instant::now() + Duration::from_secs(WINDOW_TIMEOUT_SECS),
        )
    }

    fn with_deadline(nonce: String, deadline: Instant) -> Self {
        Self {
            nonce,
            report: Mutex::new(ReportState {
                deadline,
                last_stage: "startup".into(),
                events: Vec::new(),
                verdict: None,
            }),
        }
    }

    pub(crate) fn matches_nonce(&self, nonce: &str) -> bool {
        self.nonce == nonce
    }

    pub(crate) fn deadline(&self) -> Instant {
        self.report.lock().unwrap().deadline
    }

    /// Update progress under the same lock used by reports and terminal claims.
    /// If the deadline already elapsed, atomically claim timeout instead.
    pub(crate) fn note(&self, stage: &str) -> NoteOutcome {
        let mut report = self.report.lock().unwrap();
        Self::note_locked(&mut report, stage, Instant::now())
    }

    fn note_locked(report: &mut ReportState, stage: &str, now: Instant) -> NoteOutcome {
        if report.verdict.is_some() {
            return NoteOutcome {
                accepted: false,
                completion: None,
            };
        }
        if now >= report.deadline {
            return NoteOutcome {
                accepted: false,
                completion: Some(complete(report, Verdict::Timeout)),
            };
        }
        report.last_stage = stage.to_owned();
        NoteOutcome {
            accepted: true,
            completion: None,
        }
    }

    pub(crate) fn record(
        &self,
        stage: &str,
        ok: bool,
        details: Value,
    ) -> Result<RecordOutcome, String> {
        let mut report = self.report.lock().unwrap();
        Self::record_locked(&mut report, stage, ok, details, Instant::now(), true)
    }

    #[cfg(test)]
    fn record_at(
        &self,
        stage: &str,
        ok: bool,
        details: Value,
        now: Instant,
    ) -> Result<RecordOutcome, String> {
        let mut report = self.report.lock().unwrap();
        Self::record_locked(&mut report, stage, ok, details, now, false)
    }

    fn record_locked(
        report: &mut ReportState,
        stage: &str,
        ok: bool,
        details: Value,
        now: Instant,
        check_commit_time: bool,
    ) -> Result<RecordOutcome, String> {
        if report.verdict.is_some() {
            return Err("Probe already reached a terminal verdict".into());
        }
        if now >= report.deadline {
            let completion = complete(report, Verdict::Timeout);
            return Ok(RecordOutcome {
                accepted: false,
                completion: Some(completion),
            });
        }
        if !REPORT_STAGES.contains(&stage) {
            return Err("Unknown probe stage".into());
        }

        if stage == "passed" {
            let missing: Vec<_> = REQUIRED_STAGES
                .iter()
                .filter(|required| {
                    !report
                        .events
                        .iter()
                        .any(|event| event.stage == **required && event.ok)
                })
                .copied()
                .collect();
            let prior_failure = report.events.iter().any(|event| !event.ok);
            if !ok || prior_failure || !missing.is_empty() {
                let failure = json!({
                    "ok": false,
                    "stage": "passed",
                    "reason": if prior_failure { "a failure was already recorded" }
                        else if !missing.is_empty() { "required evidence is missing" }
                        else { "passed report must be successful" },
                    "missingStages": missing,
                });
                push(report, "failed", false, failure);
                let completion = complete(report, Verdict::Failed);
                return Ok(RecordOutcome {
                    accepted: false,
                    completion: Some(completion),
                });
            }
            if check_commit_time && Instant::now() >= report.deadline {
                let completion = complete(report, Verdict::Timeout);
                return Ok(RecordOutcome {
                    accepted: false,
                    completion: Some(completion),
                });
            }
            push(report, stage, true, details);
            return Ok(RecordOutcome {
                accepted: true,
                completion: Some(complete(report, Verdict::Passed)),
            });
        }

        if check_commit_time && Instant::now() >= report.deadline {
            let completion = complete(report, Verdict::Timeout);
            return Ok(RecordOutcome {
                accepted: false,
                completion: Some(completion),
            });
        }
        push(report, stage, ok, details);
        if stage == "failed" || !ok {
            return Ok(RecordOutcome {
                accepted: false,
                completion: Some(complete(report, Verdict::Failed)),
            });
        }
        Ok(RecordOutcome {
            accepted: true,
            completion: None,
        })
    }

    /// Internal host failures share the same terminal transition lock as reports.
    pub(crate) fn fail_internal(&self, stage: &str, details: Value) -> Option<Completion> {
        let mut report = self.report.lock().unwrap();
        Self::fail_internal_locked(&mut report, stage, details, Instant::now())
    }

    fn fail_internal_locked(
        report: &mut ReportState,
        stage: &str,
        details: Value,
        now: Instant,
    ) -> Option<Completion> {
        if report.verdict.is_some() {
            return None;
        }
        if now >= report.deadline {
            return Some(complete(report, Verdict::Timeout));
        }
        push(report, stage, false, details);
        Some(complete(report, Verdict::Failed))
    }

    pub(crate) fn timeout(&self) -> Option<Completion> {
        let mut report = self.report.lock().unwrap();
        Self::timeout_locked(&mut report, Instant::now())
    }

    #[cfg(test)]
    fn timeout_at(&self, now: Instant) -> Option<Completion> {
        let mut report = self.report.lock().unwrap();
        Self::timeout_locked(&mut report, now)
    }

    fn timeout_locked(report: &mut ReportState, now: Instant) -> Option<Completion> {
        if report.verdict.is_some() || now < report.deadline {
            return None;
        }
        Some(complete(report, Verdict::Timeout))
    }
}

fn push(report: &mut ReportState, stage: &str, ok: bool, details: Value) {
    report.last_stage = stage.to_owned();
    report.events.push(ProbeEvent {
        stage: stage.to_owned(),
        ok,
        details,
    });
}

fn complete(report: &mut ReportState, verdict: Verdict) -> Completion {
    let prior_stage = report.last_stage.clone();
    report.verdict = Some(verdict);
    if verdict == Verdict::Timeout {
        report.events.push(ProbeEvent {
            stage: "timeout".into(),
            ok: false,
            details: json!({
                "ok": false,
                "timeoutSeconds": WINDOW_TIMEOUT_SECS,
                "lastStage": prior_stage,
            }),
        });
        report.last_stage = prior_stage;
    } else {
        report.last_stage = verdict.status().to_owned();
    }
    Completion {
        status: verdict.status(),
        last_stage: report.last_stage.clone(),
        events: report.events.clone(),
        exit_code: verdict.exit_code(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_state() -> (ProbeState, Instant) {
        let now = Instant::now();
        (
            ProbeState::with_deadline("test-nonce".into(), now + Duration::from_secs(20)),
            now,
        )
    }

    fn record_ok(state: &ProbeState, stage: &str, now: Instant) -> RecordOutcome {
        state
            .record_at(stage, true, json!({"ok":true}), now)
            .unwrap()
    }

    #[test]
    fn late_pass_after_timeout_cannot_turn_timeout_green() {
        let (state, now) = open_state();
        let deadline = state.deadline();
        let timed_out = state.timeout_at(deadline).unwrap();
        assert_eq!(timed_out.status, "timeout");
        assert_eq!(timed_out.last_stage, "startup");
        assert!(state
            .record_at(
                "passed",
                true,
                json!({"ok":true}),
                now + Duration::from_secs(21)
            )
            .is_err());
    }

    #[test]
    fn pass_at_or_after_deadline_times_out_without_waiting_for_watchdog() {
        let (state, _) = open_state();
        let deadline = state.deadline();
        let late = state
            .record_at("passed", true, json!({"ok":true}), deadline)
            .unwrap();
        assert!(!late.accepted);
        let completion = late.completion.unwrap();
        assert_eq!(completion.status, "timeout");
        assert_eq!(completion.last_stage, "startup");
    }

    #[test]
    fn late_pass_after_failure_is_rejected() {
        let (state, now) = open_state();
        let failed = state
            .record_at("failed", false, json!({"ok":false}), now)
            .unwrap();
        assert_eq!(failed.completion.unwrap().status, "failed");
        assert!(state
            .record_at(
                "passed",
                true,
                json!({"ok":true}),
                now + Duration::from_secs(1)
            )
            .is_err());
    }

    #[test]
    fn missing_required_evidence_cannot_pass() {
        let (state, now) = open_state();
        record_ok(&state, "window_open", now);
        let outcome = record_ok(&state, "passed", now + Duration::from_secs(1));
        assert!(!outcome.accepted);
        let completion = outcome.completion.unwrap();
        assert_eq!(completion.status, "failed");
        assert!(!completion
            .events
            .iter()
            .any(|event| event.stage == "passed"));
        assert!(completion.events.iter().any(|event| {
            event.stage == "failed"
                && event.details["missingStages"]
                    .as_array()
                    .is_some_and(|missing| !missing.is_empty())
        }));
    }

    #[test]
    fn complete_evidence_claims_pass_once_and_rejects_later_events() {
        let (state, now) = open_state();
        for stage in REQUIRED_STAGES {
            assert!(record_ok(&state, stage, now).accepted);
        }
        let passed = record_ok(&state, "passed", now + Duration::from_secs(1));
        assert!(passed.accepted);
        let completion = passed.completion.unwrap();
        assert_eq!(completion.status, "passed");
        assert_eq!(completion.exit_code, 0);
        assert!(state
            .record_at(
                "window_open",
                true,
                json!({"ok":true}),
                now + Duration::from_secs(2)
            )
            .is_err());
        assert!(state.timeout_at(now + Duration::from_secs(21)).is_none());
    }
}
