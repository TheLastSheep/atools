use super::state::{Harness, Receipt};
use serde_json::Value;
use tauri::{ipc::Invoke, AppHandle, State, Webview, Wry};

const MAIN_LABEL: &str = "main";
const RECEIPT_COMMAND: &str = "renderer_launcher_receipt";

pub(in crate::renderer_desktop_smoke) fn handler(
) -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![renderer_launcher_receipt]
}

pub(in crate::renderer_desktop_smoke) fn handles(command: &str) -> bool {
    command == RECEIPT_COMMAND
}

#[tauri::command]
fn renderer_launcher_receipt(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    harness: State<'_, Harness>,
    receipt: Value,
) -> Result<(), String> {
    validate_main_webview(&app, &webview).map_err(str::to_owned)?;
    if serde_json::to_vec(&receipt).map_or(true, |bytes| bytes.len() > 4096) {
        harness.record_error("launcher-operation-protocol-rejected");
        return Err("launcher-operation-protocol-rejected".to_owned());
    }
    let receipt: Receipt = serde_json::from_value(receipt).map_err(|_| {
        harness.record_error("launcher-operation-protocol-rejected");
        "launcher-operation-protocol-rejected".to_owned()
    })?;
    harness.accept(receipt).map_err(str::to_owned)
}

fn validate_main_webview(app: &AppHandle<Wry>, webview: &Webview<Wry>) -> Result<(), &'static str> {
    if webview.label() != MAIN_LABEL || webview.window().label() != MAIN_LABEL {
        return Err("launcher-operation-protocol-rejected");
    }
    let url = webview
        .url()
        .map_err(|_| "launcher-operation-protocol-rejected")?;
    if !crate::renderer_desktop_smoke::controller::is_local_root_url(&url) {
        return Err("launcher-operation-protocol-rejected");
    }
    let primary =
        crate::window::main_webview(app).map_err(|_| "launcher-operation-protocol-rejected")?;
    if primary.label() != webview.label() || primary.window().label() != MAIN_LABEL {
        return Err("launcher-operation-protocol-rejected");
    }
    Ok(())
}
