//! Exact, compile-time catalog for source-dependency native conversion cases.
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct SourceCase {
    pub(super) case_id: &'static str,
    pub(super) report_profile: &'static str,
    pub(super) source_root: &'static str,
    pub(super) source_manifest_path: &'static str,
    pub(super) source_manifest_sha256: &'static str,
    pub(super) inventory_sha256: &'static str,
    pub(super) upstream_head: &'static str,
    pub(super) file_count: usize,
    pub(super) source_bytes: u64,
    pub(super) plugin_manifest_path: &'static str,
    pub(super) plugin_manifest_sha256: &'static str,
    pub(super) plugin_id: &'static str,
    pub(super) plugin_version: &'static str,
    pub(super) plugin_main: &'static str,
    pub(super) plugin_source_main: &'static str,
    pub(super) plugin_preload: Option<&'static str>,
    pub(super) feature_code: &'static str,
    pub(super) feature_codes: &'static [&'static str],
    /// Legacy source-case runtime classification: preload presence still maps to Node.
    pub(super) runtime: &'static str,
    pub(super) native_ui_consumer_supported: bool,
    /// Explicit source-build manifest choice, absent for the historical default cases.
    pub(super) manifest_selection: Option<&'static str>,
    /// Effective runtime reported by the selected manifest inspector, distinct from `runtime`.
    pub(super) manifest_effective_runtime: Option<&'static str>,
}

pub(super) const CALCULATOR: SourceCase = SourceCase {
    case_id: "fixed-head-my-calculator",
    report_profile: "fixed-head-my-calculator",
    source_root: "/private/tmp/atools-batch107-root/my-calculator-head-v1",
    source_manifest_path: "/private/tmp/atools-batch107-root/my-calculator-head-v1-manifest.json",
    source_manifest_sha256: "c4b3edd891cf114c28f40c7ac870f154a26d16ce230ef379f9144d159e574686",
    inventory_sha256: "19853e0b2a034665daa6f4752f03abda478a5aa83204f6eb3458dfb577896c69",
    upstream_head: "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d",
    file_count: 32,
    source_bytes: 722_589,
    plugin_manifest_path: "public/plugin.json",
    plugin_manifest_sha256: "4d15ef10b4b61b94a32c4edc716166570e644eefd676c9dccd4a23cb077f3900",
    plugin_id: "my-calculator",
    plugin_version: "1.0.1",
    plugin_main: "index.html",
    plugin_source_main: "index.html",
    plugin_preload: Some("preload/services.js"),
    feature_code: "calculator",
    feature_codes: &["calculator"],
    runtime: "node",
    native_ui_consumer_supported: true,
    manifest_selection: None,
    manifest_effective_runtime: None,
};

pub(super) const TETRIS: SourceCase = SourceCase {
    case_id: "fixed-head-tetris",
    report_profile: "fixed-head-tetris",
    source_root: "/private/tmp/atools-batch107-root/tetris-head-v1",
    source_manifest_path: "/private/tmp/atools-batch107-root/tetris-head-v1-manifest.json",
    source_manifest_sha256: "5d5d4e75477f6297a9e1466a444524adae185f754d9df7531afff66d41564c0c",
    inventory_sha256: "275145828f69b4c1284186ef524f95319565d99d7faa7d97bc2f2726c7f21f67",
    upstream_head: "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d",
    file_count: 27,
    source_bytes: 143_167,
    plugin_manifest_path: "plugin.json",
    plugin_manifest_sha256: "8be546e667e45db9a239cf57a4b17b14d6de8ebb0e119441a369e3e5fa8ef94e",
    plugin_id: "tetris",
    plugin_version: "1.0.0",
    plugin_main: "index.html",
    plugin_source_main: "index.html",
    plugin_preload: None,
    feature_code: "tetris",
    feature_codes: &["tetris"],
    runtime: "web",
    native_ui_consumer_supported: false,
    manifest_selection: None,
    manifest_effective_runtime: None,
};

pub(super) const TODO_NEO: SourceCase = SourceCase {
    case_id: "fixed-head-todo-neo",
    report_profile: "fixed-head-todo-neo",
    source_root: "/private/tmp/atools-batch107-root/todo-neo-head-v1",
    source_manifest_path: "/private/tmp/atools-batch107-root/todo-neo-head-v1-manifest.json",
    source_manifest_sha256: "c3551aeccb50d0bf3b6792ad58ebcf541c1eec9f4581e6ecffa5ad510c3e03a2",
    inventory_sha256: "fc89b5b70f23c7ece46348c23a865663ae86a63b8a46a0798354b4867f10574b",
    upstream_head: "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d",
    file_count: 63,
    source_bytes: 1_070_684,
    plugin_manifest_path: "public/plugin.json",
    plugin_manifest_sha256: "24aa54cbeb8afb66e30e348d0cd85642071794b6a6112ceb5f146d20cbb39a6f",
    plugin_id: "todo-neo",
    plugin_version: "0.0.1",
    plugin_main: "index.html",
    plugin_source_main: "../index.html",
    plugin_preload: Some("preload/services.js"),
    feature_code: "todo",
    feature_codes: &["todo", "add"],
    runtime: "node",
    native_ui_consumer_supported: false,
    manifest_selection: None,
    manifest_effective_runtime: None,
};

pub(super) const DEEPREAD: SourceCase = SourceCase {
    case_id: "fixed-head-deepread",
    report_profile: "fixed-head-deepread",
    source_root: "/private/tmp/atools-batch335-deepread-producer/source-fixed-head-v1",
    source_manifest_path:
        "/private/tmp/atools-batch335-deepread-producer/source-fixed-head-v1-manifest.json",
    source_manifest_sha256: "eddc0d6c83a292ca81f8ca386963bdd6d06727a32224cfe93ee3fdd8153b8080",
    inventory_sha256: "1b4f96c212f9c650ff1538b75dbb1cfce04a9c37ac82f101a9c3198803a2cfe1",
    upstream_head: "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d",
    file_count: 24,
    source_bytes: 668_051,
    plugin_manifest_path: "plugin.json",
    plugin_manifest_sha256: "e353f6a4cc89dcccdaf1b4c36929320039a1b9cf981bda9ae7892e3a36de521a",
    plugin_id: "deepread",
    plugin_version: "1.1.3",
    plugin_main: "dist/index.html",
    plugin_source_main: "dist/index.html",
    plugin_preload: Some("dist/preload/services.js"),
    feature_code: "deepread",
    feature_codes: &["deepread"],
    runtime: "node",
    native_ui_consumer_supported: false,
    manifest_selection: None,
    manifest_effective_runtime: None,
};

/// The public manifest is a distinct, explicitly selected identity over the same fixed source tree.
/// Its preload remains Node-classified for the legacy case summary; the manifest inspector's
/// effective runtime is Web because `runtime.kind` is absent.
pub(super) fn case_by_id(value: &str) -> Result<SourceCase, &'static str> {
    match value {
        "fixed-head-my-calculator" => Ok(CALCULATOR),
        "fixed-head-tetris" => Ok(TETRIS),
        "fixed-head-todo-neo" => Ok(TODO_NEO),
        "fixed-head-deepread" => Ok(DEEPREAD),
        "fixed-head-deepread-public" => Ok(super::manifest_selection::DEEPREAD_PUBLIC),
        _ => Err("SOURCE_CASE_UNKNOWN"),
    }
}

pub(super) fn case_from_args(args: &[String]) -> Result<SourceCase, &'static str> {
    if args.iter().any(|value| value.starts_with("--source-case=")) {
        return Err("SOURCE_CASE_INVALID");
    }
    let positions = args
        .iter()
        .enumerate()
        .filter_map(|(index, value)| (value == "--source-case").then_some(index))
        .collect::<Vec<_>>();
    if positions.len() > 1 {
        return Err("SOURCE_CASE_DUPLICATE");
    }
    let Some(index) = positions.first().copied() else {
        return Ok(CALCULATOR);
    };
    let id = args
        .get(index + 1)
        .filter(|value| !value.starts_with("--"))
        .map(String::as_str)
        .ok_or("SOURCE_CASE_MISSING")?;
    case_by_id(id)
}

pub(super) fn validate_inventory_metadata(
    case: SourceCase,
    root: &str,
    manifest: &Value,
) -> Result<(), &'static str> {
    if root != case.source_root
        || manifest.get("fixtureRoot").and_then(Value::as_str) != Some(case.source_root)
        || manifest.get("upstreamHead").and_then(Value::as_str) != Some(case.upstream_head)
        || manifest
            .get("sourceInventorySha256")
            .and_then(Value::as_str)
            != Some(case.inventory_sha256)
        || manifest.get("files").and_then(Value::as_u64) != Some(case.file_count as u64)
        || manifest.get("bytes").and_then(Value::as_u64) != Some(case.source_bytes)
        || manifest
            .get("sources")
            .and_then(Value::as_object)
            .map_or(true, |files| files.len() != case.file_count)
    {
        return Err("SOURCE_CASE_INVENTORY_MISMATCH");
    }
    Ok(())
}

pub(super) fn validate_plugin_manifest(case: SourceCase, bytes: &[u8]) -> Result<(), &'static str> {
    if digest(bytes) != case.plugin_manifest_sha256 {
        return Err("SOURCE_CASE_PLUGIN_MANIFEST_SHA_MISMATCH");
    }
    let manifest: Value =
        serde_json::from_slice(bytes).map_err(|_| "SOURCE_CASE_PLUGIN_MANIFEST_INVALID")?;
    validate_source_plugin_manifest_value(case, &manifest)
}

pub(super) fn validate_plugin_manifest_value(
    case: SourceCase,
    manifest: &Value,
) -> Result<(), &'static str> {
    validate_manifest_identity(case, manifest, case.plugin_main)
}

fn validate_source_plugin_manifest_value(
    case: SourceCase,
    manifest: &Value,
) -> Result<(), &'static str> {
    validate_manifest_identity(case, manifest, case.plugin_source_main)
}

fn validate_manifest_identity(
    case: SourceCase,
    manifest: &Value,
    expected_main: &str,
) -> Result<(), &'static str> {
    let features = manifest.get("features").and_then(Value::as_array);
    let preload_matches = match case.plugin_preload {
        Some(expected) => manifest.get("preload").and_then(Value::as_str) == Some(expected),
        None => manifest.get("preload").map_or(true, Value::is_null),
    };
    let expected_runtime = if case.plugin_preload.is_some() {
        "node"
    } else {
        "web"
    };
    if case.runtime != expected_runtime
        || manifest.get("name").and_then(Value::as_str) != Some(case.plugin_id)
        || manifest.get("version").and_then(Value::as_str) != Some(case.plugin_version)
        || manifest.get("main").and_then(Value::as_str) != Some(expected_main)
        || !preload_matches
        || features.map_or(true, |items| {
            items.len() != case.feature_codes.len()
                || items
                    .iter()
                    .zip(case.feature_codes)
                    .any(|(item, expected)| {
                        item.get("code").and_then(Value::as_str) != Some(*expected)
                    })
        })
    {
        return Err("SOURCE_CASE_PLUGIN_MANIFEST_IDENTITY_MISMATCH");
    }
    Ok(())
}

pub(super) fn installed_identity_matches(
    case: SourceCase,
    id: &str,
    version: &str,
    manifest_name: &str,
    manifest_version: &str,
    actual_path: &str,
    expected_path: &str,
) -> bool {
    id == case.plugin_id
        && version == case.plugin_version
        && manifest_name == case.plugin_id
        && manifest_version == case.plugin_version
        && actual_path == expected_path
}

fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tetris_manifest() -> Value {
        json!({"name":"tetris","version":"1.0.0","main":"index.html",
            "features":[{"code":"tetris","explain":"俄罗斯方块游戏"}]})
    }
    fn calculator_manifest() -> Value {
        json!({"name":"my-calculator","version":"1.0.1","main":"index.html",
            "preload":"preload/services.js","features":[{"code":"calculator"}]})
    }
    fn todo_neo_source_manifest() -> Value {
        json!({"name":"todo-neo","version":"0.0.1","main":"../index.html",
            "preload":"preload/services.js","features":[{"code":"todo"},{"code":"add"}]})
    }
    fn todo_neo_output_manifest() -> Value {
        json!({"name":"todo-neo","version":"0.0.1","main":"index.html",
            "preload":"preload/services.js","features":[{"code":"todo"},{"code":"add"}]})
    }
    fn deepread_selected_manifest() -> Value {
        json!({"name":"deepread","version":"1.1.3","main":"dist/index.html",
            "preload":"dist/preload/services.js","features":[{"code":"deepread"}]})
    }
    fn deepread_public_manifest() -> Value {
        json!({"name":"deepread","version":"1.1.2","main":"index.html",
        "preload":"preload/services.js","features":[
            {"code":"deepread"},{"code":"deepread-import"},{"code":"deepread-search-books"},
            {"code":"deepread-prev-page"},{"code":"deepread-next-page"},{"code":"deepread-toggle-show"},
            {"code":"deepread-close"},{"code":"deepread-toggle-auto"},{"code":"deepread-toggle-stealth"}
        ]})
    }
    fn inventory(case: SourceCase) -> Value {
        let mut sources = serde_json::Map::new();
        for index in 0..case.file_count {
            sources.insert(format!("file-{index}"), json!({}));
        }
        json!({"fixtureRoot":case.source_root,"upstreamHead":case.upstream_head,
            "sourceInventorySha256":case.inventory_sha256,"files":case.file_count,
            "bytes":case.source_bytes,"sources":sources})
    }

    #[test]
    fn omitted_case_preserves_calculator_and_explicit_case_selects_tetris() {
        assert_eq!(case_from_args(&["smoke".into()]).unwrap(), CALCULATOR);
        assert_eq!(
            case_from_args(&[
                "smoke".into(),
                "--source-case".into(),
                "fixed-head-tetris".into()
            ])
            .unwrap(),
            TETRIS
        );
        assert_eq!(
            case_from_args(&[
                "smoke".into(),
                "--source-case".into(),
                "fixed-head-todo-neo".into()
            ])
            .unwrap(),
            TODO_NEO
        );
        assert_eq!(
            case_from_args(&[
                "smoke".into(),
                "--source-case".into(),
                "fixed-head-deepread".into()
            ])
            .unwrap(),
            DEEPREAD
        );
    }

    #[test]
    fn duplicate_unknown_and_missing_case_are_rejected() {
        for args in [
            vec![
                "smoke".into(),
                "--source-case".into(),
                "fixed-head-tetris".into(),
                "--source-case".into(),
                "fixed-head-my-calculator".into(),
            ],
            vec![
                "smoke".into(),
                "--source-case".into(),
                "fixed-head-unknown".into(),
            ],
            vec!["smoke".into(), "--source-case".into()],
            vec![
                "smoke".into(),
                "--source-case".into(),
                "--fixture-root".into(),
            ],
        ] {
            assert!(case_from_args(&args).is_err());
        }
        assert_eq!(case_by_id("").unwrap_err(), "SOURCE_CASE_UNKNOWN");
        assert_eq!(
            case_from_args(&["smoke".into(), "--source-case=fixed-head-tetris".into()])
                .unwrap_err(),
            "SOURCE_CASE_INVALID"
        );
    }

    #[test]
    fn catalog_accepts_only_each_case_inventory_identity() {
        let calc = inventory(CALCULATOR);
        let tetris = inventory(TETRIS);
        let todo = inventory(TODO_NEO);
        let deepread = inventory(DEEPREAD);
        assert!(validate_inventory_metadata(CALCULATOR, CALCULATOR.source_root, &calc).is_ok());
        assert!(validate_inventory_metadata(TETRIS, TETRIS.source_root, &tetris).is_ok());
        assert!(validate_inventory_metadata(TODO_NEO, TODO_NEO.source_root, &todo).is_ok());
        assert!(validate_inventory_metadata(DEEPREAD, DEEPREAD.source_root, &deepread).is_ok());
        assert!(validate_inventory_metadata(TETRIS, TETRIS.source_root, &calc).is_err());
        assert!(validate_inventory_metadata(CALCULATOR, CALCULATOR.source_root, &tetris).is_err());
        assert!(validate_inventory_metadata(TODO_NEO, TODO_NEO.source_root, &tetris).is_err());
        assert!(validate_inventory_metadata(TODO_NEO, TETRIS.source_root, &todo).is_err());
        assert!(validate_inventory_metadata(DEEPREAD, TODO_NEO.source_root, &deepread).is_err());
        assert!(validate_inventory_metadata(DEEPREAD, DEEPREAD.source_root, &tetris).is_err());
    }

    #[test]
    fn source_manifest_and_installed_identity_cannot_cross_cases() {
        let calc = calculator_manifest();
        let tetris = tetris_manifest();
        assert!(validate_plugin_manifest_value(CALCULATOR, &calc).is_ok());
        assert!(validate_plugin_manifest_value(TETRIS, &tetris).is_ok());
        assert!(
            validate_source_plugin_manifest_value(TODO_NEO, &todo_neo_source_manifest()).is_ok()
        );
        assert!(validate_plugin_manifest_value(TODO_NEO, &todo_neo_output_manifest()).is_ok());
        assert!(validate_source_plugin_manifest_value(CALCULATOR, &calc).is_ok());
        assert!(validate_source_plugin_manifest_value(TETRIS, &tetris).is_ok());
        assert!(validate_plugin_manifest_value(CALCULATOR, &tetris).is_err());
        assert!(validate_plugin_manifest_value(TETRIS, &calc).is_err());
        assert!(
            validate_source_plugin_manifest_value(TODO_NEO, &todo_neo_output_manifest()).is_err()
        );
        assert!(validate_plugin_manifest_value(TODO_NEO, &todo_neo_source_manifest()).is_err());
        assert!(validate_source_plugin_manifest_value(TODO_NEO, &tetris).is_err());
        assert!(validate_plugin_manifest_value(TODO_NEO, &calc).is_err());
        assert!(installed_identity_matches(
            TETRIS,
            "tetris",
            "1.0.0",
            "tetris",
            "1.0.0",
            "/root/plugins/tetris",
            "/root/plugins/tetris"
        ));
        assert!(!installed_identity_matches(
            TETRIS,
            "my-calculator",
            "1.0.1",
            "my-calculator",
            "1.0.1",
            "/root/plugins/my-calculator",
            "/root/plugins/tetris"
        ));
        assert!(!installed_identity_matches(
            CALCULATOR,
            "tetris",
            "1.0.0",
            "tetris",
            "1.0.0",
            "/root/plugins/tetris",
            "/root/plugins/my-calculator"
        ));
    }

    #[test]
    fn deepread_selects_root_identity_and_keeps_public_manifest_conflict_visible() {
        assert_eq!(
            DEEPREAD.upstream_head,
            "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d"
        );
        assert_eq!(DEEPREAD.file_count, 24);
        assert_eq!(DEEPREAD.source_bytes, 668_051);
        assert_eq!(DEEPREAD.plugin_manifest_path, "plugin.json");
        assert!(
            validate_source_plugin_manifest_value(DEEPREAD, &deepread_selected_manifest()).is_ok()
        );
        assert!(validate_plugin_manifest_value(DEEPREAD, &deepread_selected_manifest()).is_ok());
        // Production chooses root plugin.json before public/plugin.json. Preserve its
        // version/main/preload disagreement rather than rewriting either source manifest.
        let mut public = deepread_public_manifest();
        assert_eq!(public["features"].as_array().map(Vec::len), Some(9));
        assert!(validate_plugin_manifest_value(DEEPREAD, &public).is_err());
        // Isolate the feature-set mismatch after matching the other root identity fields.
        public["version"] = json!("1.1.3");
        public["main"] = json!("dist/index.html");
        public["preload"] = json!("dist/preload/services.js");
        assert!(validate_plugin_manifest_value(DEEPREAD, &public).is_err());
    }

    #[test]
    fn manifest_rejects_extra_feature_and_runtime_identity_drift() {
        let mut manifest = tetris_manifest();
        manifest["preload"] = json!("preload.js");
        assert!(validate_plugin_manifest_value(TETRIS, &manifest).is_err());
        manifest = tetris_manifest();
        manifest["features"]
            .as_array_mut()
            .unwrap()
            .push(json!({"code":"other"}));
        assert!(validate_plugin_manifest_value(TETRIS, &manifest).is_err());
        manifest = tetris_manifest();
        manifest["version"] = json!("1.0.1");
        assert!(validate_plugin_manifest_value(TETRIS, &manifest).is_err());
        let mut wrong_runtime = TETRIS;
        wrong_runtime.runtime = "node";
        assert!(validate_plugin_manifest_value(wrong_runtime, &tetris_manifest()).is_err());
    }

    #[test]
    fn todo_neo_requires_exact_parent_main_preload_and_ordered_feature_identity() {
        let mut source = todo_neo_source_manifest();
        assert!(validate_source_plugin_manifest_value(TODO_NEO, &source).is_ok());
        source["main"] = json!("index.html");
        assert!(validate_source_plugin_manifest_value(TODO_NEO, &source).is_err());

        let mut output = todo_neo_output_manifest();
        assert!(validate_plugin_manifest_value(TODO_NEO, &output).is_ok());
        output["main"] = json!("../index.html");
        assert!(validate_plugin_manifest_value(TODO_NEO, &output).is_err());
        output = todo_neo_output_manifest();
        output["preload"] = json!("../preload/services.js");
        assert!(validate_plugin_manifest_value(TODO_NEO, &output).is_err());
        output = todo_neo_output_manifest();
        output["features"][1]["code"] = json!("unexpected");
        assert!(validate_plugin_manifest_value(TODO_NEO, &output).is_err());
        output = todo_neo_output_manifest();
        output["features"].as_array_mut().unwrap().pop();
        assert!(validate_plugin_manifest_value(TODO_NEO, &output).is_err());
        output = todo_neo_output_manifest();
        output["features"]
            .as_array_mut()
            .unwrap()
            .push(json!({"code":"unexpected"}));
        assert!(validate_plugin_manifest_value(TODO_NEO, &output).is_err());
        output = todo_neo_output_manifest();
        output["features"].as_array_mut().unwrap().reverse();
        assert!(validate_plugin_manifest_value(TODO_NEO, &output).is_err());
    }
}
