//! User-facing names remain independent from plugin IDs and package names.
use crate::{Cmd, FeatureEntry, Plugin};

impl Plugin {
    pub fn display_name(&self) -> &str {
        self.manifest
            .title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or(&self.name)
    }

    /// Returns a user-facing feature label and its stable description source.
    ///
    /// The persisted feature label is intentionally ignored: database rows may
    /// contain the feature code as a fallback when a manifest has no label.
    pub fn feature_label<'a>(
        &'a self,
        code: &str,
        entry: &'a FeatureEntry,
    ) -> Option<(&'a str, &'static str)> {
        let declared = self
            .manifest
            .features
            .iter()
            .find(|feature| feature.code == code)
            .and_then(|feature| non_empty(feature.label.as_deref()));
        readable_feature_label(declared, &entry.explain, &entry.cmds)
    }
}

pub(crate) fn readable_feature_label<'a>(
    declared: Option<&'a str>,
    explain: &'a str,
    cmds: &'a [Cmd],
) -> Option<(&'a str, &'static str)> {
    non_empty(declared)
        .map(|label| (label, "declared"))
        .or_else(|| non_empty(Some(explain)).map(|label| (label, "explain")))
        .or_else(|| {
            cmds.iter().find_map(|cmd| match cmd {
                Cmd::Typed(command) => {
                    non_empty(command.label.as_deref()).map(|label| (label, "command_label"))
                }
                Cmd::Text(_) => None,
            })
        })
        .or_else(|| {
            cmds.iter().find_map(|cmd| match cmd {
                Cmd::Text(command) => non_empty(Some(command)).map(|label| (label, "command")),
                Cmd::Typed(_) => None,
            })
        })
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_plugin(features: serde_json::Value) -> Plugin {
        let manifest =
            serde_json::from_value(json!({"name":"fixture","features":features})).unwrap();
        Plugin {
            id: "plugin-id".into(),
            name: "fixture".into(),
            manifest,
            version: "1".into(),
            path: "/fixture".into(),
            enabled: true,
            created_at: "now".into(),
            updated_at: "now".into(),
        }
    }

    fn make_entry(label: &str, explain: &str, cmds: Vec<Cmd>) -> FeatureEntry {
        FeatureEntry {
            code: "feature-code".into(),
            plugin_id: "plugin-id".into(),
            plugin_name: "fixture".into(),
            label: label.into(),
            icon: None,
            explain: explain.into(),
            cmds,
            main_push: false,
            priority: 0,
        }
    }

    fn typed(label: Option<&str>) -> Cmd {
        Cmd::Typed(crate::CmdTyped {
            type_: crate::CmdType::Regex,
            label: label.map(str::to_string),
            match_: Some(".*".into()),
            length: None,
            max_length: None,
            file_type: None,
            extensions: None,
            exclude: None,
        })
    }

    #[test]
    fn titles_round_trip_without_changing_plugin_identity_or_old_manifest_defaults() {
        for title in [None, Some(""), Some("  "), Some(" 字符转换 ")] {
            let manifest =
                serde_json::from_value(json!({"name":"char-transform","title":title})).unwrap();
            let plugin = Plugin {
                id: "stable-plugin-id".into(),
                name: "char-transform".into(),
                manifest,
                version: "1".into(),
                path: "/fixture".into(),
                enabled: true,
                created_at: "now".into(),
                updated_at: "now".into(),
            };
            let restored: Plugin =
                serde_json::from_value(serde_json::to_value(&plugin).unwrap()).unwrap();
            assert_eq!(
                restored.display_name(),
                if title == Some(" 字符转换 ") {
                    "字符转换"
                } else {
                    "char-transform"
                }
            );
            assert_eq!(restored.id, "stable-plugin-id");
            assert_eq!(restored.manifest.name, "char-transform");
            assert_eq!(restored.name, "char-transform");
        }
        let old: crate::PluginManifest = serde_json::from_value(json!({"name":"old"})).unwrap();
        assert!(old.title.is_none());
    }

    #[test]
    fn feature_label_prefers_manifest_then_explain_then_typed_then_text() {
        let plugin = make_plugin(json!([{"code":"feature-code","label":"  明示名称  "}]));
        let entry = make_entry(
            "feature-code",
            "说明",
            vec![typed(Some("类型命令")), Cmd::Text("文本命令".into())],
        );
        assert_eq!(
            plugin.feature_label("feature-code", &entry),
            Some(("明示名称", "declared"))
        );

        let plugin = make_plugin(json!([{"code":"feature-code","label":"  "}]));
        assert_eq!(
            plugin.feature_label("feature-code", &entry),
            Some(("说明", "explain"))
        );

        let entry = make_entry(
            "feature-code",
            " ",
            vec![typed(Some(" 类型命令 ")), Cmd::Text("文本命令".into())],
        );
        assert_eq!(
            plugin.feature_label("feature-code", &entry),
            Some(("类型命令", "command_label"))
        );

        let entry = make_entry(
            "feature-code",
            "",
            vec![typed(Some(" ")), Cmd::Text(" 文本命令 ".into())],
        );
        assert_eq!(
            plugin.feature_label("feature-code", &entry),
            Some(("文本命令", "command"))
        );
    }

    #[test]
    fn feature_label_does_not_leak_database_code_or_cross_match_manifest_features() {
        let plugin = make_plugin(json!([
            {"code":"other-feature","label":"别的功能"},
            {"code":"feature-code","label":" "}
        ]));
        let entry = make_entry(
            "feature-code",
            "  ",
            vec![Cmd::Text("  ".into()), typed(Some(" "))],
        );
        assert_eq!(plugin.feature_label("feature-code", &entry), None);
        assert_eq!(plugin.feature_label("missing-code", &entry), None);

        let plugin = make_plugin(json!([
            {"code":"feature-code","label":"当前功能"},
            {"code":"other-feature","label":"另一个功能"}
        ]));
        assert_eq!(
            plugin.feature_label("feature-code", &entry),
            Some(("当前功能", "declared"))
        );
        assert_eq!(
            plugin.feature_label("other-feature", &entry),
            Some(("另一个功能", "declared"))
        );
    }
}
