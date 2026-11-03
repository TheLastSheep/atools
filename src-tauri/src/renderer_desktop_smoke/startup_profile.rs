use super::profile::Profile;
use tauri::{Builder, Wry};

fn settings_input_owns_main_hotkey(profile: &Profile) -> bool {
    profile.settings_input_journey && !profile.builtin_state_journey
}

pub(super) fn startup_label(profile: &Profile) -> &'static str {
    if profile.manual_ui {
        "isolated-manual-with-owned-shortcut-plugin"
    } else if profile.main_panel_journey {
        "isolated-main-panel-prototype"
    } else if settings_input_owns_main_hotkey(profile) {
        "isolated-with-owned-tray-and-main-hotkey"
    } else if profile.settings_input_journey || profile.builtin_state_journey {
        "isolated-with-owned-tray-only"
    } else {
        "isolated-without-desktop-services"
    }
}

pub(super) fn with_profile_plugins(builder: Builder<Wry>, profile: &Profile) -> Builder<Wry> {
    if profile.main_panel_journey {
        #[cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]
        {
            return builder.plugin(tauri_nspanel::init());
        }
        #[cfg(not(all(target_os = "macos", feature = "macos-main-panel-prototype")))]
        {
            return builder;
        }
    }
    if installs_shortcut_plugin(profile) {
        builder.plugin(tauri_plugin_global_shortcut::Builder::new().build())
    } else {
        builder
    }
}

fn installs_shortcut_plugin(profile: &Profile) -> bool {
    profile.manual_ui || settings_input_owns_main_hotkey(profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manual_installs_plugin_without_initial_main_ownership() {
        let run = "0123456789abcdef0123456789abcdef";
        let root = format!("/private/tmp/atools-renderer-manual-{run}");
        let args = [
            "--fixture-root",
            &root,
            "--renderer-dist",
            "/private/tmp/dist",
            "--output",
            &format!("{root}/report.json"),
            "--auto-clear",
            "never",
            "--journey",
            "manual-ui",
            "--run-id",
            run,
        ]
        .map(str::to_owned);
        let profile = Profile::from_args(&args).unwrap();
        assert!(installs_shortcut_plugin(&profile));
        assert!(!settings_input_owns_main_hotkey(&profile));
    }
}
