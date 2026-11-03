//! Bounded stage projection for the hidden Image-Toolbox fixture only.
use parking_lot::Mutex;
use serde_json::Value;
use std::path::PathBuf;
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
// Checkpoints are diagnostic only; `activation-resolved` means the invoke returned,
// not that the plugin observer or original operation succeeded.
enum HarnessStage {
    BeforeFixtureCommand,
    FixtureCommandComplete,
    ActivationStart,
    ActivationResolved,
    ActivationRejected,
    WaitingForPluginObserver,
    PluginPanelMounting,
    PanelMountReturned,
    PanelSvelteFlushCheckpoint,
    PluginObserverReceived,
    PanelTimeout,
    ReportSendFailed,
}
impl HarnessStage {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "before-fixture-command" => Self::BeforeFixtureCommand,
            "fixture-command-complete" => Self::FixtureCommandComplete,
            "activation-start" => Self::ActivationStart,
            "activation-resolved" => Self::ActivationResolved,
            "activation-rejected" => Self::ActivationRejected,
            "waiting-for-plugin-observer" => Self::WaitingForPluginObserver,
            "plugin-panel-mounting" => Self::PluginPanelMounting,
            "panel-mount-returned" => Self::PanelMountReturned,
            "panel-svelte-flush-checkpoint" => Self::PanelSvelteFlushCheckpoint,
            "plugin-observer-received" => Self::PluginObserverReceived,
            "panel-timeout" => Self::PanelTimeout,
            "report-send-failed" => Self::ReportSendFailed,
            _ => return None,
        })
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::BeforeFixtureCommand => "before-fixture-command",
            Self::FixtureCommandComplete => "fixture-command-complete",
            Self::ActivationStart => "activation-start",
            Self::ActivationResolved => "activation-resolved",
            Self::ActivationRejected => "activation-rejected",
            Self::WaitingForPluginObserver => "waiting-for-plugin-observer",
            Self::PluginPanelMounting => "plugin-panel-mounting",
            Self::PanelMountReturned => "panel-mount-returned",
            Self::PanelSvelteFlushCheckpoint => "panel-svelte-flush-checkpoint",
            Self::PluginObserverReceived => "plugin-observer-received",
            Self::PanelTimeout => "panel-timeout",
            Self::ReportSendFailed => "report-send-failed",
        }
    }
    fn order(self) -> u8 {
        match self {
            Self::BeforeFixtureCommand => 0,
            Self::FixtureCommandComplete => 1,
            Self::ActivationStart => 2,
            Self::ActivationResolved => 3,
            Self::ActivationRejected => 4,
            Self::WaitingForPluginObserver => 5,
            Self::PluginPanelMounting => 6,
            Self::PanelMountReturned => 7,
            Self::PanelSvelteFlushCheckpoint => 8,
            Self::PluginObserverReceived => 9,
            Self::PanelTimeout => 10,
            Self::ReportSendFailed => 11,
        }
    }
    fn is_terminal(self) -> bool {
        matches!(self, Self::PanelTimeout | Self::ReportSendFailed)
    }
}

pub(super) struct FixtureState {
    pub(super) token: String,
    pub(super) input_path: PathBuf,
    pub(super) report: Mutex<Option<oneshot::Sender<Value>>>,
    last_stage: Mutex<HarnessStage>,
    last_work_stage: Mutex<HarnessStage>,
    observations: Mutex<PluginObservations>,
}

#[derive(Default)]
struct PluginObservations {
    frame_presence_after_tick: Option<bool>,
    frame_source_assigned_after_tick: Option<bool>,
    frame_source_attribute_assigned: Option<bool>,
    frame_load_after_source_attribute_mutation_observed: Option<bool>,
    panel_load_error_observed: Option<bool>,
    top_window_error_observed: Option<bool>,
    top_unhandled_rejection_observed: Option<bool>,
    child_csp_observer_installed: Option<bool>,
    child_module_lease_script_csp_blocked: Option<bool>,
    child_observer_started: Option<bool>,
    child_dom_content_loaded: Option<bool>,
    child_enter_received: Option<bool>,
    child_app_instance_present: Option<bool>,
}

impl PluginObservations {
    fn record(&mut self, code: &str, observed: Option<bool>) -> Result<(), &'static str> {
        match code {
            "child-csp-observer-installed" if observed == Some(true) => {
                self.child_csp_observer_installed.get_or_insert(true);
                self.child_module_lease_script_csp_blocked
                    .get_or_insert(false);
            }
            "child-module-lease-script-csp-blocked"
                if observed == Some(true) && self.child_csp_observer_installed == Some(true) =>
            {
                self.child_module_lease_script_csp_blocked = Some(true);
            }
            "frame-observer-installed" if observed.is_none() => {
                self.frame_load_after_source_attribute_mutation_observed
                    .get_or_insert(false);
            }
            "frame-presence-after-tick" if observed.is_some() => {
                self.frame_presence_after_tick
                    .get_or_insert(observed.unwrap());
            }
            "frame-source-assigned-after-tick" if observed.is_some() => {
                self.frame_source_assigned_after_tick
                    .get_or_insert(observed.unwrap());
            }
            "frame-source-attribute-assigned" if observed == Some(true) => {
                self.frame_source_attribute_assigned = Some(true)
            }
            "frame-load-after-source-attribute-mutation" if observed == Some(true) => {
                self.frame_load_after_source_attribute_mutation_observed = Some(true)
            }
            "panel-load-error-observer-installed" if observed.is_none() => {
                self.panel_load_error_observed.get_or_insert(false);
            }
            "panel-load-error" if observed == Some(true) => {
                self.panel_load_error_observed = Some(true)
            }
            "top-window-observers-installed" if observed.is_none() => {
                self.top_window_error_observed.get_or_insert(false);
                self.top_unhandled_rejection_observed.get_or_insert(false);
            }
            "top-window-error" if observed == Some(true) => {
                self.top_window_error_observed = Some(true)
            }
            "top-unhandled-rejection" if observed == Some(true) => {
                self.top_unhandled_rejection_observed = Some(true)
            }
            "child-observer-started" if observed == Some(true) => {
                self.child_observer_started.get_or_insert(true);
            }
            "child-domcontentloaded"
                if observed == Some(true) && self.child_observer_started == Some(true) =>
            {
                self.child_dom_content_loaded.get_or_insert(true);
            }
            "child-enter-received"
                if observed == Some(true) && self.child_observer_started == Some(true) =>
            {
                self.child_enter_received.get_or_insert(true);
            }
            "child-app-instance-present" if self.child_enter_received == Some(true) => {
                match (self.child_app_instance_present, observed) {
                    (None, Some(false)) | (None, Some(true)) => {
                        self.child_app_instance_present = observed
                    }
                    (Some(false), Some(false)) => {}
                    (Some(false), Some(true)) => self.child_app_instance_present = Some(true),
                    (Some(true), Some(true)) => {}
                    _ => return Err("Image-Toolbox child checkpoint moved backwards"),
                }
            }
            _ => return Err("Image-Toolbox observation is not allowlisted"),
        }
        Ok(())
    }

    fn json(&self) -> Value {
        serde_json::json!({
            "framePresenceAfterTick": self.frame_presence_after_tick,
            "frameSourceAssignedAfterTick": self.frame_source_assigned_after_tick,
            "frameSourceAttributeAssigned": self.frame_source_attribute_assigned,
            "frameLoadAfterSourceAttributeMutationObserved": self.frame_load_after_source_attribute_mutation_observed,
            "panelLoadErrorObserved": self.panel_load_error_observed,
            "topWindowErrorObserved": self.top_window_error_observed,
            "topUnhandledRejectionObserved": self.top_unhandled_rejection_observed,
            "childCspCheckpoints": {
                "observerInstalled": self.child_csp_observer_installed,
                "moduleLeaseScriptBlocked": self.child_module_lease_script_csp_blocked,
                "moduleLeaseScriptBlockedInterpretation": "true means the specified leased-script CSP denial was observed; false means it was not observed, not proof that no CSP denial occurred. The child observer processes at most 32 securitypolicyviolation events.",
            },
            "childLifecycleCheckpoints": {
                "observerStarted": self.child_observer_started,
                "domContentLoaded": self.child_dom_content_loaded,
                "enterReceived": self.child_enter_received,
                "appInstancePresent": self.child_app_instance_present,
            },
        })
    }
}
impl FixtureState {
    pub(super) fn new(token: String, input_path: PathBuf, report: oneshot::Sender<Value>) -> Self {
        Self {
            token,
            input_path,
            report: Mutex::new(Some(report)),
            last_stage: Mutex::new(HarnessStage::BeforeFixtureCommand),
            last_work_stage: Mutex::new(HarnessStage::BeforeFixtureCommand),
            observations: Mutex::new(PluginObservations::default()),
        }
    }
    fn update(&self, token: &str, stage: &str) -> Result<(), &'static str> {
        if token != self.token {
            return Err("Image-Toolbox stage token mismatch");
        }
        let stage = HarnessStage::parse(stage).ok_or("Image-Toolbox stage is not allowlisted")?;
        let mut last = self.last_stage.lock();
        if stage.order() < last.order() {
            return Err("Image-Toolbox stage moved backwards");
        }
        if !stage.is_terminal() {
            *self.last_work_stage.lock() = stage;
        }
        *last = stage;
        Ok(())
    }
    fn observe(&self, token: &str, code: &str, observed: Option<bool>) -> Result<(), &'static str> {
        if token != self.token {
            return Err("Image-Toolbox observation token mismatch");
        }
        self.observations.lock().record(code, observed)
    }
    pub(super) fn last_stage(&self) -> &'static str {
        self.last_stage.lock().as_str()
    }
    pub(super) fn last_work_stage(&self) -> &'static str {
        self.last_work_stage.lock().as_str()
    }
    pub(super) fn enrich_report(&self, report: &mut Value) {
        let Some(report) = report.as_object_mut() else {
            return;
        };
        let stalled = report
            .get("stalledAtStage")
            .and_then(Value::as_str)
            .and_then(HarnessStage::parse)
            .filter(|stage| !stage.is_terminal())
            .map(HarnessStage::as_str);
        report.remove("stalledAtStage");
        if let Some(stalled) = stalled {
            report.insert("stalledAtStage".into(), Value::String(stalled.into()));
        }
        report.insert(
            "lastHarnessStage".into(),
            Value::String(self.last_stage().into()),
        );
        report.insert(
            "lastHarnessWorkStage".into(),
            Value::String(self.last_work_stage().into()),
        );
        report.insert(
            "pluginDomObservations".into(),
            self.observations.lock().json(),
        );
    }
}

#[tauri::command]
pub(super) fn native_image_toolbox_stage(
    state: tauri::State<'_, FixtureState>,
    token: String,
    stage: Option<String>,
    observation: Option<String>,
    observed: Option<bool>,
) -> Result<(), String> {
    match (stage, observation) {
        (Some(stage), None) if observed.is_none() => state.update(&token, &stage),
        (None, Some(observation)) => state.observe(&token, &observation, observed),
        _ => Err("Image-Toolbox checkpoint shape is invalid"),
    }
    .map_err(str::to_owned)
}

#[cfg(test)]
#[path = "desktop_smoke_native_image_toolbox_stage_tests.rs"]
mod tests;
