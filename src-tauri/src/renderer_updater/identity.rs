//! Native labels and exact local document identities; no renderer-supplied origin claims.
use super::*;
use std::sync::atomic::Ordering;
use tauri::{Manager, WebviewWindow};

pub(super) fn popup_url(id: &str, windows: bool) -> String {
    if windows {
        format!("http://atools-updater.localhost/{id}/updater.html")
    } else {
        format!("atools-updater://localhost/{id}/updater.html")
    }
}
pub(super) fn trusted(url: &tauri::Url, id: &str) -> bool {
    crate::updater::entry::valid_id(id)
        && url.as_str() == popup_url(id, cfg!(target_os = "windows"))
}
pub(super) fn main(window: &WebviewWindow) -> Result<(), Error> {
    if window.label() != "main"
        || AsRef::<tauri::Webview>::as_ref(window).window().label() != "main"
    {
        return Err(error("forbidden_window"));
    }
    let url = window.url().map_err(|_| error("forbidden_window"))?;
    let config = window.app_handle().config();
    let original = matches!(config.build.frontend_dist.as_ref(),Some(tauri::utils::config::FrontendDist::Directory(path)) if path==std::path::Path::new("../packages/ztools-renderer/dist"));
    if !original || !runtime::local_main(&url) {
        return Err(error("forbidden_window"));
    }
    Ok(())
}
pub(super) fn popup(
    window: &WebviewWindow,
    id: &str,
    allow_closing: bool,
) -> Result<runtime::Session, Error> {
    let label = format!("renderer-updater-{id}");
    if window.label() != label
        || AsRef::<tauri::Webview>::as_ref(window).window().label() != label
        || !trusted(&window.url().map_err(|_| error("forbidden_window"))?, id)
    {
        return Err(error("forbidden_window"));
    }
    let runtime = runtime(window.app_handle())?;
    let session = runtime
        .session
        .lock()
        .clone()
        .filter(|s| {
            s.id == id
                && s.label == label
                && ((s.alive.load(Ordering::Acquire) && !s.closing.load(Ordering::Acquire))
                    || (allow_closing
                        && s.closing.load(Ordering::Acquire)
                        && !s.destroyed.load(Ordering::Acquire)))
        })
        .ok_or_else(|| error("forbidden_window"))?;
    Ok(session)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_localhost_document_is_exact_on_each_platform() {
        let id = "a".repeat(32);
        for windows in [false, true] {
            let raw = popup_url(&id, windows);
            let url: tauri::Url = raw.parse().unwrap();
            assert_eq!(url.as_str(), raw);
            for suffix in ["?x=1", "#x", "/other"] {
                assert_ne!(format!("{raw}{suffix}"), popup_url(&id, windows));
            }
        }
        assert_ne!(
            popup_url(&id, false),
            format!("atools-updater://{id}/updater.html")
        );
        assert!(!trusted(
            &format!("atools-updater://localhost/{}/updater.html", "b".repeat(32))
                .parse()
                .unwrap(),
            &id
        ));
    }
}
