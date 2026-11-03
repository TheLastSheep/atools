use super::*;
use crate::models::{Cmd, Document, Feature, Plugin, PluginManifest};
use std::collections::HashMap;

fn create_test_plugin(id: &str, name: &str) -> Plugin {
    let manifest = PluginManifest {
        platform: vec![],
        name: name.to_string(),
        title: None,
        version: "1.0.0".to_string(),
        main: Some("index.js".to_string()),
        logo: Some("logo.png".to_string()),
        preload: None,
        description: Some("Test plugin".to_string()),
        author: None,
        homepage: None,
        plugin_setting: None,
        features: vec![],
        development: None,
        tools: HashMap::new(),
        providers: HashMap::new(),
        permissions: vec![],
        runtime: None,
    };

    Plugin {
        id: id.to_string(),
        name: name.to_string(),
        version: "1.0.0".to_string(),
        path: format!("/tmp/{}", id),
        created_at: crate::utils::now_iso(),
        updated_at: crate::utils::now_iso(),
        enabled: true,
        manifest,
    }
}

fn create_test_feature(code: &str) -> Feature {
    Feature {
        platform: vec![],
        code: code.to_string(),
        label: None,
        explain: format!("Feature {}", code),
        icon: None,
        main_push: true,
        main_hide: false,
        cmds: vec![Cmd::Text(code.to_string())],
    }
}

mod clipboard_and_attachments;
mod plugin_clipboard_history;
mod plugin_data;
mod plugin_features;
mod plugin_metadata_refresh;
mod settings_audit;
