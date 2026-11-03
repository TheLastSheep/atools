use serde_json::{json, Value};

pub(super) const STAGES: [&str; 7] = [
    "baseline",
    "pasted",
    "denied",
    "direct-return",
    "typed",
    "keyboard-return",
    "disposed",
];

pub(super) struct JourneyReport {
    value: Value,
}

impl JourneyReport {
    pub(super) fn new(
        profile: &super::super::profile::Profile,
        fixture_valid: bool,
        local_shortcut_items: u64,
    ) -> Self {
        let mut value = json!({
            "schemaVersion": 2,
            "journey": "launch-return",
            "scope": "hidden-original-vue-real-launch-return",
            "runId": profile.run_id,
            "identifier": profile.identifier,
            "root": profile.root.to_string_lossy(),
            "pid": std::process::id(),
            "passed": false,
            "errors": [],
            "metadata": {
                "ownedFixture": fixture_valid,
                "catalogItems": if fixture_valid && profile.launch_target_kind == super::super::profile::LaunchTargetKind::App { 2 } else { 0 },
                "targetKind": profile.launch_target_kind.as_str(),
                "localShortcutItems": if fixture_valid { local_shortcut_items } else { 0 },
                "windowPolicy": "hidden-no-foreground",
                "dataStorePersistent": false,
                "backgroundOnly": fixture_valid,
                "autoClear": "never"
            },
            "clipboard": { "reads": 0, "writes": 0, "pastes": 0 },
            "stages": STAGES.iter().map(|name| json!({
                "name": name,
                "status": "not_run",
                "dom": unknown_dom(),
                "native": unknown_native()
            })).collect::<Vec<_>>(),
            "probes": [unknown_probe("first"), unknown_probe("second")]
        });
        if profile.registration_source == super::super::profile::RegistrationSource::SettingsChild {
            value["schemaVersion"] = json!(3);
            value["metadata"]["registrationSource"] = json!("settings-child");
            value["registration"] = super::settings_registration_report::initial(profile);
        }
        if !fixture_valid {
            push_error(&mut value, "launch-return-owned-fixture-not-verified");
        }
        Self { value }
    }

    pub(super) fn set_clipboard(&mut self, reads: usize, writes: usize, pastes: usize) {
        self.value["clipboard"] = json!({ "reads": reads, "writes": writes, "pastes": pastes });
    }

    pub(super) fn set_registration(&mut self, registration: Value) {
        if self.value["schemaVersion"] == 3 {
            self.value["metadata"]["localShortcutItems"] = json!(registration["cleanup"]["rows"]
                .as_array()
                .map_or(0, Vec::len));
            self.value["registration"] = registration;
        }
    }

    pub(super) fn append_registration_focus(&mut self, focus: Value) {
        if let Some(values) = self
            .value
            .pointer_mut("/registration/focus")
            .and_then(Value::as_array_mut)
        {
            values.push(focus);
        }
    }

    pub(super) fn set_stage(
        &mut self,
        index: usize,
        dom: Value,
        native: Value,
        stage_passed: bool,
        error: Option<&'static str>,
    ) {
        let Some(stage) = self
            .value
            .get_mut("stages")
            .and_then(Value::as_array_mut)
            .and_then(|stages| stages.get_mut(index))
        else {
            self.fail("launch-return-stage-index-invalid");
            return;
        };
        stage["dom"] = dom;
        stage["native"] = native;
        stage["status"] = Value::String(if stage_passed { "observed" } else { "failed" }.into());
        if let Some(error) = error {
            self.fail(error);
        }
    }

    pub(super) fn set_probes(&mut self, first: Value, second: Value) {
        self.value["probes"] = Value::Array(vec![first, second]);
    }

    pub(super) fn stage_native(&self, index: usize) -> Option<&Value> {
        self.value
            .get("stages")?
            .as_array()?
            .get(index)?
            .get("native")
    }

    pub(super) fn fail(&mut self, error: &'static str) {
        push_error(&mut self.value, error);
    }

    pub(super) fn finish(mut self) -> Value {
        let stages_observed = self.value["stages"]
            .as_array()
            .is_some_and(|stages| stages.iter().all(|stage| stage["status"] == "observed"));
        let no_errors = self.value["errors"].as_array().is_some_and(Vec::is_empty);
        let registration_observed =
            self.value["schemaVersion"] != 3 || self.value["registration"]["status"] == "passed";
        self.value["passed"] = Value::Bool(stages_observed && no_errors && registration_observed);
        self.value
    }
}

pub(super) fn empty_dom() -> Value {
    json!({
        "inputValue": "",
        "pastedText": "",
        "selectedTitle": "",
        "visibility": null,
        "documentHasFocus": null,
        "inputFocused": null,
        "actions": {
            "metaFDefaultPrevented": null,
            "launchRejected": null,
            "launchResolved": null,
            "arrowDownDefaultPrevented": null,
            "enterDefaultPrevented": null
        },
        "adapter": {
            "launchCalls": null,
            "outstandingNativeCalls": null,
            "listeners": {
                "focusEvents": null,
                "appState": null,
                "appCatalog": null,
                "appLaunched": null,
                "contextMenu": null,
                "settingsView": null,
                "generalPreferenceEvents": null,
                "localShortcutEvents": null
            },
            "windowDrag": null
        }
    })
}

pub(super) fn empty_native() -> Value {
    unknown_native()
}

pub(super) fn unknown_dom() -> Value {
    json!({
        "inputValue": null,
        "pastedText": null,
        "selectedTitle": null,
        "visibility": null,
        "documentHasFocus": null,
        "inputFocused": null,
        "actions": {
            "metaFDefaultPrevented": null,
            "launchRejected": null,
            "launchResolved": null,
            "arrowDownDefaultPrevented": null,
            "enterDefaultPrevented": null
        },
        "adapter": {
            "launchCalls": null,
            "outstandingNativeCalls": null,
            "listeners": {
                "focusEvents": null,
                "appState": null,
                "appCatalog": null,
                "appLaunched": null,
                "contextMenu": null,
                "settingsView": null,
                "generalPreferenceEvents": null,
                "localShortcutEvents": null
            },
            "windowDrag": null
        }
    })
}

pub(super) fn unknown_native() -> Value {
    json!({
        "window": { "visible": null, "focused": null, "sizeLocked": null, "bounds": null },
        "focusGainedEvents": null,
        "childWebviews": null,
        "activeChildLayouts": null,
        "wkStorePersistent": null,
        "taskRuns": { "total": null, "cancelled": null, "succeeded": null },
        "audits": { "denied": null, "confirmed": null },
        "history": { "items": null, "firstUseCount": null, "secondUseCount": null, "appItems": null, "localShortcutItems": null },
        "appLaunchedWitness": { "targetLabel": null, "deliveredEvents": null, "payloadIsNull": null },
        "probes": { "started": null, "exited": null, "liveProcesses": null, "pendingLaunches": null }
    })
}

pub(super) fn unknown_probe(probe_id: &str) -> Value {
    json!({
        "probeId": probe_id,
        "bundleName": bundle_name(probe_id),
        "backgroundOnly": null,
        "marker": {
            "started": null,
            "exiting": null,
            "runIdMatched": null,
            "probeIdMatched": null,
            "pid": null,
            "processTerminal": null
        }
    })
}

pub(super) fn bundle_name(probe_id: &str) -> &'static str {
    match probe_id {
        "first" => "AToolsOwnedProbeFirst.app",
        "second" => "AToolsOwnedProbeSecond.app",
        _ => "",
    }
}

fn push_error(report: &mut Value, error: &'static str) {
    if let Some(errors) = report.get_mut("errors").and_then(Value::as_array_mut) {
        let code = Value::String(error.to_owned());
        if !errors.contains(&code) {
            errors.push(code);
        }
    }
    report["passed"] = Value::Bool(false);
}

#[cfg(all(test, feature = "ztools-multiwebview"))]
#[path = "settings_registration_report_tests.rs"]
mod registration_tests;
