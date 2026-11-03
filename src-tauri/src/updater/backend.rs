use super::model::{UpdateBackend, UpdateCommandError, UpdateMetadata, UpdateProgress};

#[derive(Clone)]
pub(super) struct TauriUpdateBackend {
    pub(super) app: tauri::AppHandle,
}

fn updater_for_app(
    app: &tauri::AppHandle,
) -> Result<tauri_plugin_updater::Updater, UpdateCommandError> {
    use tauri_plugin_updater::UpdaterExt;
    let endpoint = updater_smoke_endpoint_override();
    super::provider_guard::create_guarded(
        super::provider_guard::facts(app),
        endpoint.is_some(),
        || {
            (|| -> Result<tauri_plugin_updater::Updater, tauri_plugin_updater::Error> {
                let mut builder = app.updater_builder();
                if let Some(endpoint) = endpoint {
                    let endpoint = endpoint
                        .parse::<tauri::Url>()
                        .map_err(tauri_plugin_updater::Error::UrlParse)?;
                    builder = builder.endpoints(vec![endpoint])?;
                }
                builder.build()
            })()
            .map_err(classify_check_error)
        },
    )
}

pub(super) fn updater_smoke_endpoint_override() -> Option<String> {
    let endpoint = std::env::var("ATOOLS_UPDATER_SMOKE_ENDPOINT").ok()?;
    (cfg!(debug_assertions)
        && std::env::var_os("ATOOLS_UPDATER_SMOKE").as_deref() == Some(std::ffi::OsStr::new("1"))
        && endpoint.starts_with("http://127.0.0.1:")
        && updater_smoke_endpoint_allowed(true, true, &endpoint))
    .then_some(endpoint)
}

pub(super) fn updater_smoke_endpoint_allowed(debug: bool, enabled: bool, endpoint: &str) -> bool {
    debug
        && enabled
        && endpoint.starts_with("http://127.0.0.1:")
        && endpoint
            .parse::<tauri::Url>()
            .is_ok_and(|url| url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
}

#[async_trait::async_trait]
impl UpdateBackend for TauriUpdateBackend {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        ensure_network_allowed(&self.app)?;
        let update = updater_for_app(&self.app)?
            .check()
            .await
            .map_err(classify_check_error)?;
        update
            .map(|item| {
                if item.current_version.len() > 128
                    || item.version.len() > 128
                    || item.body.as_ref().is_some_and(|b| b.len() > 48 * 1024)
                {
                    return Err(super::errors::fixed("invalid_manifest"));
                }
                let mut metadata = UpdateMetadata {
                    candidate_id: "0".repeat(32),
                    current_version: item.current_version.clone(),
                    version: item.version.clone(),
                    date: item.date.map(|v| v.to_string()),
                    body: item.body.clone(),
                    prepared: None,
                };
                metadata.validate_status_fields()?;
                super::snapshot::validate_candidate(&metadata)?;
                metadata.prepared = Some(super::retained_candidate::retain(
                    item,
                    updater_smoke_endpoint_override().is_some(),
                )?);
                metadata.candidate_id.clear();
                Ok(metadata)
            })
            .transpose()
    }

    async fn install(
        &self,
        metadata: &UpdateMetadata,
        progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError> {
        let archive = self.download_archive(metadata, progress).await?;
        self.apply_archive(std::sync::Arc::new(archive)).await
    }

    async fn download_archive(
        &self,
        metadata: &UpdateMetadata,
        progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<super::archive::VerifiedArchive, UpdateCommandError> {
        let update = metadata
            .prepared
            .as_ref()
            .ok_or_else(|| UpdateCommandError::new("stale_candidate", "更新候选已失效"))?;
        let mut downloaded = 0u64;
        // SDK finish is BEFORE signature verification: never cache or signal downloaded here.
        let bytes = update
            .download(
                |chunk, total| {
                    downloaded = downloaded.saturating_add(chunk as u64);
                    progress(UpdateProgress {
                        event: "downloading".into(),
                        downloaded,
                        total,
                    });
                },
                || {},
            )
            .await
            .map_err(classify_install_error)?;
        let metadata = metadata.clone();
        // Only await Ok bytes above may cross this production constructor seam.
        tauri::async_runtime::spawn_blocking(move || {
            super::archive::VerifiedArchive::from_verified_download(&metadata, bytes)
        })
        .await
        .map_err(|_| UpdateCommandError::new("internal", "更新包保留失败"))?
    }
    async fn apply_archive(
        &self,
        archive: std::sync::Arc<super::archive::VerifiedArchive>,
    ) -> Result<(), UpdateCommandError> {
        tauri::async_runtime::spawn_blocking(move || {
            let bytes = archive.read_verified()?;
            let update = archive
                .update
                .as_ref()
                .ok_or_else(|| UpdateCommandError::new("stale_candidate", "更新候选已失效"))?;
            update.install(bytes).map_err(|_| {
                UpdateCommandError::new("install_unknown", "安装结果未知，当前版本可能已改变")
            })
        })
        .await
        .map_err(|_| {
            UpdateCommandError::new("install_unknown", "安装结果未知，当前版本可能已改变")
        })?
    }

    async fn before_restart(&self) -> Result<(), UpdateCommandError> {
        crate::app_global_shortcuts::drain(&self.app)
            .await
            .map_err(|_| {
                UpdateCommandError::new("restart_pending", "应用快捷键仍在退出，请重试重启")
            })
    }

    fn restart(&self) -> Result<(), UpdateCommandError> {
        self.app.restart()
    }
}

fn classify_check_error(error: tauri_plugin_updater::Error) -> UpdateCommandError {
    use tauri_plugin_updater::Error;

    let detail = error.to_string();
    let code = match error {
        Error::Reqwest(_) | Error::Network(_) => "network",
        Error::ReleaseNotFound
        | Error::Serialization(_)
        | Error::Semver(_)
        | Error::UrlParse(_)
        | Error::EmptyEndpoints
        | Error::InsecureTransportProtocol => "invalid_manifest",
        Error::TargetNotFound(_)
        | Error::TargetsNotFound(_)
        | Error::UnsupportedArch
        | Error::UnsupportedOs => "missing_architecture",
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) => "invalid_signature",
        _ => "internal",
    };
    let message = match code {
        "network" => "无法连接更新服务，请检查网络后重试",
        "invalid_manifest" => "更新信息无效，请稍后重试",
        "missing_architecture" => "当前 Mac 架构没有可用更新",
        "invalid_signature" => "更新签名无效，已停止安装",
        _ => "检查更新失败",
    };
    let message = if updater_smoke_endpoint_override().is_some() {
        format!("{message}: {detail}")
    } else {
        message.to_string()
    };
    UpdateCommandError::new(code, message)
}

fn classify_install_error(error: tauri_plugin_updater::Error) -> UpdateCommandError {
    use tauri_plugin_updater::Error;

    match error {
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) => {
            UpdateCommandError::new("invalid_signature", "更新签名无效，已停止安装")
        }
        Error::Reqwest(_) | Error::Network(_) => {
            UpdateCommandError::new("download_failed", "更新下载失败，请检查网络后重试")
        }
        Error::PackageInstallFailed
        | Error::FailedToDetermineExtractPath
        | Error::InvalidUpdaterFormat
        | Error::Io(_) => UpdateCommandError::new("install_failed", "更新安装失败，当前版本未改变"),
        other => classify_check_error(other),
    }
}

pub(crate) fn ensure_network_allowed(app: &tauri::AppHandle) -> Result<(), UpdateCommandError> {
    super::provider_guard::authorize(
        super::provider_guard::facts(app),
        updater_smoke_endpoint_override().is_some(),
    )
}
