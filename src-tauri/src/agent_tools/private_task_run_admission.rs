use atools_core::db::Database;
use serde_json::Value;
use tauri::AppHandle;

pub(super) fn validate_request(
    app: &AppHandle,
    db: &Database,
    client_id: &str,
    tool_name: &str,
    arguments: &Value,
) -> Result<(), String> {
    crate::legacy_runtime::validate_private_request(app, db, client_id, tool_name, arguments)
        .and_then(|()| crate::launcher_media_clipboard::validate_request(tool_name, arguments))
        .and_then(|()| crate::launcher_clipboard_context::validate_request(tool_name, arguments))
        .and_then(|()| {
            crate::plugin_file_drop::commands::validate_private_request(
                app, db, client_id, tool_name, arguments,
            )
            .and_then(|()| {
                crate::plugin_file_drag::validate_private_request(
                    app, db, client_id, tool_name, arguments,
                )
            })
            .and_then(|()| {
                crate::plugin_ai_runtime::privacy::validate_private_request(
                    app, db, client_id, tool_name, arguments,
                )
            })
            .and_then(|()| {
                crate::plugin_background_runtime::validate_private_request(
                    app, db, client_id, tool_name, arguments,
                )
            })
        })
}
