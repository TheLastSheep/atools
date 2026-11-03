#[cfg(target_os = "macos")]
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};

#[cfg(target_os = "macos")]
use tauri::{webview::NewWindowResponse, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::{AppHandle, Webview, WebviewWindow, Wry};

const SETTINGS_LABEL: &str = "settings";
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq, Eq)]
enum CloseObservation {
    Closed,
    Wait,
    Replaced,
}

#[cfg(any(target_os = "macos", test))]
fn classify_close_observation(
    window: Option<Option<usize>>,
    webview: Option<Option<usize>>,
    expected: usize,
) -> CloseObservation {
    if window.is_none() && webview.is_none() {
        return CloseObservation::Closed;
    }
    if window.is_some_and(|identity| identity.is_some_and(|value| value != expected))
        || webview.is_some_and(|identity| identity.is_some_and(|value| value != expected))
    {
        return CloseObservation::Replaced;
    }
    CloseObservation::Wait
}

#[cfg(target_os = "macos")]
const MAIN_LABEL: &str = "main";
#[cfg(target_os = "macos")]
const FALLBACK_URL: &str = "tauri://localhost/fallback-settings/index.html";
#[cfg(target_os = "macos")]
const FALLBACK_PATH: &str = "/fallback-settings/index.html";
#[cfg(target_os = "macos")]
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(target_os = "macos")]
const OPEN_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(target_os = "macos")]
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const SETTINGS_INPUT_IDENTIFIER: &str = "dev.atools.renderer-settings-input.";

type OwnerKey = (String, usize);

#[cfg(target_os = "macos")]
fn owned_windows() -> &'static Mutex<HashMap<OwnerKey, usize>> {
    static WINDOWS: OnceLock<Mutex<HashMap<OwnerKey, usize>>> = OnceLock::new();
    WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn valid_settings_input_identifier(app: &AppHandle<Wry>) -> bool {
    app.config()
        .identifier
        .strip_prefix(SETTINGS_INPUT_IDENTIFIER)
        .is_some_and(|run_id| {
            run_id.len() == 32
                && run_id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

#[cfg(target_os = "macos")]
fn app_key(app: &AppHandle<Wry>) -> Option<OwnerKey> {
    let main = app.get_webview(MAIN_LABEL)?;
    let pointer = main.window().ns_window().ok()?;
    (!pointer.is_null()).then(|| (app.config().identifier.clone(), pointer as usize))
}

#[cfg(not(target_os = "macos"))]
fn app_key(_app: &AppHandle<Wry>) -> Option<OwnerKey> {
    None
}

#[cfg(target_os = "macos")]
fn window_identity(window: &WebviewWindow<Wry>) -> Option<usize> {
    let pointer = window.ns_window().ok()?;
    (!pointer.is_null()).then_some(pointer as usize)
}

#[cfg(not(target_os = "macos"))]
fn window_identity(_window: &WebviewWindow<Wry>) -> Option<usize> {
    None
}

#[cfg(target_os = "macos")]
fn webview_window_identity(webview: &Webview<Wry>) -> Option<usize> {
    let pointer = webview.window().ns_window().ok()?;
    (!pointer.is_null()).then_some(pointer as usize)
}

#[cfg(not(target_os = "macos"))]
fn webview_window_identity(_webview: &Webview<Wry>) -> Option<usize> {
    None
}

#[cfg(target_os = "macos")]
fn expected_fallback_url(app: &AppHandle<Wry>) -> Option<tauri::Url> {
    let url = tauri::Url::parse(FALLBACK_URL).ok()?;
    let main_url = app.get_webview(MAIN_LABEL)?.url().ok()?;
    (main_url.scheme() == url.scheme()
        && main_url.host_str() == url.host_str()
        && main_url.port() == url.port()
        && main_url.username().is_empty()
        && main_url.password().is_none()
        && url.path() == FALLBACK_PATH
        && url.query().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

#[cfg(target_os = "macos")]
fn exact_current_route(app: &AppHandle<Wry>, webview: &Webview<Wry>) -> bool {
    expected_fallback_url(app).is_some_and(|expected| {
        webview.label() == SETTINGS_LABEL && webview.url().is_ok_and(|actual| actual == expected)
    })
}

pub(super) async fn open(
    app: &AppHandle<Wry>,
) -> Result<(WebviewWindow<Wry>, Webview<Wry>), &'static str> {
    if !valid_settings_input_identifier(app) {
        return Err("settings-input-app-identity-invalid");
    }
    #[cfg(not(target_os = "macos"))]
    return Err("settings-input-fallback-window-unsupported");

    #[cfg(target_os = "macos")]
    {
        let owner_key = app_key(app).ok_or("settings-input-main-window-unavailable")?;
        if app.get_webview_window(SETTINGS_LABEL).is_some()
            || app.get_webview(SETTINGS_LABEL).is_some()
        {
            return Err("settings-input-window-already-exists");
        }
        let expected = expected_fallback_url(app).ok_or("settings-input-fallback-url-invalid")?;
        let expected_navigation = expected.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let builder_app = app.clone();
        app.run_on_main_thread(move || {
            let built = WebviewWindowBuilder::new(
                &builder_app,
                SETTINGS_LABEL,
                WebviewUrl::App(FALLBACK_PATH.into()),
            )
            .visible(false)
            .focused(false)
            .incognito(true)
            // Leaving data_directory unset is Tauri's no-custom-directory mode.
            .on_navigation(move |url| url == &expected_navigation)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .build()
            .map_err(|_| "settings-input-window-create-failed");
            if let Err(unsent) = sender.send(built) {
                if let Ok(window) = unsent {
                    let _ = window.close();
                }
            }
        })
        .map_err(|_| "settings-input-main-thread-dispatch-failed")?;
        let window = receiver
            .await
            .map_err(|_| "settings-input-window-create-failed")??;
        let Some(identity) = window_identity(&window) else {
            let _ = window.close();
            return Err("settings-input-window-identity-unavailable");
        };
        if window.label() != SETTINGS_LABEL {
            close_unpublished_window(app, &window, identity).await;
            return Err("settings-input-window-identity-invalid");
        }
        let ready = wait_for_initial_route(app, &window, identity, &expected).await;
        let webview = match ready {
            Ok(webview) => webview,
            Err(error) => {
                close_unpublished_window(app, &window, identity).await;
                return Err(error);
            }
        };
        let registered = match owned_windows().lock() {
            Ok(mut owners) => {
                owners.insert(owner_key, identity);
                true
            }
            Err(_) => false,
        };
        if !registered {
            close_unpublished_window(app, &window, identity).await;
            return Err("settings-input-window-owner-unavailable");
        }
        Ok((window, webview))
    }
}

#[cfg(target_os = "macos")]
async fn wait_for_initial_route(
    app: &AppHandle<Wry>,
    window: &WebviewWindow<Wry>,
    identity: usize,
    expected: &tauri::Url,
) -> Result<Webview<Wry>, &'static str> {
    let deadline = tokio::time::Instant::now() + OPEN_TIMEOUT;
    loop {
        let current_window = app
            .get_webview_window(SETTINGS_LABEL)
            .ok_or("settings-input-window-identity-invalid")?;
        let webview = app
            .get_webview(SETTINGS_LABEL)
            .ok_or("settings-input-webview-create-failed")?;
        if window_identity(window) != Some(identity)
            || window_identity(&current_window) != Some(identity)
            || webview_window_identity(&webview) != Some(identity)
            || webview.label() != SETTINGS_LABEL
        {
            return Err("settings-input-window-replaced");
        }
        if window
            .is_visible()
            .map_err(|_| "settings-input-window-state-unavailable")?
        {
            return Err("settings-input-window-presentation-invalid");
        }
        if window
            .is_focused()
            .map_err(|_| "settings-input-window-state-unavailable")?
        {
            return Err("settings-input-window-presentation-invalid");
        }
        let actual = webview
            .url()
            .map_err(|_| "settings-input-window-url-unavailable")?;
        if &actual == expected {
            return Ok(webview);
        }
        if actual.as_str() != "about:blank" {
            return Err("settings-input-fallback-url-invalid");
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("settings-input-fallback-navigation-timeout");
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[cfg(target_os = "macos")]
async fn close_unpublished_window(
    app: &AppHandle<Wry>,
    window: &WebviewWindow<Wry>,
    identity: usize,
) {
    let _ = window.close();
    let deadline = tokio::time::Instant::now() + CLOSE_TIMEOUT;
    loop {
        let same_window = app
            .get_webview_window(SETTINGS_LABEL)
            .is_some_and(|candidate| window_identity(&candidate) == Some(identity));
        let same_view = app
            .get_webview(SETTINGS_LABEL)
            .is_some_and(|candidate| webview_window_identity(&candidate) == Some(identity));
        if !same_window && !same_view {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

pub(super) async fn close(
    app: &AppHandle<Wry>,
    window: &WebviewWindow<Wry>,
) -> Result<(), &'static str> {
    if window.label() != SETTINGS_LABEL || !valid_settings_input_identifier(app) {
        return Err("settings-input-window-owner-invalid");
    }
    #[cfg(not(target_os = "macos"))]
    return Err("settings-input-fallback-window-unsupported");

    #[cfg(target_os = "macos")]
    {
        let owner_key = app_key(app).ok_or("settings-input-main-window-unavailable")?;
        let Some(current) = app.get_webview_window(SETTINGS_LABEL) else {
            if app.get_webview(SETTINGS_LABEL).is_some() {
                return Err("settings-input-window-identity-invalid");
            }
            remove_owner(&owner_key, window_identity(window));
            return Ok(());
        };
        let identity =
            window_identity(window).ok_or("settings-input-window-identity-unavailable")?;
        if window_identity(&current) != Some(identity)
            || app.get_webview(SETTINGS_LABEL).is_some_and(|view| {
                webview_window_identity(&view) != Some(identity) || !exact_current_route(app, &view)
            })
            || !is_recorded_owner(&owner_key, identity)
        {
            return Err("settings-input-window-owner-invalid");
        }

        let _ = window.close();
        let deadline = tokio::time::Instant::now() + CLOSE_TIMEOUT;
        loop {
            let current_window = app.get_webview_window(SETTINGS_LABEL);
            let current_view = app.get_webview(SETTINGS_LABEL);
            match classify_close_observation(
                current_window.as_ref().map(window_identity),
                current_view.as_ref().map(webview_window_identity),
                identity,
            ) {
                CloseObservation::Closed => {
                    remove_owner(&owner_key, Some(identity));
                    return Ok(());
                }
                CloseObservation::Replaced => {
                    return Err("settings-input-window-replaced");
                }
                CloseObservation::Wait => {}
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("settings-input-window-close-timeout");
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }
}

pub(super) fn valid_current(app: &AppHandle<Wry>, webview: &Webview<Wry>) -> bool {
    if !valid_settings_input_identifier(app) || webview.label() != SETTINGS_LABEL {
        return false;
    }
    #[cfg(not(target_os = "macos"))]
    return false;

    #[cfg(target_os = "macos")]
    {
        let Some(owner_key) = app_key(app) else {
            return false;
        };
        let Some(window) = app.get_webview_window(SETTINGS_LABEL) else {
            return false;
        };
        let Some(current_view) = app.get_webview(SETTINGS_LABEL) else {
            return false;
        };
        let Some(identity) = window_identity(&window) else {
            return false;
        };
        is_recorded_owner(&owner_key, identity)
            && webview_window_identity(webview) == Some(identity)
            && webview_window_identity(&current_view) == Some(identity)
            && exact_current_route(app, webview)
            && window.is_visible().is_ok_and(|visible| !visible)
            && window.is_focused().is_ok_and(|focused| !focused)
    }
}

#[cfg(target_os = "macos")]
fn is_recorded_owner(key: &OwnerKey, identity: usize) -> bool {
    owned_windows()
        .lock()
        .ok()
        .is_some_and(|owners| owners.get(key) == Some(&identity))
}

#[cfg(target_os = "macos")]
fn remove_owner(key: &OwnerKey, identity: Option<usize>) {
    if let Ok(mut owners) = owned_windows().lock() {
        if identity.is_none() || owners.get(key) == identity.as_ref() {
            owners.remove(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_close_observation, CloseObservation};

    #[test]
    fn close_waits_for_native_handle_to_disappear_from_both_registries() {
        let expected = 42;
        assert_eq!(
            classify_close_observation(Some(None), Some(Some(expected)), expected),
            CloseObservation::Wait
        );
        assert_eq!(
            classify_close_observation(None, Some(None), expected),
            CloseObservation::Wait
        );
        assert_eq!(
            classify_close_observation(None, None, expected),
            CloseObservation::Closed
        );
    }

    #[test]
    fn only_a_known_different_identity_is_replacement() {
        let expected = 42;
        assert_eq!(
            classify_close_observation(Some(Some(43)), None, expected),
            CloseObservation::Replaced
        );
        assert_eq!(
            classify_close_observation(None, Some(Some(43)), expected),
            CloseObservation::Replaced
        );
    }

    #[test]
    fn unknown_identity_stays_waiting_and_cannot_confirm_close() {
        let expected = 42;
        for _ in 0..3 {
            assert_eq!(
                classify_close_observation(Some(None), Some(None), expected),
                CloseObservation::Wait
            );
        }
    }
}
