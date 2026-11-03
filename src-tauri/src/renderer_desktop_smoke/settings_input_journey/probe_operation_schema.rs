const MAIN_OPERATIONS: &[&str] = &[
    "mainUpdater",
    "mainOpenSettings",
    "mainOpenState",
    "mainInspect",
    "mainInput",
    "mainValue",
    "mainPinnedSearch",
    "mainThemeInspect",
    "mainPluginInventory",
];
const CHILD_OPERATIONS: &[&str] = &[
    "childBaseline",
    "childTarget",
    "childNoMatch",
    "childClear",
    "childReopenBaseline",
    "childOwnerRoute",
    "childValue",
    "childStale",
    "childRetiredSession",
    "childOut",
    "childPinSearch",
    "childUnpinSearch",
    "childThemeInspect",
    "childThemeNavigate",
    "childThemeSelect",
    "childSnapshotReady",
    "childPaintDiagnostic",
];

pub(super) fn valid_operation(operation: &str, caller: &str) -> bool {
    if super::login_cross_entry_schema::valid_operation(operation, caller) {
        return true;
    }
    if super::command_aliases_schema::valid_operation(operation, caller) {
        return true;
    }
    if super::command_availability_schema::valid_operation(operation, caller) {
        return true;
    }
    if super::local_app_search_schema::valid_operation(operation, caller) {
        return true;
    }
    if super::window_opacity_schema::valid_operation(operation, caller) {
        return true;
    }
    if super::tray_visibility_schema::valid_operation(operation, caller) {
        return true;
    }
    if super::main_hotkey_schema::valid_operation(operation, caller) {
        return true;
    }
    if super::main_hotkey_startup_schema::valid_operation(operation, caller) {
        return true;
    }
    if super::general_policies_schema::valid_operation(operation, caller) {
        return true;
    }
    if super::launch_at_login_schema::valid_operation(operation, caller) {
        return true;
    }
    if operation == "mainReady" {
        return caller == "main";
    }
    if MAIN_OPERATIONS.contains(&operation) {
        return caller == "main";
    }
    CHILD_OPERATIONS.contains(&operation) && caller.starts_with("ztools-settings-")
}
