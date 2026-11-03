//! Isolated end-to-end read of the current clipboard through the unchanged Main UI.
mod journey;
mod privacy;
mod probe;
mod report;
mod state;

use std::sync::Arc;
use tauri::{ipc::Invoke, webview::PageLoadPayload, AppHandle, Manager, Webview, Wry};

pub(super) use state::Harness;

pub(super) fn prepare(
    profile: Arc<super::profile::Profile>,
    db: Arc<atools_core::Database>,
    board: Arc<crate::pasteboard_native::clipboard_fixture::NamedClipboardFixture>,
) -> Result<Harness, String> {
    Harness::new(profile, db, board)
}

pub(super) fn handles(command: &str) -> bool {
    command == probe::COMMAND
}

pub(super) fn handler() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![probe::renderer_clipboard_context_probe]
}

pub(super) fn observe_command(invoke: &Invoke<Wry>) {
    if invoke.message.command() != "get_renderer_last_copied_content" {
        return;
    }
    let webview = invoke.message.webview_ref();
    if webview.label() != "main" || webview.window().label() != "main" {
        return;
    }
    let app = webview.app_handle();
    let Some(harness) = app.try_state::<Harness>() else {
        return;
    };
    if !harness.profile().clipboard_context_journey
        || probe::validate_main_source(&app, webview).is_err()
    {
        return;
    }
    harness.add_reader_command();
}

pub(super) fn on_page_load(webview: &Webview<Wry>, payload: &PageLoadPayload<'_>) {
    probe::on_page_load(webview, payload);
}

pub(super) fn start(app: AppHandle<Wry>) {
    let Some(state) = app.try_state::<Harness>() else {
        return;
    };
    let harness = (*state).clone();
    if !harness.claim_start() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let run = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            journey::run(&app, &harness),
        )
        .await;
        match run {
            Ok(Ok(())) => {}
            Ok(Err(code)) => harness.note_error(code),
            Err(_) => harness.note_error(report::WATCHDOG_TIMEOUT),
        }
        journey::finish(&app, &harness).await;
    });
}
