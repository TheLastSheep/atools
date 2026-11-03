use super::backend::{updater_smoke_endpoint_override, TauriUpdateBackend};
use super::model::{UpdateBackend, UpdateCommandError, UpdateMetadata, UpdateProgress};
use std::sync::Arc;
use tauri::Manager;

#[derive(Debug, Clone)]
struct PackageSmokeConfig {
    scenario: String,
    report_path: std::path::PathBuf,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageSmokeReport<'a> {
    status: &'a str,
    outcome: &'a str,
    current_version: String,
    message: Option<String>,
}

pub fn start_package_smoke_if_requested(app: &tauri::AppHandle) {
    let Some(config) = package_smoke_config() else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_package_smoke(app, config).await;
    });
}

fn package_smoke_config() -> Option<PackageSmokeConfig> {
    updater_smoke_endpoint_override()?;
    let scenario = std::env::var("ATOOLS_UPDATER_SMOKE_SCENARIO").ok()?;
    if !matches!(
        scenario.as_str(),
        "no-update" | "missing-architecture" | "invalid-signature" | "valid-update-relaunch"
    ) {
        return None;
    }
    let report_path = std::env::var_os("ATOOLS_UPDATER_SMOKE_REPORT")?;
    Some(PackageSmokeConfig {
        scenario,
        report_path: report_path.into(),
    })
}

async fn run_package_smoke(app: tauri::AppHandle, config: PackageSmokeConfig) {
    let current_version = app.package_info().version.to_string();
    if config.scenario == "valid-update-relaunch" && current_version == "3.0.0" {
        finish_package_smoke(
            &app,
            &config,
            PackageSmokeReport {
                status: "ok",
                outcome: "valid-update-relaunch",
                current_version,
                message: None,
            },
        );
        return;
    }

    let backend = SmokeBackend {
        inner: TauriUpdateBackend { app: app.clone() },
        config: config.clone(),
    };
    let Some(coordinator) = app
        .try_state::<super::UpdateCoordinator>()
        .map(|s| s.inner().clone())
    else {
        app.exit(1);
        return;
    };
    let result = match config.scenario.as_str() {
        "no-update" => match coordinator.check(&backend).await {
            Ok(None) => Ok("no-update"),
            Ok(Some(_)) => Err("no-update scenario unexpectedly returned an update".to_string()),
            Err(error) => Err(format!(
                "no-update check failed with {}: {}",
                error.code, error.message
            )),
        },
        "missing-architecture" => match coordinator.check(&backend).await {
            Err(error) if error.code == "missing_architecture" => Ok("missing-architecture"),
            Err(error) => Err(format!(
                "missing-architecture returned unexpected error {}",
                error.code
            )),
            Ok(_) => Err("missing-architecture scenario unexpectedly passed".to_string()),
        },
        "invalid-signature" => match coordinator.check(&backend).await {
            Ok(Some(update)) => match coordinator
                .install(&backend, &update.version, &update.candidate_id, |_| {})
                .await
            {
                Err(error) if error.code == "invalid_signature" => Ok("invalid-signature"),
                Err(error) => Err(format!(
                    "invalid-signature returned unexpected error {}",
                    error.code
                )),
                Ok(()) => Err("invalid-signature scenario unexpectedly installed".to_string()),
            },
            Ok(None) => Err("invalid-signature scenario returned no update".to_string()),
            Err(error) => Err(format!(
                "invalid-signature check failed with {}: {}",
                error.code, error.message
            )),
        },
        "valid-update-relaunch" => match coordinator.check(&backend).await {
            Ok(Some(update)) => match coordinator
                .install(&backend, &update.version, &update.candidate_id, |_| {})
                .await
            {
                Ok(()) => Ok("install-complete"),
                Err(error) => Err(format!("valid update install failed with {}", error.code)),
            },
            Ok(None) => Err("valid update scenario returned no update".to_string()),
            Err(error) => Err(format!(
                "valid update check failed with {}: {}",
                error.code, error.message
            )),
        },
        _ => Err("unsupported updater smoke scenario".to_string()),
    };

    match result {
        Ok(outcome) => finish_package_smoke(
            &app,
            &config,
            PackageSmokeReport {
                status: "ok",
                outcome,
                current_version,
                message: None,
            },
        ),
        Err(message) => finish_package_smoke(
            &app,
            &config,
            PackageSmokeReport {
                status: "error",
                outcome: &config.scenario,
                current_version,
                message: Some(message),
            },
        ),
    }
}

fn finish_package_smoke(
    app: &tauri::AppHandle,
    config: &PackageSmokeConfig,
    report: PackageSmokeReport<'_>,
) {
    let exit_code = if report.status == "ok" { 0 } else { 1 };
    if let Err(error) = write_package_smoke_report(&config.report_path, &report) {
        tracing::error!("Failed to write updater smoke report: {error}");
        app.exit(1);
    } else {
        app.exit(exit_code);
    }
}

fn write_package_smoke_report(
    path: &std::path::Path,
    report: &PackageSmokeReport<'_>,
) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp_path = path.with_extension("tmp");
    let bytes = serde_json::to_vec(report).map_err(std::io::Error::other)?;
    std::fs::write(&temp_path, bytes)?;
    std::fs::rename(temp_path, path)
}

// Shares candidate, verified archive and actual operation permit with every user entry.
// The existing smoke receipt must be durable before the successful restart terminates us.
#[derive(Clone)]
struct SmokeBackend {
    inner: TauriUpdateBackend,
    config: PackageSmokeConfig,
}
#[async_trait::async_trait]
impl UpdateBackend for SmokeBackend {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        self.inner.check().await
    }
    async fn install(
        &self,
        metadata: &UpdateMetadata,
        progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError> {
        self.inner.install(metadata, progress).await
    }
    async fn download_archive(
        &self,
        metadata: &UpdateMetadata,
        progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<super::archive::VerifiedArchive, UpdateCommandError> {
        self.inner.download_archive(metadata, progress).await
    }
    async fn apply_archive(
        &self,
        archive: Arc<super::archive::VerifiedArchive>,
    ) -> Result<(), UpdateCommandError> {
        self.inner.apply_archive(archive).await
    }
    async fn before_restart(&self) -> Result<(), UpdateCommandError> {
        self.inner.before_restart().await
    }
    fn restart(&self) -> Result<(), UpdateCommandError> {
        write_package_smoke_report(
            &self.config.report_path,
            &PackageSmokeReport {
                status: "ok",
                outcome: "install-complete",
                current_version: self.inner.app.package_info().version.to_string(),
                message: None,
            },
        )
        .map_err(|_| super::coordinator::failure("internal"))?;
        self.inner.restart()
    }
}
