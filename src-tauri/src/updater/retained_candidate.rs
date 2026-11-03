//! SDK selected-field retention boundary, before the first Arc exists.
use super::{errors, UpdateCommandError};
use serde_json::Value;
use std::sync::Arc;
use tauri::Url;
// Private field port lets the real SDK adapter and caller tests share the exact admission path.
trait SelectedFields {
    fn fields(&mut self) -> (&mut Value, &mut String, &mut Url);
}
impl SelectedFields for tauri_plugin_updater::Update {
    fn fields(&mut self) -> (&mut Value, &mut String, &mut Url) {
        (
            &mut self.raw_json,
            &mut self.signature,
            &mut self.download_url,
        )
    }
}
pub(super) fn retain(
    item: tauri_plugin_updater::Update,
    loopback: bool,
) -> Result<Arc<tauri_plugin_updater::Update>, UpdateCommandError> {
    retain_selected(item, loopback)
}
fn retain_selected<T: SelectedFields>(
    mut item: T,
    loopback: bool,
) -> Result<Arc<T>, UpdateCommandError> {
    let (raw, signature, url) = item.fields();
    *raw = Value::Null;
    if signature.is_empty() || signature.len() > 4096 {
        return Err(errors::fixed("invalid_manifest"));
    }
    if url.as_str().len() > 8192
        || url.as_str().chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(errors::fixed("invalid_manifest"));
    }
    if url.scheme() != "https"
        && !(loopback && url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
    {
        return Err(errors::fixed("invalid_manifest"));
    }
    // Reparse the bounded normalized representation, releasing an SDK URL buffer
    // whose original allocation may have come from a much larger source string.
    *url = Url::parse(url.as_str()).map_err(|_| errors::fixed("invalid_manifest"))?;
    signature.shrink_to_fit();
    Ok(Arc::new(item))
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Fields {
        raw: Value,
        signature: String,
        url: Url,
    }
    impl SelectedFields for Fields {
        fn fields(&mut self) -> (&mut Value, &mut String, &mut Url) {
            (&mut self.raw, &mut self.signature, &mut self.url)
        }
    }
    fn candidate() -> Fields {
        Fields {
            raw: serde_json::json!({"version":"1.0.1","unknown":"x".repeat(2*1024*1024)}),
            signature: "base64-signature".into(),
            url: Url::parse("https://example.com/update.tar.gz").unwrap(),
        }
    }
    #[test]
    fn actual_retention_caller_drops_unknown_manifest_before_shared_references() {
        let prepared = retain_selected(candidate(), false).unwrap();
        let cache = prepared.clone();
        let archive = cache.clone();
        assert!(Arc::ptr_eq(&prepared, &archive));
        assert!(prepared.raw.is_null());
        assert!(cache.raw.is_null());
        assert!(archive.raw.is_null());
        assert_eq!(prepared.signature, "base64-signature");
        assert_eq!(prepared.url.as_str(), "https://example.com/update.tar.gz");
    }
    #[test]
    fn selected_fields_are_bounded_and_production_transport_not_weakened() {
        let mut c = candidate();
        c.signature = "s".repeat(4097);
        assert!(retain_selected(c, false).is_err());
        let mut c = candidate();
        c.url = Url::parse(&format!("https://example.com/{}", "a".repeat(8192))).unwrap();
        assert!(retain_selected(c, false).is_err());
        for url in [
            "http://example.com/a",
            "https://u:p@example.com/a",
            "file:///x",
        ] {
            let mut c = candidate();
            c.url = Url::parse(url).unwrap();
            assert!(retain_selected(c, true).is_err())
        }
        let mut c = candidate();
        c.url = Url::parse("http://127.0.0.1:1234/package").unwrap();
        assert!(retain_selected(c, false).is_err());
        let mut c = candidate();
        c.url = Url::parse("http://127.0.0.1:1234/package").unwrap();
        assert!(retain_selected(c, true).is_ok());
    }
}
