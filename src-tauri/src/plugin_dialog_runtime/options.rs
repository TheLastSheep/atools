//! Private, bounded Electron options. Unsupported semantics fail before showing UI.
use super::registry::Access;
use serde::Deserialize;
use serde_json::Value;

pub(super) const MAX_OPTIONS: usize = 32 * 1024;
pub(super) const MAX_PATHS: usize = 128;
pub(super) const MAX_RESULT: usize = 512 * 1024;
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Options {
    pub title: Option<String>,
    pub default_path: Option<String>,
    pub button_label: Option<String>,
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub properties: Vec<String>,
    pub message: Option<String>,
    pub name_field_label: Option<String>,
    pub shows_tag_field: Option<bool>,
    #[serde(default)]
    pub security_scoped_bookmarks: bool,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Filter {
    pub name: String,
    pub extensions: Vec<String>,
}
impl Options {
    pub fn parse(value: &Value, access: Access) -> Result<Self, String> {
        if serde_json::to_vec(value)
            .map_err(|_| "Invalid dialog options")?
            .len()
            > MAX_OPTIONS
        {
            return Err("Dialog options exceed 32 KiB".into());
        }
        let options: Self = serde_json::from_value(value.clone())
            .map_err(|_| "Invalid or unsupported dialog options")?;
        for text in [
            &options.title,
            &options.default_path,
            &options.button_label,
            &options.message,
            &options.name_field_label,
        ]
        .into_iter()
        .flatten()
        {
            if text.len() > 16 * 1024 || text.contains('\0') {
                return Err("Invalid dialog text budget".into());
            }
        }
        if options.filters.len() > 32 || options.properties.len() > 16 {
            return Err("Dialog option count exceeds limit".into());
        }
        for filter in &options.filters {
            if filter.name.len() > 256
                || filter.name.contains('\0')
                || filter.extensions.is_empty()
                || filter.extensions.len() > 64
                || filter.extensions.iter().any(|e| {
                    e.is_empty()
                        || e.len() > 64
                        || (e != "*"
                            && !e
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
                })
            {
                return Err("Invalid dialog file filter".into());
            }
        }
        let allowed: &[&str] = if access == Access::Open {
            &[
                "openFile",
                "openDirectory",
                "multiSelections",
                "showHiddenFiles",
                "createDirectory",
                "noResolveAliases",
                "treatPackageAsDirectory",
                "dontAddToRecent",
            ]
        } else {
            &[
                "showHiddenFiles",
                "createDirectory",
                "treatPackageAsDirectory",
                "showOverwriteConfirmation",
                "dontAddToRecent",
            ]
        };
        if options.security_scoped_bookmarks
            || options
                .properties
                .iter()
                .any(|p| !allowed.contains(&p.as_str()))
            || (access == Access::Open
                && (options.name_field_label.is_some() || options.shows_tag_field.is_some()))
        {
            return Err(
                "ERR_ATOOLS_DIALOG_UNSUPPORTED_OPTIONS: requested dialog option is not supported"
                    .into(),
            );
        }
        Ok(options)
    }
    pub fn has(&self, name: &str) -> bool {
        self.properties.iter().any(|p| p == name)
    }
    pub fn extensions(&self) -> Vec<String> {
        if self
            .filters
            .iter()
            .any(|f| f.extensions.iter().any(|e| e == "*"))
        {
            return vec![];
        }
        let mut extensions: Vec<_> = self
            .filters
            .iter()
            .flat_map(|f| f.extensions.iter().cloned())
            .collect();
        extensions.sort();
        extensions.dedup();
        extensions
    }
}
pub(super) fn validate_result(paths: &[String], access: Access) -> Result<(), String> {
    if paths.len() > if access == Access::Save { 1 } else { MAX_PATHS }
        || paths
            .iter()
            .any(|p| p.is_empty() || p.len() > 16 * 1024 || p.contains('\0'))
        || paths.iter().map(|p| p.len()).sum::<usize>() > MAX_RESULT
    {
        return Err("Dialog selection exceeds result budget".into());
    }
    Ok(())
}
