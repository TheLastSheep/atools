//! Narrow, deny-unknown-fields wire and opaque full-snapshot revision tokens.
use super::Runtime;
use atools_core::db::{
    AppGlobalShortcutMutation, AppGlobalShortcutSnapshot, RendererAppIdentity,
    RendererDirectSubtype,
};
use serde::Deserialize;
use serde_json::{json, Value};
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Target {
    kind: String,
    path: String,
    name: String,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum MutationRequest {
    Create {
        shortcut: String,
        target: Target,
        enabled: bool,
        #[serde(rename = "autoCopy")]
        auto_copy: bool,
    },
    Update {
        #[serde(rename = "rowId")]
        row_id: String,
        shortcut: String,
        target: Target,
        enabled: bool,
        #[serde(rename = "autoCopy")]
        auto_copy: bool,
    },
    Adopt {
        #[serde(rename = "rowId")]
        row_id: String,
        shortcut: String,
        target: Target,
        enabled: bool,
        #[serde(rename = "autoCopy")]
        auto_copy: bool,
    },
    Remove {
        #[serde(rename = "rowId")]
        row_id: String,
    },
    SetEnabled {
        #[serde(rename = "rowId")]
        row_id: String,
        enabled: bool,
    },
}
impl Target {
    fn resolve(
        self,
        catalog: &crate::launcher_app_catalog_source::LauncherAppCatalogSource,
    ) -> Result<RendererAppIdentity, String> {
        if self.kind != "app"
            || self.path.is_empty()
            || self.path.len() > 16 * 1024
            || self.name.is_empty()
            || self.name.len() > 4096
            || self.path.contains('\0')
            || self.name.contains('\0')
        {
            return Err("Invalid App identity".into());
        }
        if !catalog.snapshot()?.iter().any(|a| a.path() == self.path) {
            return Err("App target is not in the current Native catalog".into());
        }
        Ok(RendererAppIdentity {
            path: self.path,
            name: self.name,
            sub_type: RendererDirectSubtype::App,
        })
    }
}
impl MutationRequest {
    pub(super) fn resolve(
        self,
        catalog: &crate::launcher_app_catalog_source::LauncherAppCatalogSource,
    ) -> Result<AppGlobalShortcutMutation, String> {
        let validated = |shortcut: &str, auto_copy: bool| -> Result<(), String> {
            if auto_copy {
                return Err("SETTINGS_APP_SHORTCUT_AUTOCOPY_UNSUPPORTED".into());
            }
            super::registry::validated_key(shortcut)?;
            Ok(())
        };
        Ok(match self {
            Self::Create {
                shortcut,
                target,
                enabled,
                auto_copy,
            } => {
                validated(&shortcut, auto_copy)?;
                AppGlobalShortcutMutation::Create {
                    target: target.resolve(catalog)?,
                    shortcut,
                    enabled,
                }
            }
            Self::Update {
                row_id,
                shortcut,
                target,
                enabled,
                auto_copy,
            } => {
                validated(&shortcut, auto_copy)?;
                AppGlobalShortcutMutation::Update {
                    row_id,
                    target: target.resolve(catalog)?,
                    shortcut,
                    enabled,
                }
            }
            Self::Adopt {
                row_id,
                shortcut,
                target,
                enabled,
                auto_copy,
            } => {
                validated(&shortcut, auto_copy)?;
                AppGlobalShortcutMutation::Adopt {
                    row_id,
                    target: target.resolve(catalog)?,
                    shortcut,
                    enabled,
                }
            }
            Self::Remove { row_id } => AppGlobalShortcutMutation::Remove { row_id },
            Self::SetEnabled { row_id, enabled } => {
                AppGlobalShortcutMutation::SetEnabled { row_id, enabled }
            }
        })
    }
}
pub(crate) fn projection(
    rt: &Runtime,
    snapshot: &AppGlobalShortcutSnapshot,
) -> Result<Value, String> {
    let mut token = rt.token.lock();
    if token.as_ref().is_none_or(|(_, old)| old != snapshot) {
        *token = Some((uuid::Uuid::new_v4().simple().to_string(), snapshot.clone()));
    }
    let revision = token.as_ref().ok_or("Snapshot token missing")?.0.clone();
    let rows = public_rows(snapshot.public_raw.as_deref())?;
    let status = rt.status.lock();
    let bindings=snapshot.bindings.iter().map(|b|json!({"rowId":b.row_id,"target":{"kind":"app","path":b.path,"name":b.name},"shortcut":b.shortcut,"enabled":b.enabled})).collect::<Vec<_>>();
    let published = rt.published.lock();
    let runtime = snapshot
        .bindings
        .iter()
        .map(|b| {
            let (mut state, mut error) = status
                .get(&b.row_id)
                .cloned()
                .unwrap_or_else(|| ("unavailable".into(), None));
            if !b.enabled {
                state = "disabled".into();
                error = None;
            } else if !b.public_matches {
                state = "unavailable".into();
                error = Some("Public row does not match Native authority".into());
            } else if state == "registered"
                && published.get(&b.row_id).is_none_or(|p| {
                    p.path != b.path
                        || p.config_generation != b.generation
                        || p.shortcut != b.shortcut
                })
            {
                state = "unavailable".into();
                error = Some("Binding generation is not published".into());
            }
            json!({"rowId":b.row_id,"state":state,"error":error})
        })
        .collect::<Vec<_>>();
    Ok(json!({"version":1,"revision":revision,"rows":rows,"bindings":bindings,"runtime":runtime}))
}

// RawValue prevents unknown extension numbers (including 1e999) from failing a
// display read. This object is never a replacement document or execution grant.
fn public_rows(raw: Option<&str>) -> Result<Vec<Value>, String> {
    let rows: Vec<Box<serde_json::value::RawValue>> =
        serde_json::from_str(raw.unwrap_or("[]")).map_err(|e| e.to_string())?;
    rows.into_iter()
        .map(|row| {
            let fields: std::collections::BTreeMap<String, Box<serde_json::value::RawValue>> =
                serde_json::from_str(row.get()).map_err(|e| e.to_string())?;
            let mut projected = serde_json::Map::new();
            for key in ["id", "shortcut", "target", "configKey"] {
                if let Some(raw) = fields.get(key) {
                    if let Ok(value) = serde_json::from_str::<String>(raw.get()) {
                        projected.insert(key.into(), Value::String(value));
                    }
                }
            }
            for key in [
                "enabled",
                "autoCopy",
                "configurable",
                "preScreenshotOptimization",
            ] {
                if let Some(raw) = fields.get(key) {
                    if let Ok(value) = serde_json::from_str::<bool>(raw.get()) {
                        projected.insert(key.into(), Value::Bool(value));
                    }
                }
            }
            Ok(Value::Object(projected))
        })
        .collect()
}
