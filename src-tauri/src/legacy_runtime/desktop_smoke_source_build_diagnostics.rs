//! Bounded, token-bound boot evidence for the isolated source-build WebView.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, fs::OpenOptions, io::Write, path::Path};

#[path = "desktop_smoke_source_build_pipeline_evidence.rs"]
mod pipeline_evidence;
pub use pipeline_evidence::BuildPipelineEvidence;

pub const MAX_EVENTS: usize = 20;
pub const EVIDENCE_FILE_LIMIT: usize = 4 * 1024 * 1024;
pub const EVIDENCE_TOTAL_LIMIT: usize = 8 * 1024 * 1024;
const EXPECTED_FRONTEND_IPC: u8 = 10;

fn evidence_budget_ok(existing_bytes: usize, next_file_bytes: usize) -> bool {
    next_file_bytes <= EVIDENCE_FILE_LIMIT
        && existing_bytes.saturating_add(next_file_bytes) <= EVIDENCE_TOTAL_LIMIT
}

/// Events accepted from the WebView. Native protocol and report events are deliberately absent.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FrontendEvent {
    ObserverInstalled,
    PanelStyleLoad,
    PanelStyleError,
    PanelElementLoad,
    PanelElementError,
    WindowError,
    UnhandledRejection,
    MainEntered,
    HostMounted,
    ScenarioStarted,
    ScenarioCompleted,
    FrontendCatchEntered,
    UnmountStarted,
    UnmountCompleted,
    ReportSubmitted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum NativeEvent {
    DocumentRequested,
    PanelCssRequested,
    PanelScriptRequested,
    ReportReceived,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum EventActor {
    Frontend,
    Native,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum EventKind {
    ObserverInstalled,
    PanelStyleLoad,
    PanelStyleError,
    DocumentRequested,
    PanelCssRequested,
    PanelScriptRequested,
    PanelElementLoad,
    PanelElementError,
    WindowError,
    UnhandledRejection,
    MainEntered,
    HostMounted,
    ScenarioStarted,
    ScenarioCompleted,
    FrontendCatchEntered,
    UnmountStarted,
    UnmountCompleted,
    ReportSubmitted,
    ReportReceived,
}

impl From<FrontendEvent> for EventKind {
    fn from(value: FrontendEvent) -> Self {
        match value {
            FrontendEvent::ObserverInstalled => Self::ObserverInstalled,
            FrontendEvent::PanelStyleLoad => Self::PanelStyleLoad,
            FrontendEvent::PanelStyleError => Self::PanelStyleError,
            FrontendEvent::PanelElementLoad => Self::PanelElementLoad,
            FrontendEvent::PanelElementError => Self::PanelElementError,
            FrontendEvent::WindowError => Self::WindowError,
            FrontendEvent::UnhandledRejection => Self::UnhandledRejection,
            FrontendEvent::MainEntered => Self::MainEntered,
            FrontendEvent::HostMounted => Self::HostMounted,
            FrontendEvent::ScenarioStarted => Self::ScenarioStarted,
            FrontendEvent::ScenarioCompleted => Self::ScenarioCompleted,
            FrontendEvent::FrontendCatchEntered => Self::FrontendCatchEntered,
            FrontendEvent::UnmountStarted => Self::UnmountStarted,
            FrontendEvent::UnmountCompleted => Self::UnmountCompleted,
            FrontendEvent::ReportSubmitted => Self::ReportSubmitted,
        }
    }
}

impl From<NativeEvent> for EventKind {
    fn from(value: NativeEvent) -> Self {
        match value {
            NativeEvent::DocumentRequested => Self::DocumentRequested,
            NativeEvent::PanelCssRequested => Self::PanelCssRequested,
            NativeEvent::PanelScriptRequested => Self::PanelScriptRequested,
            NativeEvent::ReportReceived => Self::ReportReceived,
        }
    }
}

/// The nested IPC object rejects unknown fields; the frontend cannot select a native event.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FrontendDiagnosticMessage {
    pub run_token: String,
    pub event: FrontendEvent,
}

/// Top-level report shape is bounded and fixed. Scenario observations remain data, not authority.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FrontendReport {
    pub passed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks: Option<std::collections::BTreeMap<String, bool>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observations: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unmount_failed: Option<bool>,
    #[serde(
        default,
        deserialize_with = "pipeline_evidence::optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub build_pipeline_evidence: Option<BuildPipelineEvidence>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FrontendReportMessage {
    pub run_token: String,
    pub report: FrontendReport,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ProtocolRequest {
    Document,
    Css,
    Script,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct EventRecord {
    actor: EventActor,
    event: EventKind,
}

#[derive(Debug)]
pub(super) struct Ledger {
    run_token: String,
    events: Vec<EventRecord>,
    diagnostic_ipc_count: u8,
    report_received_count: u8,
    document_requests: u8,
    css_requests: u8,
    script_requests: u8,
    overflow: bool,
}

impl Ledger {
    pub(super) fn new(run_token: String) -> Self {
        Self {
            run_token,
            events: Vec::with_capacity(MAX_EVENTS),
            diagnostic_ipc_count: 0,
            report_received_count: 0,
            document_requests: 0,
            css_requests: 0,
            script_requests: 0,
            overflow: false,
        }
    }

    pub(super) fn record_frontend(
        &mut self,
        message: FrontendDiagnosticMessage,
    ) -> Result<(), &'static str> {
        if message.run_token != self.run_token {
            return Err("Source-build diagnostic token mismatch");
        }
        self.diagnostic_ipc_count = self.diagnostic_ipc_count.saturating_add(1);
        self.push(EventActor::Frontend, message.event.into());
        Ok(())
    }

    pub(super) fn record_protocol(&mut self, request: ProtocolRequest) {
        let (counter, event) = match request {
            ProtocolRequest::Document => {
                (&mut self.document_requests, NativeEvent::DocumentRequested)
            }
            ProtocolRequest::Css => (&mut self.css_requests, NativeEvent::PanelCssRequested),
            ProtocolRequest::Script => {
                (&mut self.script_requests, NativeEvent::PanelScriptRequested)
            }
        };
        *counter = counter.saturating_add(1);
        self.push(EventActor::Native, event.into());
    }

    pub(super) fn record_report_received(&mut self, run_token: &str) -> Result<(), &'static str> {
        if run_token != self.run_token {
            return Err("Source-build report token mismatch");
        }
        if self.report_received_count != 0 {
            return Err("Source-build report already received");
        }
        self.report_received_count = 1;
        self.push(EventActor::Native, NativeEvent::ReportReceived.into());
        Ok(())
    }

    fn push(&mut self, actor: EventActor, event: EventKind) {
        if self.events.len() >= MAX_EVENTS {
            self.overflow = true;
            return;
        }
        self.events.push(EventRecord { actor, event });
    }

    fn expected_success_events() -> [EventRecord; 14] {
        use EventActor::{Frontend as F, Native as N};
        use EventKind::*;
        [
            EventRecord {
                actor: N,
                event: DocumentRequested,
            },
            EventRecord {
                actor: F,
                event: ObserverInstalled,
            },
            EventRecord {
                actor: N,
                event: PanelCssRequested,
            },
            EventRecord {
                actor: F,
                event: PanelStyleLoad,
            },
            EventRecord {
                actor: N,
                event: PanelScriptRequested,
            },
            EventRecord {
                actor: F,
                event: PanelElementLoad,
            },
            EventRecord {
                actor: F,
                event: MainEntered,
            },
            EventRecord {
                actor: F,
                event: HostMounted,
            },
            EventRecord {
                actor: F,
                event: ScenarioStarted,
            },
            EventRecord {
                actor: F,
                event: ScenarioCompleted,
            },
            EventRecord {
                actor: F,
                event: UnmountStarted,
            },
            EventRecord {
                actor: F,
                event: UnmountCompleted,
            },
            EventRecord {
                actor: F,
                event: ReportSubmitted,
            },
            EventRecord {
                actor: N,
                event: ReportReceived,
            },
        ]
    }

    fn exact_success_sequence(&self) -> bool {
        self.events.as_slice() == Self::expected_success_events().as_slice()
    }

    pub(super) fn snapshot(&self) -> Value {
        let events = self
            .events
            .iter()
            .map(|record| {
                json!({
                    "actor": record.actor,
                    "event": record.event,
                })
            })
            .collect::<Vec<_>>();
        let exact_success_sequence = self.exact_success_sequence();
        let error_event_count = self
            .events
            .iter()
            .filter(|record| {
                matches!(
                    record.event,
                    EventKind::PanelStyleError
                        | EventKind::PanelElementError
                        | EventKind::WindowError
                        | EventKind::UnhandledRejection
                        | EventKind::FrontendCatchEntered
                )
            })
            .count();
        let protocol_requests_once =
            self.document_requests == 1 && self.css_requests == 1 && self.script_requests == 1;
        let passed = exact_success_sequence
            && error_event_count == 0
            && !self.overflow
            && protocol_requests_once
            && self.diagnostic_ipc_count == EXPECTED_FRONTEND_IPC
            && self.report_received_count == 1;
        json!({
            "events": events,
            "eventCount": self.events.len(),
            "diagnosticIpcMessageCount": self.diagnostic_ipc_count,
            "nativeReportReceivedCount": self.report_received_count,
            "protocolRequestCounts": {"document":self.document_requests,"panelCss":self.css_requests,"panelScript":self.script_requests},
            "exactSuccessSequence": exact_success_sequence,
            "errorEventCount": error_event_count,
            "overflow": self.overflow,
            "passed": passed
        })
    }
}

pub fn document_html(run_token: &str) -> Vec<u8> {
    let token = serde_json::to_string(run_token).unwrap_or_else(|_| "\"invalid\"".into());
    let html = r#"<!doctype html><meta charset="utf-8"><div id="app"></div><script>
(()=>{const token=__RUN_TOKEN__;window.__atoolsSourceBuildRunToken=token;const allowed=new Set(["observer_installed","panel_style_load","panel_style_error","panel_element_load","panel_element_error","window_error","unhandled_rejection","main_entered","host_mounted","scenario_started","scenario_completed","frontend_catch_entered","unmount_started","unmount_completed","report_submitted"]);const pending=[];let failed=false;let resolveScriptReady;window.__atoolsSourceBuildScriptReady=new Promise(resolve=>{resolveScriptReady=resolve});const emit=event=>{if(!allowed.has(event)||pending.length>=16){failed=true;return Promise.resolve(false)}let task;try{task=window.__TAURI__.core.invoke("native_source_build_diagnostic",{message:{runToken:token,event}}).then(()=>true,()=>{failed=true;return false})}catch{failed=true;return Promise.resolve(false)}pending.push(task);return task};window.__atoolsSourceBuildRecord=emit;window.__atoolsSourceBuildFlush=async()=>{const results=await Promise.all(pending);return !failed&&results.every(Boolean)};window.addEventListener("error",()=>{void emit("window_error")});window.addEventListener("unhandledrejection",()=>{void emit("unhandled_rejection")});void emit("observer_installed").then(ok=>{if(!ok){resolveScriptReady(false);return}const link=document.createElement("link");link.rel="stylesheet";link.href="atools-source-build://localhost/panel.css";link.addEventListener("load",()=>{void emit("panel_style_load").then(styleOk=>{if(!styleOk){resolveScriptReady(false);return}const script=document.createElement("script");script.type="module";script.src="atools-source-build://localhost/panel.js";script.addEventListener("load",()=>{void emit("panel_element_load").then(resolveScriptReady)},{once:true});script.addEventListener("error",()=>{void emit("panel_element_error").then(()=>resolveScriptReady(false))},{once:true});document.head.appendChild(script)})},{once:true});link.addEventListener("error",()=>{void emit("panel_style_error").then(()=>resolveScriptReady(false))},{once:true});document.head.appendChild(link)});})();
</script>"#;
    html.replace("__RUN_TOKEN__", &token).into_bytes()
}

pub fn write_entry_html(directory: &Path, bytes: &[u8]) -> Result<(usize, String), String> {
    if !evidence_budget_ok(0, bytes.len()) {
        return Err("Fixed entry HTML exceeds evidence file cap".into());
    }
    let mut total = bytes.len();
    for name in ["panel.js", "panel.css"] {
        let path = directory.join(name);
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| "Required panel evidence is missing")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("Panel evidence is not a bounded regular file".into());
        }
        let file_bytes =
            usize::try_from(metadata.len()).map_err(|_| "Panel evidence size is invalid")?;
        if !evidence_budget_ok(total, file_bytes) {
            return Err("Combined source-build evidence exceeds its fixed byte budget".into());
        }
        total = total.saturating_add(file_bytes);
    }
    let path = directory.join("entry.html");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "Could not create fixed entry HTML evidence")?;
    file.write_all(bytes)
        .map_err(|_| "Could not write fixed entry HTML evidence".to_owned())?;
    file.sync_all()
        .map_err(|_| "Could not flush fixed entry HTML evidence".to_owned())?;
    Ok((bytes.len(), format!("{:x}", Sha256::digest(bytes))))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "24d8b68f-23ad-49dd-9d07-b5a0a0b705aa";

    fn record_success(ledger: &mut Ledger) {
        // Mirror the handshake causality: the initial document observer is installed before
        // it requests CSS; CSS load is acknowledged before the observer requests the module;
        // the module element load fires before its main entry point records startup.
        ledger.record_protocol(ProtocolRequest::Document);
        ledger
            .record_frontend(FrontendDiagnosticMessage {
                run_token: TOKEN.into(),
                event: FrontendEvent::ObserverInstalled,
            })
            .unwrap();
        ledger.record_protocol(ProtocolRequest::Css);
        ledger
            .record_frontend(FrontendDiagnosticMessage {
                run_token: TOKEN.into(),
                event: FrontendEvent::PanelStyleLoad,
            })
            .unwrap();
        ledger.record_protocol(ProtocolRequest::Script);
        ledger
            .record_frontend(FrontendDiagnosticMessage {
                run_token: TOKEN.into(),
                event: FrontendEvent::PanelElementLoad,
            })
            .unwrap();
        for event in [
            FrontendEvent::MainEntered,
            FrontendEvent::HostMounted,
            FrontendEvent::ScenarioStarted,
            FrontendEvent::ScenarioCompleted,
            FrontendEvent::UnmountStarted,
            FrontendEvent::UnmountCompleted,
            FrontendEvent::ReportSubmitted,
        ] {
            ledger
                .record_frontend(FrontendDiagnosticMessage {
                    run_token: TOKEN.into(),
                    event,
                })
                .unwrap();
        }
        ledger.record_report_received(TOKEN).unwrap();
    }

    #[test]
    fn success_requires_exact_cross_layer_sequence_and_separate_native_report_count() {
        let mut ledger = Ledger::new(TOKEN.into());
        record_success(&mut ledger);
        let snapshot = ledger.snapshot();
        assert_eq!(snapshot["passed"], true);
        assert_eq!(snapshot["diagnosticIpcMessageCount"], EXPECTED_FRONTEND_IPC);
        assert_eq!(snapshot["nativeReportReceivedCount"], 1);
        assert_eq!(snapshot["eventCount"], 14);
        assert_eq!(snapshot["events"][9]["event"], "scenario_completed");
        assert_eq!(snapshot["events"][12]["event"], "report_submitted");
    }

    #[test]
    fn failure_diagnostics_are_kept_but_do_not_pass_and_report_is_once() {
        let mut ledger = Ledger::new(TOKEN.into());
        ledger
            .record_frontend(FrontendDiagnosticMessage {
                run_token: TOKEN.into(),
                event: FrontendEvent::FrontendCatchEntered,
            })
            .unwrap();
        ledger
            .record_frontend(FrontendDiagnosticMessage {
                run_token: TOKEN.into(),
                event: FrontendEvent::UnmountStarted,
            })
            .unwrap();
        ledger
            .record_frontend(FrontendDiagnosticMessage {
                run_token: TOKEN.into(),
                event: FrontendEvent::UnmountCompleted,
            })
            .unwrap();
        ledger.record_report_received(TOKEN).unwrap();
        assert_eq!(ledger.snapshot()["passed"], false);
        assert_eq!(
            ledger.snapshot()["events"][0]["event"],
            "frontend_catch_entered"
        );
        assert!(ledger.record_report_received(TOKEN).is_err());
    }

    #[test]
    fn out_of_order_frontend_milestones_fail_the_exact_sequence_gate() {
        let mut ledger = Ledger::new(TOKEN.into());
        record_success(&mut ledger);
        assert_eq!(
            ledger.snapshot()["passed"],
            true,
            "the protocol-ordered baseline must pass first"
        );
        ledger.events.swap(1, 2);
        assert_eq!(ledger.snapshot()["exactSuccessSequence"], false);
        assert_eq!(ledger.snapshot()["passed"], false);
    }

    #[test]
    fn command_envelope_rejects_unknown_fields_and_wrong_token() {
        assert!(serde_json::from_str::<FrontendDiagnosticMessage>(
            r#"{"runToken":"x","event":"report_received"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<FrontendDiagnosticMessage>(
            r#"{"runToken":"x","event":"main_entered","extra":1}"#
        )
        .is_err());
        let mut ledger = Ledger::new(TOKEN.into());
        assert!(ledger
            .record_frontend(FrontendDiagnosticMessage {
                run_token: "wrong".into(),
                event: FrontendEvent::MainEntered
            })
            .is_err());
    }

    #[test]
    fn report_envelope_rejects_unknown_top_level_fields() {
        assert!(serde_json::from_str::<FrontendReportMessage>(
            r#"{"runToken":"x","report":{"passed":false},"extra":1}"#
        )
        .is_err());
        assert!(serde_json::from_str::<FrontendReportMessage>(
            r#"{"runToken":"x","report":{"passed":false,"unlisted":true}}"#
        )
        .is_err());
    }

    #[test]
    fn overflow_and_missing_lifecycle_milestones_fail_closed() {
        let mut overflow = Ledger::new(TOKEN.into());
        for _ in 0..=MAX_EVENTS {
            overflow
                .record_frontend(FrontendDiagnosticMessage {
                    run_token: TOKEN.into(),
                    event: FrontendEvent::ObserverInstalled,
                })
                .unwrap();
        }
        assert_eq!(overflow.snapshot()["eventCount"], MAX_EVENTS);
        assert_eq!(overflow.snapshot()["overflow"], true);
        assert_eq!(overflow.snapshot()["passed"], false);
        assert_eq!(Ledger::new(TOKEN.into()).snapshot()["passed"], false);
    }

    #[test]
    fn evidence_file_and_total_caps_have_exact_boundaries() {
        assert!(evidence_budget_ok(0, EVIDENCE_FILE_LIMIT));
        assert!(!evidence_budget_ok(0, EVIDENCE_FILE_LIMIT + 1));
        assert!(evidence_budget_ok(EVIDENCE_FILE_LIMIT, EVIDENCE_FILE_LIMIT));
        assert!(!evidence_budget_ok(
            EVIDENCE_FILE_LIMIT,
            EVIDENCE_FILE_LIMIT + 1
        ));
    }

    #[test]
    fn html_observer_only_submits_frontend_events_without_error_payloads() {
        let html = String::from_utf8(document_html(TOKEN)).unwrap();
        assert!(html.contains("type=\"module\""));
        assert!(html.contains("unhandledrejection"));
        assert!(html.contains("message:{runToken:token,event}"));
        assert!(!html.contains("document_requested") && !html.contains("report_received"));
        assert!(
            !html.contains("e.message")
                && !html.contains("e.filename")
                && !html.contains("e.reason")
        );
    }
}
