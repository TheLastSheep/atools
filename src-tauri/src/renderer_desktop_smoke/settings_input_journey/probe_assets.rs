pub(super) fn action_script(role: &str, method: &str, probe_id: u64, args: &[&str]) -> String {
    let args = if args.is_empty() {
        probe_id.to_string()
    } else {
        format!("{probe_id},{}", args.join(","))
    };
    let probe_name = if method.starts_with("hotkeyStartup") {
        "HOTKEY_STARTUP"
    } else if method.starts_with("launchAtLogin") {
        "LAUNCH_AT_LOGIN"
    } else if method.starts_with("commandAvailability") {
        "AVAILABILITY"
    } else if method.starts_with("commandAliases") {
        "COMMAND_ALIASES"
    } else if method.starts_with("localAppSearch") {
        "LOCAL_APP_SEARCH"
    } else if method.starts_with("pluginInventory") {
        "PLUGIN_INVENTORY"
    } else if method.starts_with("windowOpacity") {
        "WINDOW_OPACITY"
    } else if method.starts_with("trayVisibility") {
        "TRAY_VISIBILITY"
    } else if method.starts_with("generalPolicies") {
        "GENERAL_POLICIES"
    } else if method.starts_with("mainHotkey") {
        "MAIN_HOTKEY"
    } else {
        match (role, method) {
            ("MAIN", "inspectMainTheme")
            | (
                "CHILD",
                "inspectCurrentTheme"
                | "navigateGeneral"
                | "selectGeneralTheme"
                | "childSnapshotReady"
                | "childPaintDiagnostic",
            ) => "MATERIAL",
            ("MAIN", _) => "MAIN",
            _ => "CHILD",
        }
    };
    let availability_probe = if method.starts_with("commandAvailability") {
        include_str!("command-availability-probe.js")
    } else {
        ""
    };
    let command_aliases_probe = if method.starts_with("commandAliases") {
        if role == "MAIN" {
            include_str!("command-aliases-main-probe.js")
        } else {
            include_str!("command-aliases-probe.js")
        }
    } else {
        ""
    };
    let local_app_search_probe = if method.starts_with("localAppSearch") {
        include_str!("local-app-search-probe.js")
    } else {
        ""
    };
    let plugin_inventory_probe = if method.starts_with("pluginInventory") {
        include_str!("plugin-inventory-probe.js")
    } else {
        ""
    };
    let window_opacity_probe = if method.starts_with("windowOpacity") {
        include_str!("window-opacity-probe.js")
    } else {
        ""
    };
    let tray_visibility_probe = if method.starts_with("trayVisibility") {
        include_str!("tray-visibility-probe.js")
    } else {
        ""
    };
    let main_hotkey_probe = if method.starts_with("mainHotkey") {
        include_str!("main-hotkey-probe.js")
    } else {
        ""
    };
    let hotkey_startup_probe = if method.starts_with("hotkeyStartup") {
        include_str!("main_hotkey_startup/main-hotkey-startup-probe.js")
    } else {
        ""
    };
    let general_policies_probe = if method.starts_with("generalPolicies") {
        include_str!("general-policies-probe.js")
    } else {
        ""
    };
    let launch_at_login_probe = if method.starts_with("launchAtLogin") {
        include_str!("launch-at-login-probe.js")
    } else {
        ""
    };
    if role == "MAIN" {
        format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nwindow.__ATOOLS_SETTINGS_INPUT_{probe_name}__.{method}({args});",
            include_str!("main-probe.js"),
            include_str!("material-probe.js"),
            command_aliases_probe,
            availability_probe,
            local_app_search_probe,
            plugin_inventory_probe,
            window_opacity_probe,
            tray_visibility_probe,
            main_hotkey_probe,
            hotkey_startup_probe,
            general_policies_probe,
            launch_at_login_probe,
        )
    } else {
        format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nwindow.__ATOOLS_SETTINGS_INPUT_{probe_name}__.{method}({args});",
            include_str!("child-probe.js"),
            include_str!("material-probe.js"),
            command_aliases_probe,
            availability_probe,
            local_app_search_probe,
            plugin_inventory_probe,
            window_opacity_probe,
            tray_visibility_probe,
            main_hotkey_probe,
            hotkey_startup_probe,
            general_policies_probe,
            launch_at_login_probe,
        )
    }
}
