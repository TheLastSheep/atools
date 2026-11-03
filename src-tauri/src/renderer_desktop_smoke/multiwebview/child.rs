use super::Harness;
use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl, Wry,
};

pub(super) const CHILD_LABEL: &str = "renderer-settings-probe";
const CHILD_DOCUMENT: &str = "multiwebview-child.html";
const RESOURCE_PROBE: &str = "renderer-multiwebview-probe.txt";

pub(super) fn resource_probe_path() -> Result<PathBuf, &'static str> {
    let executable =
        std::env::current_exe().map_err(|_| "multiwebview-executable-path-unavailable")?;
    let contents = executable
        .parent()
        .and_then(Path::parent)
        .ok_or("multiwebview-app-contents-path-unavailable")?;
    let path = contents.join("Resources").join(RESOURCE_PROBE);
    if !path.is_absolute() || !path.is_file() {
        return Err("multiwebview-owned-resource-probe-missing");
    }
    Ok(path)
}

pub(super) fn create(
    app: &AppHandle,
    harness: &Harness,
    nonce: &str,
    generation: u8,
    resource_path: &Path,
) -> Result<Webview<Wry>, &'static str> {
    if app.get_webview(CHILD_LABEL).is_some() {
        return Err("multiwebview-child-already-exists");
    }
    let parent =
        crate::window::main_window(app).map_err(|_| "multiwebview-main-window-unavailable")?;
    let available = parent
        .inner_size()
        .map_err(|_| "multiwebview-parent-size-unavailable")?;
    let scale = parent
        .scale_factor()
        .map_err(|_| "multiwebview-parent-scale-unavailable")?;
    if available.width == 0 || available.height == 0 || !scale.is_finite() || scale <= 0.0 {
        return Err("multiwebview-parent-bounds-invalid");
    }
    let logical_width = f64::from(available.width) / scale;
    let logical_height = f64::from(available.height) / scale;
    if logical_height <= 65.0 {
        return Err("multiwebview-parent-viewport-insufficient");
    }
    let reserved_top = 64.0;
    let child_height = logical_height - reserved_top;
    let init = serde_json::to_string(&json!({
        "nonce": nonce,
        "generation": generation,
        "resourcePath": resource_path,
    }))
    .map_err(|_| "multiwebview-child-config-serialize-failed")?;
    let init = format!("window.__ATOOLS_MULTIWEBVIEW_CONFIG__ = {init};");
    let navigation_harness = harness.clone();
    let webview_builder = WebviewBuilder::new(CHILD_LABEL, WebviewUrl::App(CHILD_DOCUMENT.into()))
        .incognito(true)
        .initialization_script(init)
        .on_navigation(move |url| {
            if url.scheme() == "atools-multiwebview-probe" {
                navigation_harness.accept_child_navigation(url);
                return false;
            }
            is_expected_child_document(url)
        });
    let child = parent
        .add_child(
            webview_builder,
            LogicalPosition::new(0.0, reserved_top),
            LogicalSize::new(logical_width, child_height),
        )
        .map_err(|_| "multiwebview-child-create-failed")?;
    let lease = match crate::window::attach_main_child_layout(app, &child, 64) {
        Ok(lease) => lease,
        Err(_) => {
            let _ = child.close();
            return Err("multiwebview-child-layout-registration-failed");
        }
    };
    if let Err(lease) = harness.install_layout_lease(lease) {
        drop(lease);
        let _ = child.close();
        return Err("multiwebview-child-layout-lease-already-held");
    }
    Ok(child)
}

fn is_expected_child_document(url: &tauri::Url) -> bool {
    let local_origin = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    local_origin
        && url.path() == "/multiwebview-child.html"
        && url.query().is_none()
        && url.fragment().is_none()
}
