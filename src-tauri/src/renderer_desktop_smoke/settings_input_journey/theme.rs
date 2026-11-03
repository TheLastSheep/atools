use super::{material, material_report as report, probe, state::Harness};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fmt::Write as _, time::Duration};
use tauri::{AppHandle, Webview, Wry};
use tokio::time::Instant;

const THEME_CYCLE: [&str; 3] = ["light", "dark", "system"];
const THEME_CONVERGENCE_TIMEOUT: Duration = Duration::from_secs(2);
const SAMPLE_TIMEOUT: Duration = Duration::from_millis(250);

pub(super) async fn verify_general_theme(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    run: &material::MaterialRun,
) {
    let initial_theme = bounded_database_theme(harness).await;
    let child_initial = probe::child_theme_inspect(app, harness, child)
        .await
        .unwrap_or_else(|_| empty_child_theme());
    let main_initial = probe::main_theme_inspect(app, harness)
        .await
        .unwrap_or_else(|_| empty_main_theme());
    let native_initial = bounded_native_observation(app).await;
    let initial_valid = initial_theme.as_deref().is_some_and(valid_theme)
        && child_initial["routeAllCommands"].as_bool() == Some(true)
        && child_initial["routeGeneral"].as_bool() == Some(false)
        && child_initial["sidebarFound"].as_bool() == Some(true)
        && child_initial["committedTheme"].as_str() == initial_theme.as_deref()
        && hidden_document(&child_initial)
        && hidden_document(&main_initial)
        && native_initial
            .as_ref()
            .is_some_and(|value| report::active_observation_valid(value, true))
        && media_matches(
            &child_initial,
            &main_initial,
            native_initial.as_ref(),
            initial_theme.as_deref(),
        );
    let navigation = if initial_valid {
        probe::child_theme_navigate(app, harness, child)
            .await
            .unwrap_or_else(|_| empty_navigation())
    } else {
        empty_navigation()
    };
    let general_entry_valid = navigation["routeAllCommands"].as_bool() == Some(false)
        && navigation["routeGeneral"].as_bool() == Some(true)
        && navigation["sidebarFound"].as_bool() == Some(true)
        && navigation["navigationDispatched"].as_bool() == Some(true)
        && navigation["themeControlFound"].as_bool() == Some(true)
        && navigation["selectedTheme"].as_str() == initial_theme.as_deref()
        && navigation["committedTheme"].as_str() == initial_theme.as_deref()
        && hidden_document(&navigation)
        && hidden_document(&main_initial)
        && media_matches(
            &navigation,
            &main_initial,
            native_initial.as_ref(),
            initial_theme.as_deref(),
        );
    let entry_valid = initial_valid && general_entry_valid;
    report::set_initial_theme(
        &mut run.report.lock(),
        json!({
            "databaseTheme": initial_theme.clone(),
            "routeAllCommands": child_initial["routeAllCommands"],
            "childCommittedTheme": child_initial["committedTheme"],
            "childMediaDark": child_initial["mediaDark"],
            "mainMediaDark": main_initial["mediaDark"],
            "effectiveAppearance": native_initial.as_ref().map_or(Value::Null, |value| value["effectiveAppearance"].clone()),
            "passed": initial_valid,
            "generalEntry": {
                "routeGeneral": navigation["routeGeneral"],
                "sidebarFound": navigation["sidebarFound"],
                "navigationDispatched": navigation["navigationDispatched"],
                "themeControlFound": navigation["themeControlFound"],
                "selectedTheme": navigation["selectedTheme"],
                "childCommittedTheme": navigation["committedTheme"],
                "childMediaDark": navigation["mediaDark"],
                "passed": general_entry_valid,
            },
        }),
    );
    if !entry_valid {
        report::add_error(
            &mut run.report.lock(),
            "settings-input-material-theme-initial-invalid",
        );
        return;
    }

    let mut all_steps_valid = true;
    for theme in THEME_CYCLE {
        let selection = probe::child_theme_select(app, harness, child, theme)
            .await
            .unwrap_or_else(|_| empty_theme_selection());
        let sample = if selection["selectionDispatched"].as_bool() == Some(true) {
            wait_for_theme_state(app, harness, child, theme).await
        } else {
            ThemeSample::empty()
        };
        let pass = selection_valid(&selection, theme) && sample.valid(theme);
        all_steps_valid &= pass;
        let step = json!({
            "theme": theme,
            "routeGeneral": sample.child["routeGeneral"],
            "themeControlFound": selection["themeControlFound"],
            "themeMenuOpened": selection["themeMenuOpened"],
            "optionSetValid": selection["optionSetValid"],
            "selectionDispatched": selection["selectionDispatched"],
            "selected": selection["selected"],
            "selectedTheme": sample.child["selectedTheme"],
            "childCommittedTheme": sample.child["committedTheme"],
            "databaseTheme": sample.database,
            "childMediaDark": sample.child["mediaDark"],
            "mainMediaDark": sample.main["mediaDark"],
            "effectiveAppearance": sample.native.as_ref().map_or(Value::Null, |value| value["effectiveAppearance"].clone()),
            "passed": pass,
        });
        report::push_theme_step(&mut run.report.lock(), step);
        if !pass {
            report::add_error(
                &mut run.report.lock(),
                "settings-input-material-theme-step-invalid",
            );
        }
        if matches!(theme, "light" | "dark") {
            capture_theme_snapshot(app, harness, child, theme, run).await;
        }
    }

    let restore_theme = initial_theme.as_deref().unwrap_or("");
    let restoration_selection = if valid_theme(restore_theme) {
        probe::child_theme_select(app, harness, child, restore_theme)
            .await
            .unwrap_or_else(|_| empty_theme_selection())
    } else {
        empty_theme_selection()
    };
    let restored = if restoration_selection["selectionDispatched"].as_bool() == Some(true) {
        wait_for_theme_state(app, harness, child, restore_theme).await
    } else {
        ThemeSample::empty()
    };
    let restored_appearance = restored
        .native
        .as_ref()
        .and_then(|value| value["effectiveAppearance"].as_str());
    let initial_appearance = native_initial
        .as_ref()
        .and_then(|value| value["effectiveAppearance"].as_str());
    let restoration_valid = valid_theme(restore_theme)
        && selection_valid(&restoration_selection, restore_theme)
        && restored.valid(restore_theme)
        && restored_appearance == initial_appearance;
    report::set_theme_restoration(
        &mut run.report.lock(),
        json!({
            "theme": restore_theme,
            "routeGeneral": restored.child["routeGeneral"],
            "selectedTheme": restored.child["selectedTheme"],
            "childCommittedTheme": restored.child["committedTheme"],
            "databaseTheme": restored.database,
            "childMediaDark": restored.child["mediaDark"],
            "mainMediaDark": restored.main["mediaDark"],
            "effectiveAppearance": restored_appearance,
            "matchesInitialAppearance": restored_appearance == initial_appearance,
            "passed": restoration_valid,
        }),
    );
    let theme_passed = entry_valid && all_steps_valid && restoration_valid;
    report::set_theme_passed(&mut run.report.lock(), theme_passed);
    if !theme_passed {
        report::add_error(
            &mut run.report.lock(),
            "settings-input-material-theme-restore-invalid",
        );
    }
}

struct ThemeSample {
    database: Option<String>,
    child: Value,
    main: Value,
    native: Option<Value>,
}

impl ThemeSample {
    fn empty() -> Self {
        Self {
            database: None,
            child: empty_child_theme(),
            main: empty_main_theme(),
            native: None,
        }
    }

    fn valid(&self, expected: &str) -> bool {
        valid_theme(expected)
            && self.database.as_deref() == Some(expected)
            && self.child["committedTheme"].as_str() == Some(expected)
            && self.child["selectedTheme"].as_str() == Some(expected)
            && self.child["routeGeneral"].as_bool() == Some(true)
            && self.child["routeAllCommands"].as_bool() == Some(false)
            && self.child["themeControlFound"].as_bool() == Some(true)
            && hidden_document(&self.child)
            && hidden_document(&self.main)
            && self.native.as_ref().is_some_and(|native| {
                report::active_observation_valid(native, true)
                    && media_matches(&self.child, &self.main, Some(native), Some(expected))
            })
    }
}

async fn wait_for_theme_state(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    expected: &str,
) -> ThemeSample {
    let deadline = Instant::now() + THEME_CONVERGENCE_TIMEOUT;
    let mut last = ThemeSample::empty();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return last;
        }
        let sample = tokio::time::timeout(remaining, sample_theme_state(app, harness, child)).await;
        let Ok(sample) = sample else {
            return last;
        };
        if sample.valid(expected) {
            return sample;
        }
        last = sample;
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

async fn sample_theme_state(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> ThemeSample {
    let (database, native) = tokio::join!(
        bounded_database_theme(harness),
        bounded_native_observation(app),
    );
    // The frozen probe protocol intentionally permits a single in-flight request.
    let child_value = probe::child_theme_inspect(app, harness, child).await;
    let main_value = probe::main_theme_inspect(app, harness).await;
    ThemeSample {
        database,
        child: child_value.unwrap_or_else(|_| empty_child_theme()),
        main: main_value.unwrap_or_else(|_| empty_main_theme()),
        native,
    }
}

async fn bounded_database_theme(harness: &Harness) -> Option<String> {
    tokio::time::timeout(SAMPLE_TIMEOUT, material::database_theme(harness))
        .await
        .ok()
        .flatten()
}

async fn bounded_native_observation(app: &AppHandle<Wry>) -> Option<Value> {
    tokio::time::timeout(SAMPLE_TIMEOUT, material::native_observation(app))
        .await
        .ok()
        .flatten()
}

async fn capture_theme_snapshot(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    theme: &str,
    run: &material::MaterialRun,
) {
    let filename = match theme {
        "light" => "native-general-light.png",
        "dark" => "native-general-dark.png",
        _ => return,
    };
    super::paint_diagnostics::collect(app, harness, child, theme, run).await;
    let readiness = match probe::child_snapshot_ready(app, harness, child, theme).await {
        Ok(value) if report::valid_snapshot_readiness(&value) => value,
        _ => {
            report::set_snapshot(
                &mut run.report.lock(),
                theme,
                report::unverified_snapshot("settings-input-material-snapshot-not-attempted"),
            );
            return;
        }
    };
    if !report::snapshot_readiness_settled(&readiness) {
        report::set_snapshot(
            &mut run.report.lock(),
            theme,
            report::unverified_snapshot_with_readiness(
                "settings-input-material-snapshot-unsettled",
                Some(readiness),
            ),
        );
        return;
    }
    let snapshot = match super::snapshot::capture(child).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            report::set_snapshot(
                &mut run.report.lock(),
                theme,
                report::unverified_snapshot_with_readiness(error, Some(readiness)),
            );
            return;
        }
    };
    let digest = hex_sha256(&snapshot.png);
    if !report::valid_snapshot_evidence(&snapshot.evidence, snapshot.png.len(), &digest)
        || !snapshot.png.starts_with(b"\x89PNG\r\n\x1a\n")
    {
        report::set_snapshot(
            &mut run.report.lock(),
            theme,
            report::unverified_snapshot_with_readiness(
                "settings-input-snapshot-png-invalid",
                Some(readiness),
            ),
        );
        return;
    }
    let value = match report::write_snapshot(harness.profile(), filename, &snapshot.png) {
        Ok(()) => report::captured_snapshot(filename, snapshot.evidence, readiness.clone()),
        Err(_) => report::unverified_snapshot_with_readiness(
            "settings-input-material-snapshot-write-failed",
            Some(readiness),
        ),
    };
    report::set_snapshot(&mut run.report.lock(), theme, value);
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut result = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        let _ = write!(result, "{byte:02x}");
    }
    result
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
        && hidden_document(selection)
}

fn hidden_document(value: &Value) -> bool {
    value["documentHidden"].as_bool() == Some(true)
        && value["documentHasFocus"].as_bool() == Some(false)
        && value["mediaDark"].as_bool().is_some()
}

fn media_matches(child: &Value, main: &Value, native: Option<&Value>, theme: Option<&str>) -> bool {
    let Some(appearance) = native.and_then(|value| value["effectiveAppearance"].as_str()) else {
        return false;
    };
    expected_appearance(theme.unwrap_or(""), Some(appearance))
        && child["mediaDark"].as_bool() == Some(appearance == "dark")
        && main["mediaDark"].as_bool() == Some(appearance == "dark")
}

fn expected_appearance(theme: &str, appearance: Option<&str>) -> bool {
    match theme {
        "light" => appearance == Some("light"),
        "dark" => appearance == Some("dark"),
        "system" => matches!(appearance, Some("light" | "dark")),
        _ => false,
    }
}

fn valid_theme(theme: &str) -> bool {
    matches!(theme, "system" | "light" | "dark")
}

fn empty_child_theme() -> Value {
    json!({
        "routeAllCommands": false, "routeGeneral": false, "sidebarFound": false,
        "navigationDispatched": false, "themeControlFound": false,
        "selectedTheme": null, "committedTheme": null, "mediaDark": null,
        "documentHidden": false, "documentHasFocus": true,
    })
}

fn empty_main_theme() -> Value {
    json!({"mediaDark": null, "documentHidden": false, "documentHasFocus": true})
}

fn empty_navigation() -> Value {
    json!({
        "routeAllCommands": false, "routeGeneral": false, "sidebarFound": false,
        "navigationDispatched": false, "themeControlFound": false,
        "selectedTheme": null, "committedTheme": null, "mediaDark": null,
        "documentHidden": false, "documentHasFocus": true,
    })
}

fn empty_theme_selection() -> Value {
    json!({
        "routeAllCommands": false, "routeGeneral": false,
        "themeControlFound": false, "themeMenuOpened": false,
        "optionSetValid": false, "selectionDispatched": false, "selected": false,
        "selectedTheme": null, "committedTheme": null, "mediaDark": null,
        "documentHidden": false, "documentHasFocus": true,
    })
}
