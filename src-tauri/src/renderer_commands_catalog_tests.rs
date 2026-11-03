use super::*;
use serde_json::json;

fn source(plugins: Vec<Value>, local_shortcuts: Option<Value>) -> RendererCommandCatalogSnapshot {
    RendererCommandCatalogSnapshot {
        plugins,
        local_shortcuts,
    }
}

fn plugin(features: Value, enabled: bool) -> Value {
    json!({
        "id":"opaque-db-id",
        "name":"canonical-plugin",
        "title":"Display Plugin Title",
        "path":"/plugins/canonical-plugin",
        "logo":"plugin-logo.png",
        "enabled":enabled,
        "features":features
    })
}

fn app(name: &str, path: &str, icon: &str) -> Value {
    json!({"name":name,"path":path,"icon":icon})
}

#[test]
fn projects_full_app_local_static_and_dynamic_metadata_without_alias_expansion() {
    let plugin = plugin(
        json!([
            {
                "code":"static-code",
                "explain":"static explanation",
                "icon":"feature-icon.png",
                "aliases":["must-not-expand"],
                "cmds":[
                    "static command",
                    {"type":"regex","label":"regex label","regex":"/hello/i","flags":"i"}
                ]
            },
            {
                "code":"dynamic-code",
                "explain":"dynamic explanation",
                "cmds":["dynamic command"]
            }
        ]),
        false,
    );
    let bytes = build_snapshot(
        &[app(
            "Sample.app",
            "/Applications/Sample.app",
            "opaque-icon.png",
        )],
        source(
            vec![plugin],
            Some(json!([{
                "name":"Folder",
                "alias":"Work folder",
                "path":"/Users/example/Work",
                "icon":"shortcut-icon.png"
            }])),
        ),
    )
    .unwrap();
    let catalog: Value = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(catalog["commands"].as_array().unwrap().len(), 4);
    assert_eq!(catalog["commands"][0]["type"], "direct");
    assert_eq!(catalog["commands"][0]["subType"], "app");
    assert_eq!(catalog["commands"][0]["icon"], "opaque-icon.png");
    assert_eq!(catalog["commands"][1]["subType"], "local-shortcut");
    assert_eq!(catalog["commands"][1]["name"], "Work folder");
    assert_eq!(catalog["commands"][2]["pluginName"], "canonical-plugin");
    assert_eq!(
        catalog["commands"][2]["pluginTitle"],
        "Display Plugin Title"
    );
    assert_eq!(catalog["commands"][2]["featureCode"], "static-code");
    assert_eq!(catalog["commands"][2]["cmdType"], "text");
    assert_eq!(catalog["commands"][2]["icon"], "feature-icon.png");
    assert_eq!(catalog["commands"][3]["featureCode"], "dynamic-code");
    assert_eq!(catalog["commands"][3]["cmdType"], "text");
    assert_eq!(catalog["regexCommands"].as_array().unwrap().len(), 1);
    assert_eq!(catalog["regexCommands"][0]["name"], "regex label");
    assert_eq!(catalog["regexCommands"][0]["matchCmd"]["match"], "/hello/i");
    assert_eq!(catalog["regexCommands"][0]["matchCmd"]["flags"], "i");
    assert_eq!(catalog["plugins"][0]["enabled"], false);
    assert_eq!(catalog["plugins"][0]["features"][1]["code"], "dynamic-code");
    assert!(!catalog["commands"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["name"] == "must-not-expand"));
    assert!(!catalog["commands"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["subType"] == "system-setting"));
}

#[test]
fn preserves_missing_app_icons_and_does_not_invent_system_entries() {
    let bytes = build_snapshot(
        &[json!({"name":"No icon.app","path":"/Applications/No icon.app","icon":null})],
        source(Vec::new(), None),
    )
    .unwrap();
    let catalog: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(catalog["commands"].as_array().unwrap().len(), 1);
    assert_eq!(catalog["commands"][0]["subType"], "app");
    assert!(catalog["commands"][0]["icon"].is_null());
    assert!(catalog["regexCommands"].as_array().unwrap().is_empty());
    assert!(catalog["plugins"].as_array().unwrap().is_empty());
}

#[test]
fn rejects_command_and_output_limits_instead_of_returning_a_truncated_catalog() {
    let commands = (0..MAX_COMMAND_ROWS)
        .map(|index| json!(format!("command-{index}")))
        .collect::<Vec<_>>();
    let over_limit = plugin(
        json!([{"code":"many","explain":"many","cmds":commands}]),
        true,
    );
    let error = build_snapshot(
        &[app("One.app", "/One.app", "opaque")],
        source(vec![over_limit], None),
    )
    .unwrap_err();
    assert!(error.contains("16,384"));

    let padding = "x".repeat(500_000);
    let large = (0..18)
        .map(|index| {
            let mut record = plugin(json!([]), true);
            record["id"] = json!(format!("plugin-{index}"));
            record["padding"] = json!(padding);
            record
        })
        .collect::<Vec<_>>();
    let error = build_snapshot(&[], source(large, None)).unwrap_err();
    assert!(error.contains("8 MiB"));
}

#[test]
fn rejects_plugin_count_overflow_without_truncating() {
    let plugins = (0..=RENDERER_COMMAND_CATALOG_MAX_PLUGINS)
        .map(|index| {
            let mut record = plugin(json!([]), true);
            record["name"] = json!(format!("plugin-{index}"));
            record
        })
        .collect::<Vec<_>>();
    assert!(build_snapshot(&[], source(plugins, None))
        .unwrap_err()
        .contains("plugin limit"));
}
