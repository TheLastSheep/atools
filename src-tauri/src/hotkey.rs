use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const PASTE_STACK_SHORTCUT: &str = "Cmd+V";

pub fn setup_hotkey(app: &AppHandle) -> tauri::Result<()> {
    let shortcut = configured_hotkey(app);
    register_hotkey(app, &shortcut)?;
    let pasteboard_shortcut = configured_pasteboard_hotkey(app);
    if let Err(error) = register_pasteboard_hotkey(app, &pasteboard_shortcut) {
        tracing::warn!(shortcut = pasteboard_shortcut, %error, "Failed to register Paste clipboard hotkey");
    }
    Ok(())
}

pub fn update_hotkey(app: &AppHandle, shortcut: &str) -> tauri::Result<()> {
    let previous = configured_hotkey(app);
    update_hotkey_from(app, &previous, shortcut)
}

pub(crate) fn update_hotkey_from(
    app: &AppHandle,
    previous: &str,
    requested: &str,
) -> tauri::Result<()> {
    update_shortcut_transaction(
        previous,
        requested,
        |shortcut| register_hotkey(app, shortcut).map_err(|error| error.to_string()),
        |shortcut| {
            app.global_shortcut()
                .unregister(shortcut)
                .map_err(|error| error.to_string())
        },
        |shortcut| app.global_shortcut().is_registered(shortcut),
    )
    .map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))
}

pub(crate) fn is_shortcut_registered(app: &AppHandle, shortcut: &str) -> bool {
    let shortcut = normalize_shortcut(shortcut);
    app.global_shortcut().is_registered(shortcut.as_str())
}

pub(crate) fn activate_paste_stack_shortcut(app: &AppHandle) -> tauri::Result<()> {
    if app.global_shortcut().is_registered(PASTE_STACK_SHORTCUT) {
        return Ok(());
    }
    register_paste_stack_shortcut(app)
}

pub(crate) fn deactivate_paste_stack_shortcut(app: &AppHandle) -> tauri::Result<()> {
    if app.global_shortcut().is_registered(PASTE_STACK_SHORTCUT) {
        app.global_shortcut()
            .unregister(PASTE_STACK_SHORTCUT)
            .map_err(|error| tauri::Error::Anyhow(error.into()))?;
    }
    Ok(())
}

fn register_paste_stack_shortcut(app: &AppHandle) -> tauri::Result<()> {
    let handle = app.clone();
    app.global_shortcut()
        .on_shortcut(PASTE_STACK_SHORTCUT, move |_app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = deactivate_paste_stack_shortcut(&handle) {
                    tracing::warn!(%error, "Failed to suspend Paste Stack shortcut");
                }
                let state = handle.state::<crate::state::AppState>();
                let Some(item_id) = state.pasteboard_runtime.pop_paste_stack_item() else {
                    let status = state.pasteboard_runtime.paste_stack_status();
                    let _ = handle.emit("pasteboard://stack", status);
                    return;
                };
                let result = state.pasteboard_runtime.paste_item(&item_id, false).await;
                let status = state.pasteboard_runtime.paste_stack_status();
                let _ = handle.emit("pasteboard://stack", &status);
                if let Err(error) = result {
                    tracing::error!(%error, item_id, "Paste Stack item failed");
                }
                if status.active {
                    if let Err(error) = register_paste_stack_shortcut(&handle) {
                        tracing::error!(%error, "Failed to re-arm Paste Stack shortcut");
                    }
                }
            });
        })
        .map_err(|error| tauri::Error::Anyhow(error.into()))?;
    Ok(())
}

fn register_hotkey(app: &AppHandle, shortcut: &str) -> tauri::Result<()> {
    let handle = app.clone();
    let shortcut = normalize_shortcut(shortcut);
    app.global_shortcut()
        .on_shortcut(shortcut.as_str(), move |_app, _shortcut, event| {
            tracing::debug!(state = ?event.state, "Global shortcut event received");
            if event.state == ShortcutState::Pressed {
                if let Err(error) = toggle_main_window(&handle) {
                    tracing::error!("Failed to toggle main window from global shortcut: {error}");
                }
            }
        })
        .map_err(|e| tauri::Error::Anyhow(e.into()))?;
    tracing::info!(shortcut, "Global shortcut registered");
    Ok(())
}

fn register_pasteboard_hotkey(app: &AppHandle, shortcut: &str) -> tauri::Result<()> {
    let handle = app.clone();
    let shortcut = normalize_shortcut(shortcut);
    app.global_shortcut()
        .on_shortcut(shortcut.as_str(), move |_app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            if let Err(error) = crate::pasteboard_window::toggle_pasteboard_shelf(&handle) {
                tracing::error!(%error, "Failed to toggle Paste clipboard shelf from global shortcut");
            }
        })
        .map_err(|error| tauri::Error::Anyhow(error.into()))?;
    tracing::info!(shortcut, "Paste clipboard global shortcut registered");
    Ok(())
}

fn update_shortcut_transaction<Register, Unregister, IsRegistered>(
    previous: &str,
    requested: &str,
    mut register: Register,
    mut unregister: Unregister,
    mut is_registered: IsRegistered,
) -> Result<(), String>
where
    Register: FnMut(&str) -> Result<(), String>,
    Unregister: FnMut(&str) -> Result<(), String>,
    IsRegistered: FnMut(&str) -> bool,
{
    let previous = normalize_shortcut(previous);
    let requested = normalize_shortcut(requested);

    if previous == requested {
        if is_registered(&requested) {
            return Ok(());
        }
        return register(&requested)
            .map_err(|error| format!("failed to register hotkey `{requested}`: {error}"));
    }

    register(&requested)
        .map_err(|error| format!("failed to register new hotkey `{requested}`: {error}"))?;

    if let Err(unregister_error) = unregister(&previous) {
        let rollback_error = unregister(&requested).err();
        let mut message =
            format!("failed to unregister previous hotkey `{previous}`: {unregister_error}");
        if let Some(rollback_error) = rollback_error {
            message.push_str(&format!(
                "; failed to roll back new hotkey `{requested}`: {rollback_error}"
            ));
        }
        return Err(message);
    }

    Ok(())
}

fn configured_hotkey(app: &AppHandle) -> String {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return default_hotkey_label().to_string();
    };
    let Ok(Some(value)) = state.db.get_setting("settings-general") else {
        return default_hotkey_label().to_string();
    };
    serde_json::from_str::<serde_json::Value>(&value)
        .ok()
        .and_then(|json| {
            json.get("hotkey")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| default_hotkey_label().to_string())
}

pub(crate) fn configured_pasteboard_hotkey(app: &AppHandle) -> String {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return default_pasteboard_hotkey_label().to_string();
    };
    let Ok(Some(value)) = state.db.get_setting("settings-general") else {
        return default_pasteboard_hotkey_label().to_string();
    };
    serde_json::from_str::<serde_json::Value>(&value)
        .ok()
        .and_then(|json| {
            json.get("pasteboardHotkey")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned)
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_pasteboard_hotkey_label().to_string())
}

fn default_pasteboard_hotkey_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Shift+Cmd+V"
    } else {
        "Shift+Alt+V"
    }
}

fn default_hotkey_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Option+Z"
    } else {
        "Alt+Z"
    }
}

fn normalize_shortcut(shortcut: &str) -> String {
    shortcut
        .trim()
        .replace("Option+", "Alt+")
        .replace("option+", "Alt+")
        .replace("Command+", "Cmd+")
        .replace("command+", "Cmd+")
}

pub(crate) fn toggle_main_window(app: &AppHandle) -> tauri::Result<bool> {
    let is_visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if !is_visible && wakeup_blacklisted(app) {
        return Ok(false);
    }
    crate::window::toggle_main_window(app)
}

fn wakeup_blacklisted(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return false;
    };
    let settings = state.db.get_setting("settings-general").ok().flatten();
    should_suppress_wakeup_for_foreground_app(
        settings.as_deref(),
        read_foreground_app_name().as_deref(),
    )
}

fn should_suppress_wakeup_for_foreground_app(
    settings_json: Option<&str>,
    foreground_app: Option<&str>,
) -> bool {
    let foreground_app = normalize_wakeup_app_name(foreground_app.unwrap_or_default());
    if foreground_app.is_empty() {
        return false;
    }
    wakeup_blacklist_from_settings(settings_json)
        .iter()
        .any(|app| normalize_wakeup_app_name(app) == foreground_app)
}

fn wakeup_blacklist_from_settings(settings_json: Option<&str>) -> Vec<String> {
    let Some(settings_json) = settings_json else {
        return Vec::new();
    };
    serde_json::from_str::<serde_json::Value>(settings_json)
        .ok()
        .and_then(|json| json.get("wakeupBlacklist").cloned())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(ToOwned::to_owned))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn normalize_wakeup_app_name(value: &str) -> String {
    value.trim().to_lowercase()
}

pub(crate) fn read_foreground_app_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;

        let workspace = NSWorkspace::sharedWorkspace();
        let value = workspace
            .frontmostApplication()?
            .localizedName()?
            .to_string();
        let value = value.trim().to_string();
        return (!value.is_empty()).then_some(value);
    }

    #[cfg(not(target_os = "macos"))]
    None
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::HashSet};

    use super::{
        normalize_shortcut, should_suppress_wakeup_for_foreground_app, update_shortcut_transaction,
    };

    #[derive(Default)]
    struct FakeShortcuts {
        registered: RefCell<HashSet<String>>,
        operations: RefCell<Vec<String>>,
        register_failures: HashSet<String>,
        unregister_failures: HashSet<String>,
    }

    impl FakeShortcuts {
        fn with_registered(shortcut: &str) -> Self {
            Self {
                registered: RefCell::new(HashSet::from([shortcut.to_string()])),
                ..Self::default()
            }
        }

        fn register(&self, shortcut: &str) -> Result<(), String> {
            self.operations
                .borrow_mut()
                .push(format!("register:{shortcut}"));
            if self.register_failures.contains(shortcut) {
                return Err(format!("register {shortcut} failed"));
            }
            self.registered.borrow_mut().insert(shortcut.to_string());
            Ok(())
        }

        fn unregister(&self, shortcut: &str) -> Result<(), String> {
            self.operations
                .borrow_mut()
                .push(format!("unregister:{shortcut}"));
            if self.unregister_failures.contains(shortcut) {
                return Err(format!("unregister {shortcut} failed"));
            }
            self.registered.borrow_mut().remove(shortcut);
            Ok(())
        }

        fn is_registered(&self, shortcut: &str) -> bool {
            self.registered.borrow().contains(shortcut)
        }
    }

    fn update(fake: &FakeShortcuts, previous: &str, requested: &str) -> Result<(), String> {
        update_shortcut_transaction(
            previous,
            requested,
            |shortcut| fake.register(shortcut),
            |shortcut| fake.unregister(shortcut),
            |shortcut| fake.is_registered(shortcut),
        )
    }

    #[test]
    fn registration_failure_keeps_previous_shortcut_without_unregistering() {
        let mut fake = FakeShortcuts::with_registered("Alt+Z");
        fake.register_failures.insert("Alt+X".to_string());

        let error = update(&fake, "Alt+Z", "Alt+X").expect_err("registration should fail");

        assert!(error.contains("register Alt+X failed"));
        assert!(fake.is_registered("Alt+Z"));
        assert!(!fake.is_registered("Alt+X"));
        assert_eq!(&*fake.operations.borrow(), &["register:Alt+X"]);
    }

    #[test]
    fn successful_update_registers_new_before_unregistering_only_previous() {
        let fake = FakeShortcuts::with_registered("Alt+Z");

        update(&fake, "Alt+Z", "Alt+X").expect("transaction should succeed");

        assert!(!fake.is_registered("Alt+Z"));
        assert!(fake.is_registered("Alt+X"));
        assert_eq!(
            &*fake.operations.borrow(),
            &["register:Alt+X", "unregister:Alt+Z"]
        );
    }

    #[test]
    fn previous_unregister_failure_rolls_back_new_shortcut() {
        let mut fake = FakeShortcuts::with_registered("Alt+Z");
        fake.unregister_failures.insert("Alt+Z".to_string());

        let error = update(&fake, "Alt+Z", "Alt+X").expect_err("unregister should fail");

        assert!(error.contains("unregister Alt+Z failed"));
        assert!(fake.is_registered("Alt+Z"));
        assert!(!fake.is_registered("Alt+X"));
        assert_eq!(
            &*fake.operations.borrow(),
            &["register:Alt+X", "unregister:Alt+Z", "unregister:Alt+X"]
        );
    }

    #[test]
    fn rollback_failure_is_included_with_previous_unregister_error() {
        let mut fake = FakeShortcuts::with_registered("Alt+Z");
        fake.unregister_failures.insert("Alt+Z".to_string());
        fake.unregister_failures.insert("Alt+X".to_string());

        let error = update(&fake, "Alt+Z", "Alt+X").expect_err("rollback should fail");

        assert!(error.contains("unregister Alt+Z failed"));
        assert!(error.contains("unregister Alt+X failed"));
        assert!(fake.is_registered("Alt+Z"));
        assert!(fake.is_registered("Alt+X"));
    }

    #[test]
    fn normalized_same_shortcut_is_noop_when_already_registered() {
        let fake = FakeShortcuts::with_registered("Alt+Z");

        update(&fake, "Option+Z", "Alt+Z").expect("registered shortcut should be a no-op");

        assert!(fake.operations.borrow().is_empty());
    }

    #[test]
    fn normalized_same_shortcut_registers_when_missing() {
        let fake = FakeShortcuts::default();

        update(&fake, "Option+Z", "Alt+Z").expect("missing shortcut should be registered");

        assert!(fake.is_registered("Alt+Z"));
        assert_eq!(&*fake.operations.borrow(), &["register:Alt+Z"]);
    }

    #[test]
    fn normalizes_macos_option_label_for_tauri_shortcut() {
        assert_eq!(normalize_shortcut("Option+Z"), "Alt+Z");
    }

    #[test]
    fn leaves_alt_shortcut_unchanged() {
        assert_eq!(normalize_shortcut("Alt+Z"), "Alt+Z");
    }

    #[test]
    fn suppresses_wakeup_when_foreground_app_matches_blacklist() {
        let settings = r#"{"wakeupBlacklist":["Terminal","Visual Studio Code"]}"#;

        assert!(should_suppress_wakeup_for_foreground_app(
            Some(settings),
            Some("terminal")
        ));
        assert!(should_suppress_wakeup_for_foreground_app(
            Some(settings),
            Some("Visual Studio Code")
        ));
        assert!(!should_suppress_wakeup_for_foreground_app(
            Some(settings),
            Some("Finder")
        ));
        assert!(!should_suppress_wakeup_for_foreground_app(
            Some(settings),
            None
        ));
    }

    #[test]
    fn ignores_empty_or_invalid_wakeup_blacklist_settings() {
        assert!(!should_suppress_wakeup_for_foreground_app(
            Some(r#"{"wakeupBlacklist":["  ","Terminal"]}"#),
            Some("")
        ));
        assert!(!should_suppress_wakeup_for_foreground_app(
            Some(r#"{"wakeupBlacklist":"Terminal"}"#),
            Some("Terminal")
        ));
        assert!(!should_suppress_wakeup_for_foreground_app(
            Some("not-json"),
            Some("Terminal")
        ));
    }

    #[test]
    fn command_shortcut_normalization_is_stable_for_registration_and_lookup() {
        let raw = "Command+Space";
        let normalized = normalize_shortcut(raw);
        assert_eq!(normalized, "Cmd+Space");
        assert_eq!(normalize_shortcut("Cmd+Space"), "Cmd+Space");
        assert_eq!(normalize_shortcut("command+Space"), "Cmd+Space");
    }
}
