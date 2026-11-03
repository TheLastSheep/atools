//! Search-scale metadata only. These records have no executable entry or preload.
use atools_core::{Cmd, Database, Feature, Plugin};
use serde::Serialize;
use std::path::Path;

const FEATURES_PER_GROUP: usize = 600;
const GROUPS: [(&str, &str, &str); 2] = [
    ("native-panel-synthetic-a", "原生目录样本甲组", "甲组"),
    ("native-panel-synthetic-b", "原生目录样本乙组", "乙组"),
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CatalogDataset {
    pub kind: &'static str,
    pub synthetic_plugins: usize,
    pub synthetic_features: usize,
    pub original_plugins: usize,
    pub original_features: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_plugins: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_features: Option<usize>,
    pub total_features: usize,
    pub groups: Vec<CatalogGroup>,
    pub scope: &'static str,
}

impl CatalogDataset {
    pub(super) fn with_generated_packages(mut self) -> Self {
        self.kind = "synthetic-search-metadata-plus-generated-packages";
        self.generated_plugins = Some(self.original_plugins);
        self.generated_features = Some(self.original_features);
        self.original_plugins = 0;
        self.original_features = 0;
        self.scope = "1200 synthetic search metadata features plus generated no-preload package features; no complete original plugin package is executed or accepted.";
        self
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CatalogGroup {
    pub plugin_id: &'static str,
    pub query: &'static str,
    pub feature_count: usize,
    pub original_query_matches: usize,
    pub expected_query_results: usize,
}

pub(super) fn install(
    db: &Database,
    scratch: &Path,
    originals: &[String],
) -> Result<CatalogDataset, String> {
    let original_entries = db
        .all_features()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|feature| originals.contains(&feature.plugin_id))
        .collect::<Vec<_>>();
    let original_features = original_entries.len();
    for (id, title, group) in GROUPS {
        let features = (0..FEATURES_PER_GROUP)
            .map(|index| Feature {
                platform: vec![],
                code: format!("{id}-{index:04}"),
                label: Some(format!("{group}元数据功能 {index:04}")),
                explain: "仅用于搜索与渲染性能测量，没有可执行插件入口".into(),
                icon: None,
                main_push: false,
                main_hide: false,
                cmds: vec![Cmd::Text(format!("{group}安全搜索样本{index:04}"))],
            })
            .collect::<Vec<_>>();
        let manifest = serde_json::from_value(serde_json::json!({"name":id,"title":title,"version":"fixture-only","features":features}))
            .map_err(|error| error.to_string())?;
        let plugin = Plugin {
            id: id.into(),
            name: id.into(),
            version: "fixture-only".into(),
            path: scratch
                .join("metadata-only-no-entry")
                .join(id)
                .to_string_lossy()
                .to_string(),
            enabled: true,
            manifest,
            created_at: "isolated-fixture".into(),
            updated_at: "isolated-fixture".into(),
        };
        db.save_plugin_with_features(&plugin, &features)
            .map_err(|error| error.to_string())?;
    }
    let synthetic_features = FEATURES_PER_GROUP * GROUPS.len();
    Ok(CatalogDataset { kind:"synthetic-search-metadata-plus-original-plugin-business", synthetic_plugins:GROUPS.len(),
        synthetic_features, original_plugins:originals.len(), original_features,
        generated_plugins:None, generated_features:None,
        // Count metadata without prewarming the production search index before App mount.
        total_features:db.all_features().map_err(|error| error.to_string())?.len(),
        groups:GROUPS.iter().map(|(plugin_id,query,_)| {
            let original_query_matches=atools_core::matcher::search_all_checked(&original_entries,query).map_err(|error|error.to_string())?.len();
            Ok(CatalogGroup { plugin_id,query,feature_count:FEATURES_PER_GROUP,original_query_matches,
                expected_query_results:FEATURES_PER_GROUP+original_query_matches })
        }).collect::<Result<Vec<_>,String>>()?,
        scope:"1200 synthetic metadata features for search/render scale; each query retains legitimate original typed matches in addition to its 600 synthetic features. Only two original plugins are activated for business assertions, not 1200-plugin compatibility." })
}

pub(super) fn is_synthetic_code(code: &str) -> bool {
    GROUPS
        .iter()
        .any(|(id, _, _)| code.starts_with(&format!("{id}-")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_fixture_supplies_two_disjoint_600_result_groups_without_executable_entries() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::in_memory().unwrap();
        let dataset = install(
            &db,
            directory.path(),
            &["char-transform".into(), "file-tree".into()],
        )
        .unwrap();
        assert_eq!(dataset.synthetic_features, 1200);
        assert_eq!(dataset.total_features, 1200);
        let snapshot = db.feature_catalog_snapshot().unwrap();
        for group in &dataset.groups {
            let matches = snapshot.search_checked(group.query).unwrap();
            assert_eq!(matches.len(), 600);
            assert_eq!(group.expected_query_results, 600);
            assert_eq!(group.original_query_matches, 0);
            assert!(matches
                .iter()
                .all(|item| item.plugin_id == group.plugin_id
                    && is_synthetic_code(&item.feature_code)));
            let plugin = db.get_plugin(group.plugin_id).unwrap();
            assert!(plugin.enabled);
            assert!(
                plugin.manifest.main.is_none()
                    && plugin.manifest.preload.is_none()
                    && plugin.manifest.runtime.is_none()
            );
            assert!(plugin.manifest.tools.is_empty() && plugin.manifest.permissions.is_empty());
            assert!(!Path::new(&plugin.path).exists());
        }
        assert!(db.list_task_runs(10).unwrap().is_empty());
        assert!(std::fs::read_dir(directory.path())
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn original_over_matches_are_preserved_in_exact_expected_query_counts() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::in_memory().unwrap();
        for (id, cmds) in [
            (
                "original-over",
                serde_json::json!([{"type":"over","minLength":1,"maxLength":10000}]),
            ),
            (
                "original-exact",
                serde_json::json!(["unrelated exact command"]),
            ),
        ] {
            let manifest=serde_json::from_value(serde_json::json!({"name":id,"title":"原版业务工具","features":[{"code":id,"cmds":cmds}]})).unwrap();
            let plugin = Plugin {
                id: id.into(),
                name: id.into(),
                version: "fixture".into(),
                path: "/not-executed".into(),
                enabled: true,
                manifest,
                created_at: "fixture".into(),
                updated_at: "fixture".into(),
            };
            db.save_plugin_with_features(&plugin, &plugin.manifest.features)
                .unwrap();
        }
        let dataset = install(
            &db,
            directory.path(),
            &["original-over".into(), "original-exact".into()],
        )
        .unwrap();
        assert_eq!(dataset.original_features, 2);
        assert_eq!(dataset.total_features, 1202);
        let snapshot = db.feature_catalog_snapshot().unwrap();
        for group in &dataset.groups {
            assert_eq!(group.feature_count, 600);
            assert_eq!(group.original_query_matches, 1);
            assert_eq!(group.expected_query_results, 601);
            let matches = snapshot.search_checked(group.query).unwrap();
            assert_eq!(matches.len(), 601);
            assert!(matches[..600]
                .iter()
                .all(|item| item.plugin_id == group.plugin_id));
            assert_eq!(matches[600].plugin_id, "original-over");
            assert_eq!(matches[600].match_type, "over");
        }
        assert!(db.list_task_runs(10).unwrap().is_empty());
    }
}
