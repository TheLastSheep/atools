use tauri::{AppHandle, Manager, Webview, Window};

fn missing_main_role(role: &str) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!("Main {role} with label 'main' is unavailable"),
    )
}

#[cfg(feature = "ztools-multiwebview")]
pub(crate) fn main_window(app: &AppHandle) -> tauri::Result<Window> {
    let window = app
        .get_window("main")
        .ok_or_else(|| missing_main_role("window"))?;
    Ok(window)
}

#[cfg(not(feature = "ztools-multiwebview"))]
pub(crate) fn main_window(app: &AppHandle) -> tauri::Result<Window> {
    let webview_window = app
        .get_webview_window("main")
        .ok_or_else(|| missing_main_role("window"))?;
    Ok(webview_window.as_ref().window())
}

#[cfg(feature = "ztools-multiwebview")]
pub(crate) fn main_webview(app: &AppHandle) -> tauri::Result<Webview> {
    let webview = app
        .get_webview("main")
        .ok_or_else(|| missing_main_role("webview"))?;
    Ok(webview)
}

#[cfg(not(feature = "ztools-multiwebview"))]
pub(crate) fn main_webview(app: &AppHandle) -> tauri::Result<Webview> {
    let webview_window = app
        .get_webview_window("main")
        .ok_or_else(|| missing_main_role("webview"))?;
    let webview: &Webview = webview_window.as_ref();
    Ok(webview.clone())
}
