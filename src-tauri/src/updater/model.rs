const MAX_STATUS_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_VERSION_BYTES: usize = 128;
const MAX_DATE_BYTES: usize = 128;
const MAX_BODY_BYTES: usize = 48 * 1024;
pub(super) const MAX_ERROR_CODE_BYTES: usize = 128;
pub(super) const MAX_ERROR_MESSAGE_BYTES: usize = 8 * 1024;

fn status_response_too_large() -> UpdateCommandError {
    UpdateCommandError::new("state_response_too_large", "更新状态超出响应大小限制")
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub candidate_id: String,
    #[serde(skip)]
    pub(super) prepared: Option<std::sync::Arc<tauri_plugin_updater::Update>>,
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

impl UpdateMetadata {
    #[cfg(test)]
    pub(crate) fn test_candidate() -> Self {
        Self {
            candidate_id: "a".repeat(32),
            prepared: None,
            current_version: "1.0.0".into(),
            version: "1.0.1".into(),
            date: None,
            body: Some("notes".into()),
        }
    }

    pub(super) fn validate_status_fields(&self) -> Result<(), UpdateCommandError> {
        if self.current_version.len() > MAX_VERSION_BYTES
            || self.version.len() > MAX_VERSION_BYTES
            || self
                .date
                .as_ref()
                .is_some_and(|value| value.len() > MAX_DATE_BYTES)
            || self
                .body
                .as_ref()
                .is_some_and(|value| value.len() > MAX_BODY_BYTES)
        {
            return Err(status_response_too_large());
        }
        Ok(())
    }
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

impl UpdateCommandError {
    pub(super) fn validate_status_fields(&self) -> Result<(), UpdateCommandError> {
        if self.code.len() > MAX_ERROR_CODE_BYTES || self.message.len() > MAX_ERROR_MESSAGE_BYTES {
            return Err(status_response_too_large());
        }
        Ok(())
    }
}

#[async_trait::async_trait]
pub trait UpdateBackend: Send + Sync {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError>;

    async fn install(
        &self,
        metadata: &UpdateMetadata,
        progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError>;

    async fn download_archive(
        &self,
        metadata: &UpdateMetadata,
        progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<super::archive::VerifiedArchive, UpdateCommandError>;
    async fn apply_archive(
        &self,
        archive: std::sync::Arc<super::archive::VerifiedArchive>,
    ) -> Result<(), UpdateCommandError>;
    async fn before_restart(&self) -> Result<(), UpdateCommandError> {
        Ok(())
    }
    fn restart(&self) -> Result<(), UpdateCommandError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateOperation {
    Idle,
    Checking,
    Installing,
    Restarting,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub operation: UpdateOperation,
    pub update: Option<UpdateMetadata>,
    pub checked: bool,
    pub last_error: Option<UpdateCommandError>,
}

impl UpdateStatus {
    pub(super) fn validate_serialized_size(&self) -> Result<(), UpdateCommandError> {
        let encoded = serde_json::to_vec(self).map_err(|_| status_response_too_large())?;
        if encoded.len() > MAX_STATUS_RESPONSE_BYTES {
            return Err(status_response_too_large());
        }
        Ok(())
    }
}

impl std::fmt::Debug for UpdateMetadata {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpdateMetadata")
            .field("candidate_id", &self.candidate_id)
            .field("version", &self.version)
            .finish()
    }
}
impl PartialEq for UpdateMetadata {
    fn eq(&self, o: &Self) -> bool {
        self.candidate_id == o.candidate_id
            && self.current_version == o.current_version
            && self.version == o.version
            && self.date == o.date
            && self.body == o.body
    }
}
impl Eq for UpdateMetadata {}
