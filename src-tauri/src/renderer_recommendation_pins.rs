//! Main-renderer command for the original recommendation-pins setting.

#[cfg(test)]
#[path = "renderer_recommendation_pins_tests.rs"]
mod tests;

use std::sync::Arc;

use atools_core::{
    db::{
        Database, RendererRecommendationPinsMutation, RendererRecommendationPinsWrite,
        RENDERER_RECOMMENDATION_PINS_CONFLICT,
    },
    AToolsError,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{State, Webview, Window};

const MAIN_LABEL: &str = "main";
const MAIN_WINDOW_ONLY: &str = "RECOMMENDATION_PINS_MAIN_WINDOW_ONLY";
const SAVE_FAILED: &str = "RECOMMENDATION_PINS_SAVE_FAILED";
const SAVE_WORKER_FAILED: &str = "RECOMMENDATION_PINS_SAVE_WORKER_FAILED";
const SAVE_CONFLICT: &str = "RECOMMENDATION_PINS_CONFLICT";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct RendererRecommendationPinsSaveReceipt {
    version: u8,
    changed: bool,
    raw: Option<String>,
}

#[tauri::command]
pub(crate) async fn save_renderer_recommendation_pins(
    webview: Webview,
    window: Window,
    state: State<'_, crate::state::AppState>,
    expected: Value,
    value: Value,
) -> Result<RendererRecommendationPinsSaveReceipt, String> {
    ensure_main_context(webview.label(), webview.window().label(), window.label())
        .map_err(str::to_owned)?;

    save_pins_on_worker(Arc::clone(&state.db), expected, value)
        .await
        .map_err(str::to_owned)
}

async fn save_pins_on_worker(
    database: Arc<Database>,
    expected: Value,
    mutation: Value,
) -> Result<RendererRecommendationPinsSaveReceipt, &'static str> {
    let expected_raw = parse_expected_raw(expected)?;
    // Once admitted, the atomic SQLite transaction may finish even if the WebView closes.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mutation = parse_mutation(mutation)?;
        database
            .mutate_renderer_recommendation_pins_guarded(expected_raw.as_deref(), mutation, || true)
            .map_err(map_save_error)
    })
    .await
    .map_err(|_| SAVE_WORKER_FAILED)?;
    let write = result?;
    Ok(save_receipt(write))
}

fn parse_expected_raw(expected: Value) -> Result<Option<String>, &'static str> {
    match expected {
        Value::Null => Ok(None),
        Value::String(raw) => Ok(Some(raw)),
        _ => Err(SAVE_FAILED),
    }
}

fn parse_mutation(value: Value) -> Result<RendererRecommendationPinsMutation, &'static str> {
    serde_json::from_value(value).map_err(|_| SAVE_FAILED)
}

fn ensure_main_context(
    webview_label: &str,
    parent_label: &str,
    window_label: &str,
) -> Result<(), &'static str> {
    if webview_label == MAIN_LABEL && parent_label == MAIN_LABEL && window_label == MAIN_LABEL {
        Ok(())
    } else {
        Err(MAIN_WINDOW_ONLY)
    }
}

fn map_save_error(error: AToolsError) -> &'static str {
    match error {
        AToolsError::Config(message) if message == RENDERER_RECOMMENDATION_PINS_CONFLICT => {
            SAVE_CONFLICT
        }
        _ => SAVE_FAILED,
    }
}

fn save_receipt(write: RendererRecommendationPinsWrite) -> RendererRecommendationPinsSaveReceipt {
    RendererRecommendationPinsSaveReceipt {
        version: 1,
        changed: write.changed,
        raw: write.raw,
    }
}
