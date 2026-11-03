//! Main-only trusted navigation epochs; no controller actions in page callbacks.
use std::sync::Mutex;
use tauri::{
    webview::{PageLoadEvent, PageLoadPayload},
    Manager, Webview, Wry,
};
#[derive(Default)]
pub(in crate::renderer_desktop_smoke::settings_height) struct Runtime {
    state: Mutex<State>,
    pub(super) changed: tokio::sync::Notify,
}
#[derive(Clone, Copy, Default, Debug)]
pub(super) struct State {
    pub epoch: u64,
    pub finished: bool,
}
impl Runtime {
    pub(super) fn snapshot(&self) -> State {
        *self.state.lock().unwrap()
    }
    fn update(&self, finished: bool) {
        let mut state = self.state.lock().unwrap();
        if !finished {
            state.epoch += 1;
        }
        state.finished = finished;
        drop(state);
        self.changed.notify_waiters();
    }
}
pub(super) fn trusted(url: &tauri::Url) -> bool {
    url.scheme() == "tauri"
        && url.host_str() == Some("localhost")
        && matches!(url.path(), "/" | "/index.html")
        && url.query().is_none()
        && url.fragment().is_none()
}
pub(in crate::renderer_desktop_smoke::settings_height) fn on_page_load(
    webview: &Webview<Wry>,
    payload: &PageLoadPayload<'_>,
) {
    if webview.label() != "main" || webview.window().label() != "main" {
        return;
    }
    let Some(runtime) = webview.app_handle().try_state::<Runtime>() else {
        return;
    };
    // An untrusted navigation invalidates readiness even if it subsequently finishes.
    runtime.update(trusted(payload.url()) && payload.event() == PageLoadEvent::Finished);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finished_belongs_to_current_trusted_main_epoch() {
        let runtime = Runtime::default();
        assert!(!runtime.snapshot().finished);
        runtime.update(false);
        let first = runtime.snapshot().epoch;
        runtime.update(true);
        assert!(runtime.snapshot().finished);
        runtime.update(false);
        assert!(!runtime.snapshot().finished);
        assert!(runtime.snapshot().epoch > first);
        for url in [
            "https://localhost/",
            "tauri://localhost/foreign",
            "tauri://localhost/?arbitrary=1",
        ] {
            assert!(!trusted(&url.parse().unwrap()));
        }
    }
}
