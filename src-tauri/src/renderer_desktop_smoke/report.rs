use super::super::super::observations::window_event_flow_errors;
use super::{Harness, Stage};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};

impl Harness {
    pub(in crate::renderer_desktop_smoke::controller) fn report(&self, app: &AppHandle) -> Value {
        let (readiness, incognito, stages, events, fatal_error, event_errors) = {
            let state = self.0.state.lock();
            (
                state.readiness.clone(),
                state.incognito_persistent,
                state.stage_observations.clone(),
                state.events.snapshot(),
                state.fatal_error,
                window_event_flow_errors(&state.stage_observations, &state.events),
            )
        };
        let readiness_errors = readiness
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .map(super::validation::readiness_errors)
            .unwrap_or_default();
        let mut errors = Vec::<&'static str>::new();
        if let Some(error) = fatal_error {
            errors.push(error);
        }
        if readiness.is_none() {
            errors.push("renderer-readiness-not-observed");
        }
        if let Some(Err(error)) = readiness.as_ref() {
            errors.push(error);
        }
        errors.extend(readiness_errors);
        if incognito != Some(false) {
            errors.push("incognito-webview-data-store-not-proven-nonpersistent");
        }
        if stages.len() != Stage::ALL.len() {
            errors.push("renderer-stage-set-incomplete");
        }
        for stage in &stages {
            errors.extend(stage.errors.iter().copied());
        }
        errors.extend(event_errors);

        #[cfg(feature = "ztools-multiwebview")]
        let settings_journey_enabled = self.0.profile.settings_journey;
        #[cfg(feature = "ztools-multiwebview")]
        let isolated_journey_enabled =
            self.0.profile.settings_journey || self.0.profile.launcher_journey;
        #[cfg(feature = "ztools-multiwebview")]
        let multiwebview = if isolated_journey_enabled {
            Value::Null
        } else {
            super::super::super::multiwebview::snapshot(app)
        };
        #[cfg(not(feature = "ztools-multiwebview"))]
        let multiwebview = Value::Null;
        #[cfg(feature = "ztools-multiwebview")]
        if !isolated_journey_enabled && multiwebview["passed"].as_bool() != Some(true) {
            errors.push("multiwebview-boundary-or-cleanup-not-verified");
        }
        #[cfg(feature = "ztools-multiwebview")]
        let settings_view = if settings_journey_enabled {
            super::super::super::settings_journey::snapshot(app)
        } else {
            Value::Null
        };
        #[cfg(not(feature = "ztools-multiwebview"))]
        let settings_view = Value::Null;
        #[cfg(feature = "ztools-multiwebview")]
        if settings_journey_enabled && settings_view["passed"].as_bool() != Some(true) {
            errors.push("settings-view-native-journey-not-verified");
        }

        #[cfg(feature = "legacy-node-smoke")]
        let launcher_journey_enabled = self.0.profile.launcher_journey;
        #[cfg(feature = "legacy-node-smoke")]
        let launcher = if launcher_journey_enabled {
            super::super::super::launcher_journey::snapshot(app)
        } else {
            Value::Null
        };
        #[cfg(feature = "legacy-node-smoke")]
        if launcher_journey_enabled && launcher["passed"].as_bool() != Some(true) {
            errors.push("launcher-native-journey-not-verified");
        }

        let (clipboard_counts, runtime) = runtime_observations(app);
        if clipboard_counts["reads"].as_u64() != Some(0)
            || clipboard_counts["writes"].as_u64() != Some(0)
            || clipboard_counts["pastes"].as_u64() != Some(0)
        {
            errors.push("disabled-clipboard-backend-was-called");
        }
        if runtime["mcp"]["active"].as_bool() != Some(false) {
            errors.push("mcp-runtime-was-active-during-smoke");
        }
        if runtime["pasteboardCapture"]["active"].as_bool() != Some(false) {
            errors.push("pasteboard-capture-was-active-during-smoke");
        }

        let mut unique_errors = Vec::new();
        for error in errors {
            if !unique_errors.contains(&error) {
                unique_errors.push(error);
            }
        }
        let readiness_value = readiness
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .cloned();
        let auxiliary_destroyed_count = events
            .get("events")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter(|entry| {
                        entry.get("label").and_then(Value::as_str)
                            == Some("renderer-smoke-focus-target")
                            && entry.get("event").and_then(Value::as_str) == Some("destroyed")
                    })
                    .count()
            })
            .unwrap_or_default();
        let stage_report = if self.0.profile.launcher_journey {
            let mut output = serde_json::to_value(&stages).unwrap_or(Value::Null);
            if let Some(entries) = output.as_array_mut() {
                for entry in entries {
                    if let Some(dom) = entry.get_mut("dom").and_then(Value::as_object_mut) {
                        // Stage verification uses the live snapshot above. Only the
                        // serialized launcher report is redacted because its fixed
                        // query is a private probe detail.
                        dom.insert("inputValue".to_owned(), Value::Null);
                        dom.insert("disposeError".to_owned(), Value::Null);
                    }
                }
            }
            output
        } else {
            serde_json::to_value(&stages).unwrap_or(Value::Null)
        };
        let mut report = json!({
            "version": 1,
            "autoClear": self.0.profile.auto_clear.clone(),
            "identifier": self.0.profile.identifier.clone(),
            "passed": unique_errors.is_empty(),
            "error": unique_errors.first().copied(),
            "verificationErrors": unique_errors,
            "readiness": readiness_value,
            "incognitoDataStorePersistent": incognito,
            "stages": stage_report,
            "ownWindowEvents": events,
            "clipboardAttemptCounts": clipboard_counts,
            "runtimeManagers": runtime,
            "multiwebview": multiwebview,
            "settingsView": settings_view,
            "auxiliaryFocusWindow": {
                "kind": "test-only-focus-target",
                "additionalTemporaryWebview": true,
                "maximumConcurrent": 1,
                "url": "about:blank",
                "javascriptEnabled": false,
                "navigation": "about:blank only",
                "incognito": true,
                "destroyedEventCount": auxiliary_destroyed_count,
                "destroyedAfterBothFocusCycles": auxiliary_destroyed_count >= 2,
                "productionPluginProcess": false
            },
            "fixtureMetadata": app
                .try_state::<super::super::super::FixtureMetadata>()
                .map(|metadata| metadata.0.clone()),
            "inputMethod": "fixed query via native HTMLInputElement value setter and bubbling InputEvent; programmatic DOM input, not physical keyboard input",
            "scope": "Original renderer at the local root route in the production host builder, real main window lifecycle, temporary AppConfig and database, isolated nonpersistent WebKit store, no user clipboard or external application launch"
        });
        #[cfg(feature = "legacy-node-smoke")]
        if launcher_journey_enabled {
            report["launcher"] = launcher;
        }
        report
    }
}

fn runtime_observations(app: &AppHandle) -> (Value, Value) {
    let (reads, writes, pastes) = app
        .try_state::<std::sync::Arc<super::super::super::DisabledClipboard>>()
        .map(|state| {
            (
                state.reads.load(Ordering::Relaxed),
                state.writes.load(Ordering::Relaxed),
                state.pastes.load(Ordering::Relaxed),
            )
        })
        .unwrap_or((usize::MAX, usize::MAX, usize::MAX));
    let counts = json!({ "reads": reads, "writes": writes, "pastes": pastes });

    let (mcp_observed, mcp_active, capture_observed, capture_active) = app
        .try_state::<crate::state::AppState>()
        .map(|state| {
            (
                true,
                state.mcp_status.lock().is_some(),
                true,
                state.pasteboard_capture_task.lock().is_some(),
            )
        })
        .unwrap_or((false, true, false, true));
    let runtime = json!({
        "pluginExecution": "not-started-by-smoke-entry",
        "nodeSidecar": "not-started-by-smoke-entry",
        "mcp": { "observed": mcp_observed, "active": mcp_active },
        "pasteboardCapture": { "observed": capture_observed, "active": capture_active },
        "screenCapture": "not-started-by-smoke-entry"
    });
    (counts, runtime)
}
