use tauri::Manager;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub event: String,
    pub downloaded: u64,
    pub total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct UpdateCommandError {
    pub code: String,
    pub message: String,
}

impl UpdateCommandError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[async_trait::async_trait]
pub trait UpdateBackend: Send + Sync {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError>;
    async fn install(
        &self,
        expected_version: &str,
        progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError>;
    fn restart(&self) -> Result<(), UpdateCommandError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpdateOperation {
    Idle,
    Checking,
    Installing,
}

struct CoordinatorInner {
    operation: UpdateOperation,
    checked_at: Option<std::time::Instant>,
    cached: Option<Option<UpdateMetadata>>,
}

pub struct UpdateCoordinator {
    inner: tokio::sync::Mutex<CoordinatorInner>,
    cache_ttl: std::time::Duration,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub operation: String,
    pub update: Option<UpdateMetadata>,
    pub checked: bool,
}

impl Default for UpdateCoordinator {
    fn default() -> Self {
        Self {
            inner: tokio::sync::Mutex::new(CoordinatorInner {
                operation: UpdateOperation::Idle,
                checked_at: None,
                cached: None,
            }),
            cache_ttl: std::time::Duration::from_secs(10),
        }
    }
}

impl UpdateCoordinator {
    pub async fn check<B: UpdateBackend + ?Sized>(
        &self,
        backend: &B,
    ) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        let mut inner = self.inner.lock().await;
        if let (Some(checked_at), Some(cached)) = (inner.checked_at, inner.cached.as_ref()) {
            if checked_at.elapsed() <= self.cache_ttl {
                return Ok(cached.clone());
            }
        }

        inner.operation = UpdateOperation::Checking;
        let result = backend.check().await.and_then(normalize_update);
        inner.operation = UpdateOperation::Idle;

        match result {
            Ok(update) => {
                inner.checked_at = Some(std::time::Instant::now());
                inner.cached = Some(update.clone());
                Ok(update)
            }
            Err(error) => {
                inner.checked_at = None;
                inner.cached = None;
                Err(error)
            }
        }
    }

    pub async fn install<B, F>(
        &self,
        backend: &B,
        expected_version: &str,
        progress: F,
    ) -> Result<(), UpdateCommandError>
    where
        B: UpdateBackend + ?Sized,
        F: Fn(UpdateProgress) + Send + Sync + 'static,
    {
        let mut inner = self.inner.lock().await;
        let cached = inner
            .cached
            .as_ref()
            .and_then(Option::as_ref)
            .ok_or_else(|| {
                UpdateCommandError::new("no_update", "没有可安装的更新，请先检查更新")
            })?;
        if cached.version != expected_version {
            return Err(UpdateCommandError::new(
                "version_mismatch",
                "可用版本已变化，请重新检查",
            ));
        }

        inner.operation = UpdateOperation::Installing;
        let result = backend.install(expected_version, Box::new(progress)).await;
        inner.operation = UpdateOperation::Idle;

        result?;
        inner.checked_at = None;
        inner.cached = None;
        backend.restart()
    }

    pub async fn status(&self) -> UpdateStatus {
        let inner = self.inner.lock().await;
        UpdateStatus {
            operation: match inner.operation {
                UpdateOperation::Idle => "idle",
                UpdateOperation::Checking => "checking",
                UpdateOperation::Installing => "installing",
            }
            .into(),
            update: inner.cached.clone().flatten(),
            checked: inner.checked_at.is_some(),
        }
    }
}

fn normalize_update(
    update: Option<UpdateMetadata>,
) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
    let Some(update) = update else {
        return Ok(None);
    };
    let current = semver::Version::parse(&update.current_version)
        .map_err(|_| UpdateCommandError::new("invalid_manifest", "当前应用版本格式无效"))?;
    let available = semver::Version::parse(&update.version)
        .map_err(|_| UpdateCommandError::new("invalid_manifest", "更新版本格式无效"))?;
    Ok((available > current).then_some(update))
}

struct TauriUpdateBackend {
    app: tauri::AppHandle,
}

#[async_trait::async_trait]
impl UpdateBackend for TauriUpdateBackend {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        use tauri_plugin_updater::UpdaterExt;

        let update = self
            .app
            .updater()
            .map_err(classify_check_error)?
            .check()
            .await
            .map_err(classify_check_error)?;
        Ok(update.map(|item| UpdateMetadata {
            current_version: item.current_version,
            version: item.version,
            date: item.date.map(|value| value.to_string()),
            body: item.body,
        }))
    }

    async fn install(
        &self,
        expected_version: &str,
        progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError> {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::sync::{Arc, Mutex};
        use tauri_plugin_updater::UpdaterExt;

        let update = self
            .app
            .updater()
            .map_err(classify_check_error)?
            .check()
            .await
            .map_err(classify_check_error)?
            .ok_or_else(|| UpdateCommandError::new("no_update", "没有可安装的更新"))?;
        if update.version != expected_version {
            return Err(UpdateCommandError::new(
                "version_mismatch",
                "可用版本已变化，请重新检查",
            ));
        }

        let progress: Arc<dyn Fn(UpdateProgress) + Send + Sync> = Arc::from(progress);
        let downloaded = Arc::new(AtomicU64::new(0));
        let total = Arc::new(Mutex::new(None));
        let download_progress = Arc::clone(&progress);
        let download_bytes = Arc::clone(&downloaded);
        let download_total = Arc::clone(&total);
        let install_progress = Arc::clone(&progress);
        let install_bytes = Arc::clone(&downloaded);
        let install_total = Arc::clone(&total);

        update
            .download_and_install(
                move |chunk, expected_total| {
                    let current =
                        download_bytes.fetch_add(chunk as u64, Ordering::SeqCst) + chunk as u64;
                    if let Ok(mut value) = download_total.lock() {
                        *value = expected_total;
                    }
                    download_progress(UpdateProgress {
                        event: "downloading".into(),
                        downloaded: current,
                        total: expected_total,
                    });
                },
                move || {
                    install_progress(UpdateProgress {
                        event: "installing".into(),
                        downloaded: install_bytes.load(Ordering::SeqCst),
                        total: install_total.lock().ok().and_then(|value| *value),
                    });
                },
            )
            .await
            .map_err(classify_install_error)
    }

    fn restart(&self) -> Result<(), UpdateCommandError> {
        self.app.restart()
    }
}

fn classify_check_error(error: tauri_plugin_updater::Error) -> UpdateCommandError {
    use tauri_plugin_updater::Error;

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

fn ensure_updater_window(label: &str) -> Result<(), UpdateCommandError> {
    if matches!(label, "main" | "settings") {
        Ok(())
    } else {
        Err(UpdateCommandError::new(
            "forbidden_window",
            "当前窗口无权管理应用更新",
        ))
    }
}

#[tauri::command]
pub async fn check_app_update(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateCoordinator>,
) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
    ensure_updater_window(window.label())?;
    let backend = TauriUpdateBackend {
        app: window.app_handle().clone(),
    };
    state.check(&backend).await
}

#[tauri::command]
pub async fn install_app_update(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateCoordinator>,
    expected_version: String,
) -> Result<(), UpdateCommandError> {
    use tauri::Emitter;

    ensure_updater_window(window.label())?;
    let app = window.app_handle().clone();
    let backend = TauriUpdateBackend { app: app.clone() };
    state
        .install(&backend, &expected_version, move |progress| {
            if let Err(error) = app.emit("app-update-progress", progress) {
                tracing::warn!("Failed to emit app update progress: {error}");
            }
        })
        .await
}

#[tauri::command]
pub async fn get_app_update_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateCoordinator>,
) -> Result<UpdateStatus, UpdateCommandError> {
    ensure_updater_window(window.label())?;
    Ok(state.status().await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    struct FakeBackend {
        update: Mutex<Option<UpdateMetadata>>,
        check_calls: AtomicUsize,
        install_calls: AtomicUsize,
        restart_calls: AtomicUsize,
        fail_install: AtomicBool,
    }

    impl FakeBackend {
        fn with_versions(current: &str, available: &str) -> Self {
            Self {
                update: Mutex::new(Some(UpdateMetadata {
                    current_version: current.into(),
                    version: available.into(),
                    date: Some("2026-07-15T00:00:00Z".into()),
                    body: Some("Security and reliability fixes".into()),
                })),
                check_calls: AtomicUsize::new(0),
                install_calls: AtomicUsize::new(0),
                restart_calls: AtomicUsize::new(0),
                fail_install: AtomicBool::new(false),
            }
        }

        fn check_calls(&self) -> usize {
            self.check_calls.load(Ordering::SeqCst)
        }

        fn install_calls(&self) -> usize {
            self.install_calls.load(Ordering::SeqCst)
        }

        fn restart_calls(&self) -> usize {
            self.restart_calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait::async_trait]
    impl UpdateBackend for FakeBackend {
        async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
            self.check_calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(self.update.lock().expect("update mutex").clone())
        }

        async fn install(
            &self,
            _expected_version: &str,
            progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
        ) -> Result<(), UpdateCommandError> {
            self.install_calls.fetch_add(1, Ordering::SeqCst);
            progress(UpdateProgress {
                event: "downloading".into(),
                downloaded: 50,
                total: Some(100),
            });
            tokio::task::yield_now().await;
            if self.fail_install.load(Ordering::SeqCst) {
                return Err(UpdateCommandError::new("install_failed", "更新安装失败"));
            }
            Ok(())
        }

        fn restart(&self) -> Result<(), UpdateCommandError> {
            self.restart_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn concurrent_and_fresh_checks_share_one_backend_result() {
        let coordinator = Arc::new(UpdateCoordinator::default());
        let backend = Arc::new(FakeBackend::with_versions("3.0.0", "3.0.1"));
        let first = {
            let coordinator = Arc::clone(&coordinator);
            let backend = Arc::clone(&backend);
            tokio::spawn(async move { coordinator.check(backend.as_ref()).await })
        };
        let second = {
            let coordinator = Arc::clone(&coordinator);
            let backend = Arc::clone(&backend);
            tokio::spawn(async move { coordinator.check(backend.as_ref()).await })
        };

        let first = first.await.expect("first join").expect("first check");
        let second = second.await.expect("second join").expect("second check");
        let third = coordinator
            .check(backend.as_ref())
            .await
            .expect("cached check");

        assert_eq!(
            backend.check_calls(),
            1,
            "concurrent/fresh checks must share one result"
        );
        assert_eq!(first, second);
        assert_eq!(second, third);
        assert_eq!(
            first.as_ref().map(|item| item.version.as_str()),
            Some("3.0.1")
        );
    }

    #[tokio::test]
    async fn same_or_lower_version_is_not_an_update() {
        for available in ["3.0.0", "2.9.9"] {
            let coordinator = UpdateCoordinator::default();
            let backend = FakeBackend::with_versions("3.0.0", available);
            assert_eq!(coordinator.check(&backend).await.expect("check"), None);
        }
    }

    #[tokio::test]
    async fn install_rejects_a_version_other_than_the_cached_update() {
        let coordinator = UpdateCoordinator::default();
        let backend = FakeBackend::with_versions("3.0.0", "3.0.1");
        coordinator.check(&backend).await.expect("check");

        let error = coordinator
            .install(&backend, "3.0.0", |_| {})
            .await
            .expect_err("version mismatch");

        assert_eq!(error.code, "version_mismatch");
        assert_eq!(backend.install_calls(), 0);
    }

    #[tokio::test]
    async fn failed_install_never_restarts() {
        let coordinator = UpdateCoordinator::default();
        let backend = FakeBackend::with_versions("3.0.0", "3.0.1");
        backend.fail_install.store(true, Ordering::SeqCst);
        coordinator.check(&backend).await.expect("check");

        let error = coordinator
            .install(&backend, "3.0.1", |_| {})
            .await
            .expect_err("install failure");

        assert_eq!(error.code, "install_failed");
        assert_eq!(
            backend.restart_calls(),
            0,
            "failed installation must not restart"
        );
    }

    #[tokio::test]
    async fn successful_install_forwards_progress_and_restarts_once() {
        let coordinator = UpdateCoordinator::default();
        let backend = FakeBackend::with_versions("3.0.0", "3.0.1");
        let progress = Arc::new(Mutex::new(Vec::new()));
        coordinator.check(&backend).await.expect("check");

        coordinator
            .install(&backend, "3.0.1", {
                let progress = Arc::clone(&progress);
                move |item| progress.lock().expect("progress mutex").push(item)
            })
            .await
            .expect("install");

        assert_eq!(backend.install_calls(), 1);
        assert_eq!(
            backend.restart_calls(),
            1,
            "successful installation restarts exactly once"
        );
        assert_eq!(progress.lock().expect("progress mutex")[0].downloaded, 50);
    }

    #[tokio::test]
    async fn concurrent_installs_are_serialized_and_only_one_reaches_backend() {
        let coordinator = Arc::new(UpdateCoordinator::default());
        let backend = Arc::new(FakeBackend::with_versions("3.0.0", "3.0.1"));
        coordinator.check(backend.as_ref()).await.expect("check");

        let first = {
            let coordinator = Arc::clone(&coordinator);
            let backend = Arc::clone(&backend);
            tokio::spawn(
                async move { coordinator.install(backend.as_ref(), "3.0.1", |_| {}).await },
            )
        };
        let second = {
            let coordinator = Arc::clone(&coordinator);
            let backend = Arc::clone(&backend);
            tokio::spawn(
                async move { coordinator.install(backend.as_ref(), "3.0.1", |_| {}).await },
            )
        };

        let results = [
            first.await.expect("first join"),
            second.await.expect("second join"),
        ];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(backend.install_calls(), 1);
    }

    #[test]
    fn updater_commands_allow_only_main_and_settings_windows() {
        assert!(ensure_updater_window("main").is_ok());
        assert!(ensure_updater_window("settings").is_ok());
        assert_eq!(
            ensure_updater_window("plugin-detach-1")
                .expect_err("detached plugin window must be rejected")
                .code,
            "forbidden_window"
        );
    }
}
