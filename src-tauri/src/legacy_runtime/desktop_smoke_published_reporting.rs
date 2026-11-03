//! One-shot frontend report receiver for the published-plugin fixture.

use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;
use tauri::Manager;

pub(super) struct PublishedReport(
    pub(super) Arc<Mutex<Option<tokio::sync::oneshot::Sender<Value>>>>,
);

#[tauri::command]
pub(super) fn native_published_report(app: tauri::AppHandle, report: Value) {
    if let Some(sender) = app.state::<PublishedReport>().0.lock().take() {
        app.state::<Arc<super::lifecycle::Lifecycle>>()
            .received("frontend-report-received", &report);
        if sender.send(report).is_err() {
            eprintln!("[published-smoke] report-channel-closed-before-send");
        }
    }
}
