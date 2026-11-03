//! Desktop application bootstrap and builder lifecycle.

use std::sync::Arc;

use atools_core::{config::AppConfig, db::Database};

use crate::{
    app_builder, app_lifecycle, app_setup, crash, pasteboard_native, pasteboard_runtime,
    state::{AppState, ReleaseSmokeConfig},
};

const RELEASE_SMOKE_TOKEN_ARG: &str = "--atools-release-smoke-token=";
const RELEASE_SMOKE_REPORT_PATH_ARG: &str = "--atools-release-smoke-report=";
const RELEASE_SMOKE_TOKEN_ENV: &str = "ATOOLS_RELEASE_SMOKE_TOKEN";
const RELEASE_SMOKE_REPORT_PATH_ENV: &str = "ATOOLS_RELEASE_SMOKE_REPORT_PATH";

pub(super) fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "atools=debug,atools_core=debug".into()),
        )
        .init();

    let config = AppConfig::new().expect("Failed to create AppConfig");
    config
        .ensure_dirs()
        .expect("Failed to create app directories");
    crash::install_panic_hook(crash::crash_log_path(&config));

    let db = Arc::new(Database::new().expect("Failed to open database"));
    let release_smoke = parse_release_smoke_config();
    let pasteboard_runtime = Arc::new(
        pasteboard_runtime::PasteboardRuntime::new(
            pasteboard_native::system_pasteboard_backend(),
            db.clone(),
            &config,
        )
        .expect("Failed to initialize native Paste clipboard runtime"),
    );
    let app_state =
        AppState::new_pending_builtin_inventory(config, db, release_smoke, pasteboard_runtime);
    app_state.record_runtime_event("info", "ATools state initialized");

    app_builder::with_desktop_plugins(app_builder::host_builder(app_state))
        .setup(app_setup::setup)
        .build(tauri::generate_context!())
        .expect("error building ATools 3.0")
        .run(app_lifecycle::on_run_event);
}

fn parse_release_smoke_config() -> Option<ReleaseSmokeConfig> {
    let token = parse_from_args_or_env(RELEASE_SMOKE_TOKEN_ARG, RELEASE_SMOKE_TOKEN_ENV)?;
    let report_path =
        parse_from_args_or_env(RELEASE_SMOKE_REPORT_PATH_ARG, RELEASE_SMOKE_REPORT_PATH_ENV);
    tracing::info!(
        "Release smoke mode enabled: token={} report_path={}",
        token,
        report_path
            .clone()
            .unwrap_or_else(|| "<not-provided>".to_string())
    );
    Some(ReleaseSmokeConfig { token, report_path })
}

fn parse_from_args_or_env(arg_prefix: &str, env_key: &str) -> Option<String> {
    if let Some(value) = std::env::args().find_map(|arg| {
        parse_prefixed_arg(&arg, arg_prefix)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }) {
        return Some(value);
    }

    let env_arg_prefix = format!("--{env_key}=");
    if let Some(value) = std::env::args().find_map(|arg| {
        parse_prefixed_arg(&arg, &env_arg_prefix)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }) {
        return Some(value);
    }

    std::env::var(env_key).ok().and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn parse_prefixed_arg<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value.strip_prefix(prefix)
}
