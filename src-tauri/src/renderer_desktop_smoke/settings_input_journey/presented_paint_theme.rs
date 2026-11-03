use super::{material, material_report, probe, state::Harness};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Webview, Wry};
use tokio::time::Instant;

const THEMES: [&str; 3] = ["light", "dark", "system"];
const CONVERGENCE_LIMIT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(40);
const WATCHDOG_EXPIRED: &str = "settings-input-presented-paint-watchdog-expired";
const VISIBLE_INVALID: &str = "settings-input-presented-paint-visible-state-invalid";

const THEME_SELECTION_INVALID: &str = "settings-input-presented-paint-theme-selection-invalid";
const THEME_CONVERGENCE_TIMEOUT: &str = "settings-input-presented-paint-theme-convergence-timeout";
pub(super) async fn run(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    lease: &super::presented_paint_window::PresentedWindowLease,
    cycle_deadline: Instant,
    restore_deadline: Instant,
    report: &mut Value,
) {
    for theme in THEMES {
        let step = run_theme(app, harness, child, lease, cycle_deadline, report, theme).await;
        super::presented_paint_report::push_step(report, step);
    }
    let restoration = restore_dark(app, harness, child, lease, restore_deadline, report).await;
    super::presented_paint_report::set_restoration(report, restoration);
}

async fn run_theme(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    lease: &super::presented_paint_window::PresentedWindowLease,
    deadline: Instant,
    report: &mut Value,
    theme: &str,
) -> Value {
    let mut step = super::presented_paint_report::empty_step(theme);
    let selection = bounded_selection(app, harness, child, theme, remaining(deadline)).await;
    set_selection_fields(&mut step, &selection);
    if !selection_valid(&selection, theme) {
        super::presented_paint_report::add_error(report, THEME_SELECTION_INVALID);
    }

    let state = if selection["selectionDispatched"].as_bool() == Some(true) {
        wait_for_theme_state(app, harness, child, lease, deadline, theme).await
    } else {
        ThemeState::empty()
    };
    set_theme_facts(&mut step, &state);
    if let Some(error) = state.presentation_error {
        super::presented_paint_report::add_error(report, map_window_error(error));
    }
    if !state.valid(theme) {
        if selection["selectionDispatched"].as_bool() == Some(true) {
            super::presented_paint_report::add_error(report, THEME_CONVERGENCE_TIMEOUT);
        }
    }

    let presentation = observe_presentation(lease, report).await;
    step["presentation"] = presentation.clone();
    if theme != "system" {
        if state.valid(theme) && visible(&presentation) {
            super::presented_paint_capture::capture(
                app, harness, child, lease, deadline, theme, &mut step, report,
            )
            .await;
        }
    }
    step
}

async fn restore_dark(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    lease: &super::presented_paint_window::PresentedWindowLease,
    deadline: Instant,
    report: &mut Value,
) -> Value {
    let selection = bounded_selection(app, harness, child, "dark", remaining(deadline)).await;
    let state = if selection["selectionDispatched"].as_bool() == Some(true) {
        wait_for_theme_state(app, harness, child, lease, deadline, "dark").await
    } else {
        ThemeState::empty()
    };
    if let Some(error) = state.presentation_error {
        super::presented_paint_report::add_error(report, map_window_error(error));
    }
    let presentation = observe_presentation(lease, report).await;
    let valid =
        selection_valid(&selection, "dark") && state.valid("dark") && visible(&presentation);
    if !valid {
        super::presented_paint_report::add_error(
            report,
            "settings-input-presented-paint-restore-failed",
        );
    }
    json!({
        "selectedTheme": state.child["selectedTheme"],
        "databaseTheme": state.database,
        "childMediaDark": bool_or_null(&state.child["mediaDark"]),
        "mainMediaDark": bool_or_null(&state.main["mediaDark"]),
        "nativeAppearance": state.native.as_ref().and_then(|value| value["effectiveAppearance"].as_str()),
        "presentation": presentation,
    })
}

async fn bounded_selection(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    theme: &str,
    remaining: Duration,
) -> Value {
    if remaining.is_zero() {
        return empty_selection();
    }
    tokio::time::timeout(
        remaining.min(Duration::from_millis(1700)),
        probe::child_theme_select(app, harness, child, theme),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .unwrap_or_else(empty_selection)
}

async fn wait_for_theme_state(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    lease: &super::presented_paint_window::PresentedWindowLease,
    deadline: Instant,
    expected: &str,
) -> ThemeState {
    let deadline = (Instant::now() + CONVERGENCE_LIMIT).min(deadline);
    let mut last = ThemeState::empty();
    loop {
        if lease.watchdog_expired() {
            return last;
        }
        if remaining(deadline).is_zero() {
            return last;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return last;
        }
        let sample =
            tokio::time::timeout(remaining, sample_theme_state(app, harness, child, lease)).await;
        let Ok(sample) = sample else {
            return last;
        };
        if sample.valid(expected) {
            return sample;
        }
        last = sample;
        tokio::time::sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())))
            .await;
    }
}

async fn sample_theme_state(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    lease: &super::presented_paint_window::PresentedWindowLease,
) -> ThemeState {
    let (database, native) = tokio::join!(
        material::database_theme(harness),
        material::native_observation(app),
    );
    let child_value = probe::child_theme_inspect(app, harness, child)
        .await
        .unwrap_or_else(|_| empty_child_theme());
    let main_value = probe::main_theme_inspect(app, harness)
        .await
        .unwrap_or_else(|_| empty_main_theme());
    let (presentation, presentation_error) = match lease.snapshot().await {
        Ok(value) => (value, None),
        Err(error) => (
            super::presented_paint_report::empty_presentation(),
            Some(error),
        ),
    };
    ThemeState {
        database,
        child: child_value,
        main: main_value,
        native,
        presentation,
        presentation_error,
    }
}

async fn observe_presentation(
    lease: &super::presented_paint_window::PresentedWindowLease,
    report: &mut Value,
) -> Value {
    if lease.watchdog_expired() {
        super::presented_paint_report::add_error(report, WATCHDOG_EXPIRED);
        return super::presented_paint_report::empty_presentation();
    }
    match lease.snapshot().await {
        Ok(facts) => facts,
        Err(error) => {
            super::presented_paint_report::add_error(report, map_window_error(error));
            super::presented_paint_report::empty_presentation()
        }
    }
}

fn map_window_error(error: &'static str) -> &'static str {
    match error {
        "settings-input-presented-paint-watchdog-expired" => WATCHDOG_EXPIRED,
        "settings-input-presented-paint-focus-changed" => {
            "settings-input-presented-paint-focus-changed"
        }
        "settings-input-presented-paint-identity-invalid" => {
            "settings-input-presented-paint-identity-invalid"
        }
        "settings-input-presented-paint-hide-failed" => {
            "settings-input-presented-paint-hide-failed"
        }
        _ => VISIBLE_INVALID,
    }
}

fn set_selection_fields(step: &mut Value, selection: &Value) {
    for key in [
        "themeControlFound",
        "themeMenuOpened",
        "optionSetValid",
        "selectionDispatched",
        "selected",
    ] {
        step[key] = Value::Bool(selection[key].as_bool() == Some(true));
    }
    step["selectedTheme"] = selection["selectedTheme"].clone();
}

fn set_theme_facts(step: &mut Value, state: &ThemeState) {
    step["selectedTheme"] = state.child["selectedTheme"].clone();
    step["databaseTheme"] = state
        .database
        .as_ref()
        .map_or(Value::Null, |theme| Value::String(theme.clone()));
    step["childMediaDark"] = bool_or_null(&state.child["mediaDark"]);
    step["mainMediaDark"] = bool_or_null(&state.main["mediaDark"]);
    step["nativeAppearance"] = state
        .native
        .as_ref()
        .and_then(|value| value["effectiveAppearance"].as_str())
        .map_or(Value::Null, |value| Value::String(value.to_owned()));
}

fn selection_valid(selection: &Value, theme: &str) -> bool {
    selection["routeAllCommands"].as_bool() == Some(false)
        && selection["routeGeneral"].as_bool() == Some(true)
        && selection["themeControlFound"].as_bool() == Some(true)
        && selection["themeMenuOpened"].as_bool() == Some(true)
        && selection["optionSetValid"].as_bool() == Some(true)
        && selection["selectionDispatched"].as_bool() == Some(true)
        && selection["selected"].as_bool() == Some(true)
        && selection["selectedTheme"].as_str() == Some(theme)
}

fn visible(presentation: &Value) -> bool {
    presentation["visible"].as_bool() == Some(true)
        && presentation["windowFocused"].as_bool() == Some(false)
        && presentation["windowKey"].as_bool() == Some(false)
        && presentation["appActive"].as_bool() == Some(false)
        && presentation["frontmostIsSelf"].as_bool() == Some(false)
}

struct ThemeState {
    database: Option<String>,
    child: Value,
    main: Value,
    native: Option<Value>,
    presentation: Value,
    presentation_error: Option<&'static str>,
}

impl ThemeState {
    fn empty() -> Self {
        Self {
            database: None,
            child: empty_child_theme(),
            main: empty_main_theme(),
            native: None,
            presentation: super::presented_paint_report::empty_presentation(),
            presentation_error: None,
        }
    }

    fn valid(&self, expected: &str) -> bool {
        let Some(appearance) = self
            .native
            .as_ref()
            .and_then(|value| value["effectiveAppearance"].as_str())
        else {
            return false;
        };
        let appearance_matches = match expected {
            "light" => appearance == "light",
            "dark" => appearance == "dark",
            "system" => matches!(appearance, "light" | "dark"),
            _ => false,
        };
        appearance_matches
            && self.database.as_deref() == Some(expected)
            && self.child["selectedTheme"].as_str() == Some(expected)
            && self.child["committedTheme"].as_str() == Some(expected)
            && self.child["routeAllCommands"].as_bool() == Some(false)
            && self.child["routeGeneral"].as_bool() == Some(true)
            && self.child["themeControlFound"].as_bool() == Some(true)
            && self.child["mediaDark"].as_bool() == Some(appearance == "dark")
            && self.main["mediaDark"].as_bool() == Some(appearance == "dark")
            && self
                .native
                .as_ref()
                .is_some_and(|value| material_report::active_observation_valid(value, true))
            && visible(&self.presentation)
    }
}

fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

fn bool_or_null(value: &Value) -> Value {
    value.as_bool().map_or(Value::Null, Value::Bool)
}

fn empty_child_theme() -> Value {
    json!({
        "routeAllCommands": false, "routeGeneral": false, "themeControlFound": false,
        "selectedTheme": null, "committedTheme": null, "mediaDark": null,
    })
}

fn empty_main_theme() -> Value {
    json!({ "mediaDark": null })
}

fn empty_selection() -> Value {
    json!({
        "routeAllCommands": false, "routeGeneral": false,
        "themeControlFound": false, "themeMenuOpened": false, "optionSetValid": false,
        "selectionDispatched": false, "selected": false, "selectedTheme": null,
    })
}
