#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplication, NSWindow, NSWindowOcclusionState, NSWorkspace};
#[cfg(target_os = "macos")]
use tauri::AppHandle;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "legacy-node-smoke", derive(serde::Serialize))]
#[cfg_attr(feature = "legacy-node-smoke", serde(rename_all = "camelCase"))]
pub(crate) struct ForegroundSnapshot {
    pub app_active: Option<bool>,
    pub app_hidden: Option<bool>,
    pub frontmost_is_self: Option<bool>,
    pub main_window_available: Option<bool>,
    pub main_visible: Option<bool>,
    pub main_key: Option<bool>,
    pub main_focused: Option<bool>,
    pub main_on_active_space: Option<bool>,
    pub main_occlusion_visible: Option<bool>,
}

#[cfg(feature = "legacy-node-smoke")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationFailureObservation {
    schema_version: u8,
    kind: &'static str,
    pid: u32,
    request_sent: bool,
    finished_launching: bool,
    activation_policy: String,
    terminated: bool,
    before: ForegroundSnapshot,
    after: ForegroundSnapshot,
}

#[cfg(feature = "legacy-node-smoke")]
pub(super) fn activation_failure_json(
    request_sent: bool,
    finished_launching: bool,
    activation_policy: &str,
    terminated: bool,
    before: ForegroundSnapshot,
    after: ForegroundSnapshot,
) -> Option<String> {
    serde_json::to_string(&ActivationFailureObservation {
        schema_version: 1,
        kind: "activation-failure",
        pid: std::process::id(),
        request_sent,
        finished_launching,
        activation_policy: activation_policy.to_owned(),
        terminated,
        before,
        after,
    })
    .ok()
}

impl ForegroundSnapshot {
    #[cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]
    pub(crate) fn capture(app: &AppHandle) -> Self {
        let main_thread = objc2::MainThreadMarker::new()
            .expect("Main window snapshots require AppKit's main thread");
        let application = NSApplication::sharedApplication(main_thread);
        Self::capture_with_application(app, &application)
    }

    #[cfg(target_os = "macos")]
    pub(super) fn capture_with_application(app: &AppHandle, application: &NSApplication) -> Self {
        let frontmost_is_self = NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|process| process.processIdentifier() == std::process::id() as i32);
        let window = crate::window::main_window(app).ok();
        let main_window_available = Some(window.is_some());
        let main_visible = window.as_ref().and_then(|window| window.is_visible().ok());
        let main_focused = window.as_ref().and_then(|window| window.is_focused().ok());
        let native_state = window
            .as_ref()
            .and_then(|window| window.ns_window().ok())
            .filter(|pointer| !pointer.is_null())
            .map(|pointer| {
                // Tauri owns the live main window; this runs synchronously on AppKit's main thread.
                let native_window = unsafe { &*pointer.cast::<NSWindow>() };
                (
                    native_window.isKeyWindow(),
                    native_window.isOnActiveSpace(),
                    native_window
                        .occlusionState()
                        .contains(NSWindowOcclusionState::Visible),
                )
            });

        Self {
            app_active: Some(application.isActive()),
            app_hidden: Some(application.isHidden()),
            frontmost_is_self,
            main_window_available,
            main_visible,
            main_key: native_state.map(|state| state.0),
            main_focused,
            main_on_active_space: native_state.map(|state| state.1),
            main_occlusion_visible: native_state.map(|state| state.2),
        }
    }

    pub(super) fn meets_foreground_conditions(self) -> bool {
        self.app_active == Some(true)
            && self.app_hidden == Some(false)
            && self.frontmost_is_self == Some(true)
            && self.main_window_available == Some(true)
            && self.main_visible == Some(true)
            && self.main_key == Some(true)
            && self.main_focused == Some(true)
            && self.main_on_active_space == Some(true)
            && self.main_occlusion_visible == Some(true)
    }

    pub(super) fn diagnostic_fields(self) -> String {
        format!(
            "{{appActive={}, appHidden={}, frontmostIsSelf={}, mainWindowAvailable={}, mainVisible={}, mainKey={}, mainFocused={}, mainOnActiveSpace={}, mainOcclusionVisible={}}}",
            display(self.app_active),
            display(self.app_hidden),
            display(self.frontmost_is_self),
            display(self.main_window_available),
            display(self.main_visible),
            display(self.main_key),
            display(self.main_focused),
            display(self.main_on_active_space),
            display(self.main_occlusion_visible),
        )
    }

    #[cfg(test)]
    pub(super) fn foreground() -> Self {
        Self {
            app_active: Some(true),
            app_hidden: Some(false),
            frontmost_is_self: Some(true),
            main_window_available: Some(true),
            main_visible: Some(true),
            main_key: Some(true),
            main_focused: Some(true),
            main_on_active_space: Some(true),
            main_occlusion_visible: Some(true),
        }
    }

    #[cfg(test)]
    pub(super) fn not_foreground() -> Self {
        Self {
            app_active: Some(false),
            app_hidden: Some(false),
            frontmost_is_self: Some(false),
            main_window_available: Some(false),
            main_visible: Some(false),
            main_key: Some(false),
            main_focused: Some(false),
            main_on_active_space: Some(false),
            main_occlusion_visible: Some(false),
        }
    }
}

fn display(value: Option<bool>) -> &'static str {
    match value {
        Some(true) => "true",
        Some(false) => "false",
        None => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::ForegroundSnapshot;

    #[test]
    fn foreground_requires_every_actual_application_and_window_condition() {
        let foreground = ForegroundSnapshot::foreground();
        assert!(foreground.meets_foreground_conditions());
        let variants = [
            ForegroundSnapshot {
                app_active: Some(false),
                ..foreground
            },
            ForegroundSnapshot {
                app_hidden: Some(true),
                ..foreground
            },
            ForegroundSnapshot {
                frontmost_is_self: Some(false),
                ..foreground
            },
            ForegroundSnapshot {
                main_window_available: Some(false),
                ..foreground
            },
            ForegroundSnapshot {
                main_visible: Some(false),
                ..foreground
            },
            ForegroundSnapshot {
                main_key: Some(false),
                ..foreground
            },
            ForegroundSnapshot {
                main_focused: Some(false),
                ..foreground
            },
            ForegroundSnapshot {
                main_on_active_space: Some(false),
                ..foreground
            },
            ForegroundSnapshot {
                main_occlusion_visible: Some(false),
                ..foreground
            },
            ForegroundSnapshot {
                main_focused: None,
                ..foreground
            },
        ];
        assert!(variants
            .into_iter()
            .all(|snapshot| !snapshot.meets_foreground_conditions()));
    }

    #[test]
    fn diagnostics_keep_unknown_state_distinct_from_false() {
        let snapshot = ForegroundSnapshot {
            main_key: None,
            ..ForegroundSnapshot::foreground()
        };
        assert!(snapshot.diagnostic_fields().contains("mainKey=unknown"));
    }

    #[cfg(feature = "legacy-node-smoke")]
    #[test]
    fn activation_failure_json_has_fixed_nullable_snapshot_schema() {
        use serde_json::{json, Value};
        use std::collections::BTreeSet;

        let before = ForegroundSnapshot {
            main_key: None,
            ..ForegroundSnapshot::not_foreground()
        };
        let after = ForegroundSnapshot {
            app_hidden: None,
            main_occlusion_visible: None,
            ..ForegroundSnapshot::not_foreground()
        };
        let encoded =
            super::activation_failure_json(false, true, "unknown(7)", false, before, after)
                .unwrap();
        let observation: Value = serde_json::from_str(&encoded).unwrap();
        let object = observation.as_object().unwrap();
        let keys = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
        assert_eq!(
            keys,
            BTreeSet::from([
                "activationPolicy",
                "after",
                "before",
                "finishedLaunching",
                "kind",
                "pid",
                "requestSent",
                "schemaVersion",
                "terminated",
            ])
        );
        assert_eq!(observation["schemaVersion"], json!(1));
        assert_eq!(observation["kind"], json!("activation-failure"));
        assert!(observation["pid"].as_u64().is_some_and(|pid| pid > 0));
        assert_eq!(observation["activationPolicy"], json!("unknown(7)"));

        let expected_snapshot_keys = BTreeSet::from([
            "appActive",
            "appHidden",
            "frontmostIsSelf",
            "mainFocused",
            "mainKey",
            "mainOcclusionVisible",
            "mainOnActiveSpace",
            "mainVisible",
            "mainWindowAvailable",
        ]);
        for snapshot_name in ["before", "after"] {
            let snapshot = observation[snapshot_name].as_object().unwrap();
            let keys = snapshot.keys().map(String::as_str).collect::<BTreeSet<_>>();
            assert_eq!(keys, expected_snapshot_keys);
            assert!(snapshot
                .values()
                .all(|value| value.is_boolean() || value.is_null()));
            assert!(snapshot.get("windowTitle").is_none());
            assert!(snapshot.get("path").is_none());
        }
        assert_eq!(observation["before"]["mainKey"], Value::Null);
        assert_eq!(observation["after"]["appHidden"], Value::Null);
        assert_eq!(observation["after"]["mainOcclusionVisible"], Value::Null);
    }
}
