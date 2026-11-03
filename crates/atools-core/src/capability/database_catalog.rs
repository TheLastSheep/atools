//! Database-backed discovery uses the same enabled feature snapshot as search.
use super::{capability_catalog, Capability, CapabilityRegistry, CapabilitySourceKind};
use crate::{Database, Feature};
use std::collections::HashMap;

pub fn capability_catalog_from_db(db: &Database, version: &str) -> crate::Result<Vec<Capability>> {
    let tools = db.list_agent_tools()?;
    let plugins = db.list_plugins()?;
    let skills = db.list_skills(true, 500)?;
    let snapshot = db.feature_catalog_snapshot()?;
    let owners = plugins
        .iter()
        .map(|plugin| (plugin.id.as_str(), plugin))
        .collect::<HashMap<_, _>>();
    let declarations = plugins
        .iter()
        .flat_map(|plugin| {
            plugin
                .manifest
                .features
                .iter()
                .map(move |feature| ((plugin.id.as_str(), feature.code.as_str()), feature))
        })
        .collect::<HashMap<_, _>>();
    let mut registry = CapabilityRegistry::default();
    for capability in capability_catalog(&tools, &plugins, &skills, version) {
        // Disabled static descriptors remain visible as unavailable, as before.
        // Enabled features are projected from actual indexed ownership below.
        if capability.source.kind != CapabilitySourceKind::PluginFeature
            || owners
                .get(capability.source.id.as_str())
                .is_some_and(|plugin| !plugin.enabled)
        {
            registry.register(capability);
        }
    }
    for entry in snapshot.entries() {
        let plugin = owners
            .get(entry.feature.plugin_id.as_str())
            .ok_or_else(|| {
                crate::AToolsError::Plugin("Feature capability owner unavailable".into())
            })?;
        if let Some(declared) = declarations.get(&(plugin.id.as_str(), entry.feature.code.as_str()))
        {
            registry.register(Capability::from_plugin_feature(plugin, declared, version));
        } else {
            let projected = Feature {
                platform: vec![],
                code: entry.feature.code.clone(),
                label: Some(entry.display_label.clone()),
                explain: entry.feature.explain.clone(),
                icon: entry.feature.icon.clone(),
                main_push: entry.feature.main_push,
                main_hide: false,
                cmds: entry.feature.cmds.clone(),
            };
            registry.register(Capability::from_plugin_feature(plugin, &projected, version));
        }
    }
    Ok(registry.list_all())
}
