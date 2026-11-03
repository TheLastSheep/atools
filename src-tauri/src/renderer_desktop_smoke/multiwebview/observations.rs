use std::time::Duration;
use tauri::{Webview, Wry};
use tokio::sync::oneshot;

#[cfg(all(target_os = "macos", feature = "legacy-node-smoke"))]
pub(super) async fn incognito_data_store_persistent(
    webview: &Webview<Wry>,
) -> Result<bool, &'static str> {
    let (sender, receiver) = oneshot::channel();
    webview
        .with_webview(move |platform| {
            use objc2::MainThreadMarker;
            use objc2_web_kit::WKWebView;

            let persistent = if MainThreadMarker::new().is_some() {
                let pointer = platform.inner();
                if pointer.is_null() {
                    None
                } else {
                    let native = unsafe { &*pointer.cast::<WKWebView>() };
                    let configuration = unsafe { native.configuration() };
                    let data_store = unsafe { configuration.websiteDataStore() };
                    Some(unsafe { data_store.isPersistent() })
                }
            } else {
                None
            };
            let _ = sender.send(persistent);
        })
        .map_err(|_| "multiwebview-store-observation-dispatch-failed")?;
    tokio::time::timeout(Duration::from_secs(2), receiver)
        .await
        .map_err(|_| "multiwebview-store-observation-timeout")?
        .map_err(|_| "multiwebview-store-observation-interrupted")?
        .ok_or("multiwebview-store-observation-unavailable")
}

#[cfg(not(all(target_os = "macos", feature = "legacy-node-smoke")))]
pub(super) async fn incognito_data_store_persistent(
    _webview: &Webview<Wry>,
) -> Result<bool, &'static str> {
    Err("multiwebview-store-observation-requires-macos-legacy-smoke")
}
