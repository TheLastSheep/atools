//! Exact, isolated bootstrap grants for the original Image-Toolbox smoke.
use atools_core::{Database, Plugin};
use std::collections::BTreeSet;

pub(super) const FIXTURE_ID: &str = "batch65-image-toolbox-original";
const CLIENT: &str = "atools-ui";
pub(super) const PREGRANTED_CAPABILITY_KINDS: [&str; 5] = [
    "legacy_node",
    "plugin_data",
    "paths_standard",
    "dialogs_open",
    "dialogs_save",
];

pub(super) fn grant_bootstrap_capabilities(
    db: &Database,
    plugin: &Plugin,
) -> Result<[&'static str; 5], String> {
    if plugin.id != FIXTURE_ID || !plugin.enabled {
        return Err(
            "Image-Toolbox bootstrap grants require the exact enabled fixture plugin".into(),
        );
    }
    let tools = [
        (
            "legacy_node",
            crate::legacy_runtime::registry::ensure_tool(db, plugin)?,
        ),
        (
            "plugin_data",
            crate::plugin_data_runtime::registry::ensure_tool(db, plugin)?,
        ),
        (
            "paths_standard",
            crate::plugin_system_paths::registry::ensure_tool(
                db,
                plugin,
                crate::plugin_system_paths::registry::Access::Standard,
            )?,
        ),
        (
            "dialogs_open",
            crate::plugin_dialog_runtime::registry::ensure_tool(
                db,
                plugin,
                crate::plugin_dialog_runtime::registry::Access::Open,
            )?,
        ),
        (
            "dialogs_save",
            crate::plugin_dialog_runtime::registry::ensure_tool(
                db,
                plugin,
                crate::plugin_dialog_runtime::registry::Access::Save,
            )?,
        ),
    ];
    let mut expected_names = BTreeSet::new();
    for (_, name) in &tools {
        db.grant_agent_tool(CLIENT, name)
            .map_err(|_| "Image-Toolbox fixture grant setup failed")?;
        if !db
            .is_agent_tool_granted(CLIENT, name)
            .map_err(|_| "Image-Toolbox fixture grant verification failed")?
        {
            return Err("Image-Toolbox fixture grant was not persisted".into());
        }
        expected_names.insert(name.clone());
    }
    let grants = db
        .list_agent_tool_grants()
        .map_err(|_| "Image-Toolbox fixture grant inventory failed")?;
    let actual_names: BTreeSet<_> = grants.iter().map(|grant| grant.tool_name.clone()).collect();
    if grants.len() != PREGRANTED_CAPABILITY_KINDS.len()
        || grants.iter().any(|grant| grant.client_id != CLIENT)
        || actual_names != expected_names
    {
        return Err("Image-Toolbox fixture has an unexpected grant set".into());
    }
    Ok(PREGRANTED_CAPABILITY_KINDS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use atools_core::agent::ToolDefinition;
    use atools_core::{agent::PermissionScope, PluginManifest};

    fn plugin(id: &str, enabled: bool) -> Plugin {
        Plugin {
            id: id.into(),
            name: "Image-Toolbox fixture".into(),
            version: "1.0.0".into(),
            path: "/private/fixture/plugin".into(),
            enabled,
            manifest: PluginManifest {
                platform: vec![],
                name: "Image-Toolbox fixture".into(),
                title: None,
                version: "1.0.0".into(),
                main: Some("src/index.html".into()),
                logo: None,
                preload: Some("preload.js".into()),
                description: None,
                author: None,
                homepage: None,
                plugin_setting: None,
                features: vec![],
                development: None,
                tools: Default::default(),
                providers: Default::default(),
                permissions: vec![],
                runtime: None,
            },
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn tool(db: &Database, name: &str) -> ToolDefinition {
        db.get_agent_tool(name)
            .unwrap()
            .expect("registered fixture tool")
    }

    #[test]
    fn grants_only_exact_fixture_tools_with_their_registered_scopes() {
        let db = Database::in_memory().unwrap();
        let plugin = plugin(FIXTURE_ID, true);
        db.save_plugin_with_features(&plugin, &[]).unwrap();
        let categories = grant_bootstrap_capabilities(&db, &plugin).unwrap();
        assert_eq!(categories, PREGRANTED_CAPABILITY_KINDS);

        let node = crate::legacy_runtime::registry::tool_name(FIXTURE_ID);
        let data = crate::plugin_data_runtime::registry::tool_name(FIXTURE_ID);
        let paths = crate::plugin_system_paths::registry::tool_name(
            FIXTURE_ID,
            crate::plugin_system_paths::registry::Access::Standard,
        );
        let dialog_open = crate::plugin_dialog_runtime::registry::tool_name(
            FIXTURE_ID,
            crate::plugin_dialog_runtime::registry::Access::Open,
        );
        let dialog_save = crate::plugin_dialog_runtime::registry::tool_name(
            FIXTURE_ID,
            crate::plugin_dialog_runtime::registry::Access::Save,
        );
        let expected: BTreeSet<_> = [
            node.clone(),
            data.clone(),
            paths.clone(),
            dialog_open.clone(),
            dialog_save.clone(),
        ]
        .into_iter()
        .collect();
        let grants = db.list_agent_tool_grants().unwrap();
        assert_eq!(grants.len(), expected.len());
        assert!(grants
            .iter()
            .all(|grant| grant.client_id == CLIENT && expected.contains(&grant.tool_name)));

        for (name, source, scope) in [
            (&data, "plugin_data", PermissionScope::PluginData),
            (&paths, "plugin_system_paths", PermissionScope::FileRead),
            (&dialog_open, "plugin_dialog", PermissionScope::FileRead),
            (&dialog_save, "plugin_dialog", PermissionScope::FileWrite),
        ] {
            let registered = tool(&db, name);
            assert_eq!(registered.source, source);
            assert_eq!(registered.plugin_id.as_deref(), Some(FIXTURE_ID));
            assert_eq!(registered.scopes, vec![scope]);
        }
        assert!(db.is_agent_tool_granted(CLIENT, &node).unwrap());
        let ungranted_path_data = crate::plugin_system_paths::registry::tool_name(
            FIXTURE_ID,
            crate::plugin_system_paths::registry::Access::PluginData,
        );
        assert!(!grants
            .iter()
            .any(|grant| grant.tool_name == ungranted_path_data));
    }

    #[test]
    fn rejects_wrong_or_disabled_fixture_before_creating_grants() {
        for plugin in [plugin("other-plugin", true), plugin(FIXTURE_ID, false)] {
            let db = Database::in_memory().unwrap();
            assert!(grant_bootstrap_capabilities(&db, &plugin).is_err());
            assert!(db.list_agent_tool_grants().unwrap().is_empty());
            assert!(db.list_agent_tools().unwrap().is_empty());
        }
    }
}
