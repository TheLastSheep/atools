use atools_core::ai_service::{valid_model_id, AiErrorCode, AiModel, AiServiceError};
use reqwest::Url;
use serde_json::Value;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiProviderKind {
    OpenAi,
    Compatible,
    Local,
}

impl AiProviderKind {
    fn parse(value: &str) -> Result<Self, AiServiceError> {
        match value {
            "openai" => Ok(Self::OpenAi),
            "compatible" => Ok(Self::Compatible),
            "local" => Ok(Self::Local),
            "" | "disabled" => Err(AiServiceError::new(AiErrorCode::NotConfigured)),
            _ => Err(AiServiceError::new(AiErrorCode::NotConfigured)),
        }
    }
}

pub struct AiProviderConfig {
    base_url: Url,
    default_model: Option<String>,
    api_key: Zeroizing<String>,
    proxy_url: Option<String>,
    temperature: f64,
}

impl AiProviderConfig {
    pub fn from_settings(settings: &Value) -> Result<Self, AiServiceError> {
        let provider = settings
            .get("aiProvider")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let provider = AiProviderKind::parse(provider)?;
        let base = settings
            .get("aiBaseUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let mut base_url =
            Url::parse(base).map_err(|_| AiServiceError::new(AiErrorCode::NotConfigured))?;
        if !matches!(base_url.scheme(), "http" | "https")
            || !base_url.username().is_empty()
            || base_url.password().is_some()
        {
            return Err(AiServiceError::new(AiErrorCode::NotConfigured));
        }
        let default_model = nonempty(settings, "aiDefaultModel");
        if default_model
            .as_deref()
            .is_some_and(|model| !valid_model_id(model))
        {
            return Err(AiServiceError::new(AiErrorCode::NotConfigured));
        }
        let api_key = nonempty(settings, "aiApiKey").unwrap_or_default();
        if provider != AiProviderKind::Local && api_key.is_empty() {
            return Err(AiServiceError::new(AiErrorCode::NotConfigured));
        }
        let proxy_url = crate::commands::network_proxy_url_from_settings(settings)
            .map_err(|_| AiServiceError::new(AiErrorCode::NotConfigured))?;
        let temperature = settings
            .get("aiTemperature")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && (0.0..=2.0).contains(value))
            .unwrap_or(0.2);
        base_url.set_fragment(None);
        Ok(Self {
            base_url,
            default_model,
            api_key: Zeroizing::new(api_key),
            proxy_url,
            temperature,
        })
    }

    pub fn default_model(&self) -> Option<&str> {
        self.default_model.as_deref()
    }
    pub(crate) fn api_key(&self) -> &str {
        self.api_key.as_str()
    }
    pub(crate) fn proxy_url(&self) -> Option<&str> {
        self.proxy_url.as_deref()
    }
    pub(crate) fn temperature(&self) -> f64 {
        self.temperature
    }

    pub fn resolve_model(
        &self,
        requested: Option<&str>,
        catalog: &[AiModel],
    ) -> Result<String, AiServiceError> {
        let model = match requested {
            Some(model) if valid_model_id(model) => model,
            Some(_) => return Err(AiServiceError::new(AiErrorCode::InvalidRequest)),
            None => self
                .default_model()
                .ok_or_else(|| AiServiceError::new(AiErrorCode::NotConfigured))?,
        };
        if self.default_model() == Some(model)
            || catalog.iter().any(|item| item.id.as_str() == model)
        {
            Ok(model.to_string())
        } else {
            Err(AiServiceError::new(AiErrorCode::UnknownModel))
        }
    }

    #[cfg(test)]
    pub fn models_url(&self) -> Result<Url, AiServiceError> {
        self.endpoint(&["models"])
    }
    pub fn chat_completions_url(&self) -> Result<Url, AiServiceError> {
        self.endpoint(&["chat", "completions"])
    }

    fn endpoint(&self, suffix: &[&str]) -> Result<Url, AiServiceError> {
        let mut url = self.base_url.clone();
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| AiServiceError::new(AiErrorCode::NotConfigured))?;
        segments.pop_if_empty();
        for segment in suffix {
            segments.push(segment);
        }
        drop(segments);
        Ok(url)
    }
}

fn nonempty(settings: &Value, key: &str) -> Option<String> {
    settings
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(default_model: &str) -> AiProviderConfig {
        AiProviderConfig::from_settings(
            &json!({"aiProvider":"compatible","aiBaseUrl":"https://example.invalid/v1/",
            "aiDefaultModel":default_model,"aiApiKey":"test-secret","proxyEnabled":false}),
        )
        .ok()
        .unwrap()
    }

    #[test]
    fn endpoint_and_model_default_are_resolved_without_fabricating_catalog_entries() {
        let config = config("configured-but-unlisted");
        assert_eq!(
            config.models_url().unwrap().as_str(),
            "https://example.invalid/v1/models"
        );
        assert_eq!(
            config.chat_completions_url().unwrap().as_str(),
            "https://example.invalid/v1/chat/completions"
        );
        assert_eq!(
            config.resolve_model(None, &[]).unwrap(),
            "configured-but-unlisted"
        );
        assert_eq!(
            config.resolve_model(Some("unknown"), &[]).unwrap_err().code,
            AiErrorCode::UnknownModel
        );
        let catalog = vec![AiModel {
            id: "listed".into(),
            value: "listed".into(),
            label: "listed".into(),
        }];
        assert_eq!(
            config.resolve_model(Some("listed"), &catalog).unwrap(),
            "listed"
        );
    }

    #[test]
    fn invalid_or_missing_settings_fail_without_echoing_secrets_or_urls() {
        let missing = AiProviderConfig::from_settings(
            &json!({"aiProvider":"compatible","aiBaseUrl":"https://example.invalid"}),
        )
        .err()
        .unwrap();
        assert_eq!(missing.code, AiErrorCode::NotConfigured);
        let invalid = AiProviderConfig::from_settings(&json!({"aiProvider":"compatible","aiBaseUrl":"file:///tmp/key","aiApiKey":"test-secret"})).err().unwrap();
        assert_eq!(invalid.code, AiErrorCode::NotConfigured);
        assert!(!missing.to_string().contains("example.invalid"));
        assert!(!invalid.to_string().contains("/tmp/key"));
    }
}
