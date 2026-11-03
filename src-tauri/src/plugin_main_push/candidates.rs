//! Declared-command matching uses the database's existing compiled snapshot.
use super::dto::{CommandType, Identity};
use atools_core::{Cmd, CmdType, Database, Plugin};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidate {
    #[serde(flatten)]
    pub identity: Identity,
    pub result: crate::commands::SearchResult,
}
fn supported(plugin: &Plugin) -> bool {
    plugin.enabled
        && platform_matches(&plugin.manifest.platform)
        && (plugin.manifest.main.as_deref().is_some_and(|m| {
            let name = m
                .split(['?', '#'])
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            name.ends_with(".html") || name.ends_with(".htm")
        }) || plugin
            .manifest
            .preload
            .as_deref()
            .is_some_and(|p| !p.trim().is_empty()))
}
fn has_type(feature: &atools_core::FeatureEntry, kind: CommandType) -> bool {
    feature.cmds.iter().any(|command| {
        matches!(
            (command, kind),
            (Cmd::Text(_), CommandType::Text)
                | (
                    Cmd::Typed(atools_core::CmdTyped {
                        type_: CmdType::Regex,
                        ..
                    }),
                    CommandType::Regex
                )
                | (
                    Cmd::Typed(atools_core::CmdTyped {
                        type_: CmdType::Over,
                        ..
                    }),
                    CommandType::Over
                )
        )
    })
}
fn platform_matches(platforms: &[String]) -> bool {
    let current = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        value => value,
    };
    platforms.is_empty() || platforms.iter().any(|p| p == current)
}
fn declaration(db: &Database, plugin: &Plugin, code: &str) -> Result<atools_core::Feature, String> {
    if let Some(feature) = plugin.manifest.features.iter().find(|f| f.code == code) {
        return Ok(feature.clone());
    }
    db.plugin_dynamic_features(&plugin.id, Some(&[code.to_string()]))
        .map_err(|_| "ERR_MAIN_PUSH_CODE_CHANGED")?
        .into_iter()
        .next()
        .and_then(|v| serde_json::from_value(v).ok())
        .ok_or_else(|| "ERR_MAIN_PUSH_CODE_CHANGED".into())
}
fn plugin_revision(db: &Database, plugin: &Plugin) -> Result<String, String> {
    let value = json!({"plugin":plugin,"codeRevision":crate::plugin_code_revision::current(db, &plugin.id).map_err(|_| "ERR_MAIN_PUSH_CODE_CHANGED")?});
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&atools_core::harness::canonicalize_json(&value))
                .map_err(|_| "ERR_MAIN_PUSH_CODE_CHANGED")?
        )
    ))
}
fn revision(
    base: &str,
    source: &super::platform_source::Platforms,
    feature: &atools_core::FeatureEntry,
    declaration: &atools_core::Feature,
) -> Result<String, String> {
    let value = json!({"pluginRevision":base,"platformSource":source.digest,"feature":feature,"declaration":declaration});
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&atools_core::harness::canonicalize_json(&value))
                .map_err(|_| "ERR_MAIN_PUSH_CODE_CHANGED")?
        )
    ))
}
pub(super) fn validate(db: &Database, identity: &Identity) -> Result<Plugin, String> {
    let plugin = db
        .get_plugin(&identity.plugin_id)
        .map_err(|_| "ERR_MAIN_PUSH_OWNER_CHANGED")?;
    let feature = db
        .get_feature(&identity.feature_code)
        .map_err(|_| "ERR_MAIN_PUSH_OWNER_CHANGED")?;
    let declared = declaration(db, &plugin, &feature.code)?;
    let base = plugin_revision(db, &plugin)?;
    let source = super::platform_source::current(&plugin, &base)?;
    let source_feature = source.features.get(&feature.code);
    let source_matches = platform_matches(&source.plugin)
        && source_feature.map_or_else(
            || {
                !plugin
                    .manifest
                    .features
                    .iter()
                    .any(|f| f.code == feature.code)
            },
            |p| platform_matches(p),
        );
    if feature.plugin_id != plugin.id
        || !feature.main_push
        || !declared.main_push
        || !supported(&plugin)
        || !source_matches
        || !platform_matches(&declared.platform)
        || !has_type(&feature, identity.command_type)
        || revision(&base, &source, &feature, &declared)? != identity.code_revision
    {
        return Err("ERR_MAIN_PUSH_CODE_CHANGED".into());
    }
    Ok(plugin)
}
pub(super) fn search(
    db: &Database,
    query: &str,
    fixed: bool,
    builtin_root: Option<&Path>,
) -> Result<Vec<Candidate>, String> {
    if !fixed && query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let snapshot = db
        .feature_catalog_snapshot()
        .map_err(|_| "ERR_MAIN_PUSH_CATALOG_UNAVAILABLE")?;
    let matches = if fixed {
        snapshot.search_text_content(query)
    } else {
        snapshot.search_commands_checked(query)
    }
    .map_err(|_| "ERR_MAIN_PUSH_QUERY_BUDGET")?;
    let matches = matches
        .into_iter()
        .filter(|matched| {
            snapshot
                .find(&matched.plugin_id, &matched.feature_code)
                .is_some_and(|entry| entry.feature.main_push)
        })
        .collect::<Vec<_>>();
    let projected = crate::launcher_catalog::project_matches(&snapshot, matches, builtin_root)?;
    let mut plugins = std::collections::HashMap::new();
    let mut result = Vec::new();
    for display in projected {
        let Some(kind) = CommandType::from_match(display.match_type) else {
            continue;
        };
        let Some(entry) = snapshot
            .find(&display.plugin_id, &display.code)
            .filter(|e| e.feature.main_push)
        else {
            continue;
        };
        if !plugins.contains_key(&display.plugin_id) {
            plugins.insert(
                display.plugin_id.clone(),
                db.get_plugin(&display.plugin_id)
                    .ok()
                    .and_then(|p| plugin_revision(db, &p).ok().map(|rev| (p, rev))),
            );
        }
        let Some((plugin, base)) = plugins[&display.plugin_id]
            .as_ref()
            .filter(|(p, _)| supported(p))
        else {
            continue;
        };
        let Ok(declared) = declaration(db, plugin, &entry.feature.code) else {
            continue;
        };
        let Ok(source) = super::platform_source::current(plugin, base) else {
            continue;
        };
        let source_feature = source.features.get(&entry.feature.code);
        let source_matches = platform_matches(&source.plugin)
            && source_feature.map_or_else(
                || {
                    !plugin
                        .manifest
                        .features
                        .iter()
                        .any(|f| f.code == entry.feature.code)
                },
                |p| platform_matches(p),
            );
        if !declared.main_push || !platform_matches(&declared.platform) || !source_matches {
            continue;
        }
        result.push(Candidate {
            identity: Identity {
                plugin_id: plugin.id.clone(),
                feature_code: display.code.clone(),
                command_type: kind,
                code_revision: revision(base, &source, &entry.feature, &declared)?,
            },
            result: display,
        });
    }
    Ok(result)
}
