//! Registered native fixture identity; no runtime or filesystem authority.
use serde_json::{json, Value};
#[path = "published_fixture_image_stitch_profile.rs"]
mod image_stitch;
#[path = "published_fixture_random_data_profile.rs"]
mod random_data;

pub(super) fn reviewed_profile(case_id: &str, manifest: &Value) -> Result<Value, String> {
    if case_id == random_data::CASE_ID {
        return random_data::reviewed_profile(manifest);
    }
    if case_id == image_stitch::CASE_ID {
        return image_stitch::reviewed_profile(manifest);
    }
    let registry: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/published-plugin-cases.json"
    ))
    .map_err(|e| e.to_string())?;
    let local_registry: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/local-original-plugin-cases.json"
    ))
    .map_err(|e| e.to_string())?;
    let archive_registry: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/local-original-archive-cases.json"
    ))
    .map_err(|error| error.to_string())?;
    let input_registry: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/local-original-input-cases.json"
    ))
    .map_err(|error| error.to_string())?;
    let plain_registry: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/local-plain-text-cases.json"
    ))
    .map_err(|error| error.to_string())?;
    let subnet_registry: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/local-subnet-calculator-cases.json"
    ))
    .map_err(|error| error.to_string())?;
    let mybatis_registry: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/local-original-mybatis-cases.json"
    ))
    .map_err(|error| error.to_string())?;
    let profile = registry["cases"]
        .as_array()
        .and_then(|cases| cases.iter().find(|profile| profile["caseId"] == case_id))
        .or_else(|| {
            local_registry["cases"]
                .as_array()
                .and_then(|cases| cases.iter().find(|profile| profile["caseId"] == case_id))
        })
        .or_else(|| {
            archive_registry["cases"]
                .as_array()
                .and_then(|cases| cases.iter().find(|profile| profile["caseId"] == case_id))
        })
        .or_else(|| {
            input_registry["cases"]
                .as_array()
                .and_then(|cases| cases.iter().find(|profile| profile["caseId"] == case_id))
        })
        .or_else(|| {
            plain_registry["cases"]
                .as_array()
                .and_then(|cases| cases.iter().find(|profile| profile["caseId"] == case_id))
        })
        .or_else(|| {
            subnet_registry["cases"]
                .as_array()
                .and_then(|cases| cases.iter().find(|profile| profile["caseId"] == case_id))
        })
        .or_else(|| {
            mybatis_registry["cases"]
                .as_array()
                .and_then(|cases| cases.iter().find(|profile| profile["caseId"] == case_id))
        })
        .ok_or("Unknown published fixture case")?;
    let has_preload = manifest["preload"]
        .as_str()
        .is_some_and(|value| !value.trim().is_empty());
    let has_feature = manifest["features"].as_array().is_some_and(|features| {
        features
            .iter()
            .any(|feature| feature["code"] == profile["featureCode"])
    });
    if manifest["name"] != profile["id"]
        || manifest["version"] != profile["version"]
        || !has_feature
        || (case_id == "local-mybatis-sql-formatter-head"
            && (profile["runtime"] != "web" || !mybatis_manifest_matches(manifest)))
        || (profile["runtime"] == "node" && !has_preload)
        || (case_id == "local-uuid-kit" && manifest["preload"] != "preload.js")
        || (case_id == "local-subnet-calculator" && manifest["preload"] != "preload.js")
        || (case_id == "local-plain-text" && manifest["preload"] != "preload/services.js")
        || (profile["runtime"] == "web"
            && has_preload
            && !((case_id == "todo-neo" && manifest["preload"] == "preload/services.js")
                || (case_id == "local-mybatis-sql-formatter-head"
                    && manifest["preload"] == "preload.js")
                || (case_id == "local-uuid-kit" && manifest["preload"] == "preload.js")
                || (case_id == "local-subnet-calculator" && manifest["preload"] == "preload.js")))
    {
        return Err(
            "Selected plugin manifest is not the registered reviewed package/runtime".into(),
        );
    }
    Ok(profile.clone())
}

fn mybatis_manifest_matches(manifest: &Value) -> bool {
    let commands = json!(["sql", "mybatis", "sql格式化", "sql日志", "SQL日志格式化",
        {"type":"over","label":"MyBatis SQL 日志格式化","minLength":10,"maxLength":50000}]);
    manifest["title"] == "MyBatis SQL 日志格式化"
        && manifest["main"] == "index.html"
        && manifest["preload"] == "preload.js"
        && manifest["features"].as_array().is_some_and(|features| {
            features.len() == 1
                && features[0]["code"] == "format-sql-log"
                && features[0]["cmds"] == commands
        })
}

pub(super) fn reviewed_converted_profile(
    manifest: &Value,
    tree_sha256: &str,
    case_id: &str,
) -> Result<Value, String> {
    let profile = crate::plugin_source_build::converted_source_registry::profile(case_id)?;
    let pins = crate::plugin_source_build::converted_source_registry::handoff(case_id)?;
    let features = manifest["features"].as_array();
    let feature_search_matches = if case_id == TODO_CASE {
        todo_manifest_features_match(manifest)
    } else if case_id == DEEPREAD_CASE {
        features.is_some_and(|items| {
            items.first().is_some_and(|feature| {
                feature["code"] == profile["featureCode"]
                    && feature["cmds"]
                        .as_array()
                        .is_some_and(|commands| commands.contains(&profile["searchQuery"]))
            })
        })
    } else {
        features.is_some_and(|items| {
            items.len() == 1
                && items[0]["cmds"]
                    .as_array()
                    .is_some_and(|commands| commands.contains(&profile["searchQuery"]))
        })
    };
    let feature_identity_matches = if case_id == TODO_CASE {
        features.is_some_and(|items| {
            items.len() == 2 && items[0]["code"] == "todo" && items[1]["code"] == "add"
        }) && profile["featureCode"] == "todo"
            && profile["searchQuery"] == "ToDo 待办"
    } else if case_id == DEEPREAD_CASE {
        deepread_manifest_features_match(manifest)
            && profile["featureCode"] == "deepread"
            && profile["searchQuery"] == "DeepRead"
    } else {
        features.is_some_and(|items| items.len() == 1 && items[0]["code"] == profile["featureCode"])
    };
    let expected_preload = pins["pluginPreload"].clone();
    let manifest_preload = manifest.get("preload").cloned().unwrap_or(Value::Null);
    if manifest["name"] != profile["id"]
        || manifest["version"] != profile["version"]
        || manifest["main"] != pins["pluginMain"]
        || manifest["title"] != profile["title"]
        || manifest_preload != expected_preload
        || !feature_identity_matches
        || !feature_search_matches
        || profile["sourceKind"] != "converted_handoff_directory"
        || profile["directorySha256"].as_str() != Some(tree_sha256)
        || profile.get("archiveSha256").is_some()
        || profile.get("archiveBytes").is_some()
    {
        return Err(
            "Converted package manifest or tree differs from its exact registered identity".into(),
        );
    }
    Ok(profile)
}

const TODO_CASE: &str = "converted-todo-neo-source";
const DEEPREAD_CASE: &str = "converted-deepread-source";

fn deepread_manifest_features_match(manifest: &Value) -> bool {
    let Some(features) = manifest["features"].as_array() else {
        return false;
    };
    const CODES: [&str; 9] = [
        "deepread",
        "deepread-import",
        "deepread-search-books",
        "deepread-prev-page",
        "deepread-next-page",
        "deepread-toggle-show",
        "deepread-close",
        "deepread-toggle-auto",
        "deepread-toggle-stealth",
    ];
    if features.len() != CODES.len()
        || !features
            .iter()
            .zip(CODES)
            .all(|(feature, code)| feature["code"] == code)
    {
        return false;
    }
    let import = &features[1];
    import["cmds"].as_array().is_some_and(|commands| {
        commands.len() == 2
            && commands[0] == "导入小说"
            && commands[1]
                == json!({"type":"files","fileType":"file","extensions":["txt","md"],
            "maxLength":1,"label":"导入到 DeepRead"})
    }) && features[0]["cmds"]
        .as_array()
        .is_some_and(|commands| commands.contains(&json!("DeepRead")))
}

fn todo_manifest_features_match(manifest: &Value) -> bool {
    let Some(features) = manifest["features"].as_array() else {
        return false;
    };
    features.len() == 2
        && features[0]["code"] == "todo"
        && features[0]["cmds"] == json!(["ToDo 待办"])
        && features[1]["code"] == "add"
        && features[1]["cmds"] == json!([{"type":"over","label":"添加到待办"}])
}

pub(super) fn profile_digest(profile: &Value) -> &Value {
    if matches!(
        profile["sourceKind"].as_str(),
        Some("local_full_directory" | "converted_handoff_directory")
    ) {
        &profile["directorySha256"]
    } else {
        &profile["archiveSha256"]
    }
}

#[cfg(test)]
mod input_profile_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn converted_deepread_accepts_pinned_retained_manifest_with_nine_features() {
        let bytes =
            include_str!("../../../tests/fixtures/converted-deepread-package-manifest-v1.json");
        let manifest: Value = serde_json::from_str(bytes).unwrap();
        let registry: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/converted-source-cases.json"
        ))
        .unwrap();
        let expected = registry["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|profile| profile["caseId"] == DEEPREAD_CASE)
            .unwrap();
        let pins = registry["handoffs"][DEEPREAD_CASE]["selectedPublicManifestSha256"]
            .as_str()
            .unwrap();
        use sha2::{Digest, Sha256};
        assert_eq!(format!("{:x}", Sha256::digest(bytes.as_bytes())), pins);

        let reviewed = reviewed_converted_profile(
            &manifest,
            expected["directorySha256"].as_str().unwrap(),
            DEEPREAD_CASE,
        )
        .unwrap();
        assert_eq!(reviewed, *expected);

        let mut wrong_search = manifest.clone();
        wrong_search["features"][0]["cmds"] = json!(["深读", "小说阅读"]);
        assert!(reviewed_converted_profile(
            &wrong_search,
            expected["directorySha256"].as_str().unwrap(),
            DEEPREAD_CASE,
        )
        .is_err());
        assert!(reviewed_converted_profile(
            &manifest,
            "0000000000000000000000000000000000000000000000000000000000000000",
            DEEPREAD_CASE,
        )
        .is_err());
    }

    #[test]
    fn converted_todo_feature_contract_is_exact_ordered_and_selects_only_todo() {
        let good = json!({"features":[
            {"code":"todo","cmds":["ToDo 待办"]},
            {"code":"add","cmds":[{"type":"over","label":"添加到待办"}]}
        ]});
        assert!(todo_manifest_features_match(&good));
        for bad in [
            json!({"features":[{"code":"add","cmds":[{"type":"over","label":"添加到待办"}]},
                {"code":"todo","cmds":["ToDo 待办"]}]}),
            json!({"features":[{"code":"todo","cmds":["ToDo 待办","todo"]},
                {"code":"add","cmds":[{"type":"over","label":"添加到待办"}]}]}),
            json!({"features":[{"code":"todo","cmds":["ToDo 待办"]},
                {"code":"add","cmds":[{"type":"over","label":"other"}]}]}),
            json!({"features":[{"code":"todo","cmds":["ToDo 待办"]}]}),
        ] {
            assert!(!todo_manifest_features_match(&bad));
        }
    }

    #[test]
    fn converted_deepread_keeps_main_identity_separate_from_exact_single_file_import_action() {
        let good = json!({"features":[
            {"code":"deepread","cmds":["深读","DeepRead"]},
            {"code":"deepread-import","cmds":["导入小说",{"type":"files","fileType":"file",
                "extensions":["txt","md"],"maxLength":1,"label":"导入到 DeepRead"}]},
            {"code":"deepread-search-books"},{"code":"deepread-prev-page"},
            {"code":"deepread-next-page"},{"code":"deepread-toggle-show"},
            {"code":"deepread-close"},{"code":"deepread-toggle-auto"},{"code":"deepread-toggle-stealth"}
        ]});
        assert!(deepread_manifest_features_match(&good));
        for (index, replacement) in [
            (
                1,
                json!({"code":"deepread-import","cmds":[{"type":"files",
            "fileType":"file","extensions":["txt","md"],"maxLength":2}]}),
            ),
            (3, json!({"code":"deepread-next-page"})),
        ] {
            let mut bad = good.clone();
            bad["features"][index] = replacement;
            assert!(!deepread_manifest_features_match(&bad));
        }
        let mut reordered = good.clone();
        reordered["features"].as_array_mut().unwrap().swap(0, 1);
        assert!(!deepread_manifest_features_match(&reordered));
    }

    #[test]
    fn original_subnet_retains_only_exact_electron_preload_as_web_without_permissions() {
        let mut manifest = json!({"name":"subnet-calculator","version":"1.0.0","main":"index.html",
            "preload":"preload.js","features":[{"code":"subnet"}]});
        let profile = reviewed_profile("local-subnet-calculator", &manifest).unwrap();
        assert_eq!(profile["runtime"], "web");
        assert_eq!(profile["dataAccess"], false);
        assert_eq!(profile["pathAccess"], "none");
        assert_eq!(profile["verifyDataPersistence"], false);
        for preload in [Value::Null, json!("other.js")] {
            manifest["preload"] = preload;
            assert!(reviewed_profile("local-subnet-calculator", &manifest).is_err());
        }
    }

    #[test]
    fn original_plain_requires_exact_node_preload_data_and_standard_metadata() {
        let mut manifest = json!({"name":"plain-text","version":"1.0.2","main":"index.html",
            "preload":"preload/services.js","features":[{"code":"editor"}]});
        let profile = reviewed_profile("local-plain-text", &manifest).unwrap();
        assert_eq!(profile["runtime"], "node");
        assert_eq!(profile["dataAccess"], true);
        assert_eq!(profile["pathAccess"], "standard");
        assert_eq!(profile["verifyDataPersistence"], true);
        for preload in [Value::Null, json!("preload.js")] {
            manifest["preload"] = preload;
            assert!(reviewed_profile("local-plain-text", &manifest).is_err());
        }
    }

    #[test]
    fn original_uuid_uses_web_runtime_with_only_its_reviewed_electron_preload() {
        let mut manifest = json!({"name":"uuid-kit","version":"1.0.0","main":"index.html",
            "preload":"preload.js","features":[{"code":"parse"}]});
        let profile = reviewed_profile("local-uuid-kit", &manifest).unwrap();
        assert_eq!(profile["runtime"], "web");
        assert_eq!(profile["dataAccess"], false);
        assert_eq!(profile["pathAccess"], "none");
        assert_eq!(profile["verifyDataPersistence"], false);
        assert_eq!(profile_digest(&profile), &profile["directorySha256"]);
        for preload in [Value::Null, json!("other.js")] {
            manifest["preload"] = preload;
            assert!(reviewed_profile("local-uuid-kit", &manifest).is_err());
        }
    }

    #[test]
    fn converted_calculator_returns_exact_registry_profile_and_checks_manifest_identity() {
        let manifest = json!({"name":"my-calculator","title":"计算器","version":"1.0.1","main":"index.html",
            "preload":"preload/services.js","features":[{"code":"calculator","cmds":["计算器","calc","calculator"]}]});
        let registry: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/converted-source-cases.json"
        ))
        .unwrap();
        let expected = registry["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|profile| profile["caseId"] == "converted-my-calculator-source")
            .unwrap();
        let profile = reviewed_converted_profile(
            &manifest,
            expected["directorySha256"].as_str().unwrap(),
            "converted-my-calculator-source",
        )
        .unwrap();
        assert_eq!(&profile, expected);
        assert_eq!(profile["caseId"], "converted-my-calculator-source");
        assert_eq!(profile["sourceKind"], "converted_handoff_directory");
        assert_eq!(profile["id"], "my-calculator");
        assert_eq!(profile["version"], "1.0.1");
        assert_eq!(profile["runtime"], "node");
        assert_eq!(profile["featureCode"], "calculator");
        assert_eq!(profile["directorySha256"], expected["directorySha256"]);
        assert_eq!(profile_digest(&profile), &profile["directorySha256"]);
        assert!(profile.get("sourceReview").is_none());
        assert!(profile.get("archiveSha256").is_none());
        assert!(profile.get("archiveExtension").is_none());
        assert!(profile.get("sourcePath").is_none());
        assert_eq!(
            profile["frameOperations"],
            "tests/components/nativeOriginalCalculatorFrameOperations.js"
        );
    }

    #[test]
    fn converted_calculator_rejects_manifest_or_registered_tree_drift() {
        let good = json!({"name":"my-calculator","title":"计算器","version":"1.0.1","main":"index.html",
            "preload":"preload/services.js","features":[{"code":"calculator","cmds":["计算器","calc","calculator"]}]});
        let hash = "68caa13719406a558d95e029dfdc7d9da64e031d4df5fa879233c8a26a191f0c";
        for (key, value) in [
            ("name", json!("other")),
            ("version", json!("1.0.2")),
            ("main", json!("other.html")),
            ("preload", json!("preload.js")),
        ] {
            let mut manifest = good.clone();
            manifest[key] = value;
            assert!(
                reviewed_converted_profile(&manifest, hash, "converted-my-calculator-source")
                    .is_err(),
                "{key}"
            );
        }
        let mut wrong_feature = good.clone();
        wrong_feature["features"] = json!([{"code":"other"}]);
        assert!(
            reviewed_converted_profile(&wrong_feature, hash, "converted-my-calculator-source")
                .is_err()
        );
        assert!(reviewed_converted_profile(
            &good,
            &"a".repeat(64),
            "converted-my-calculator-source"
        )
        .is_err());
    }

    #[test]
    fn converted_tetris_profile_matches_its_manifest_and_fixed_tree() {
        let manifest = json!({"name":"tetris","title":"俄罗斯方块","version":"1.0.0","main":"index.html",
            "features":[{"code":"tetris","cmds":["俄罗斯方块","tetris"]}]});
        let registry: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/converted-source-cases.json"
        ))
        .unwrap();
        let expected = registry["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|profile| profile["caseId"] == "converted-tetris-source")
            .unwrap();
        let profile = reviewed_converted_profile(
            &manifest,
            expected["directorySha256"].as_str().unwrap(),
            "converted-tetris-source",
        )
        .unwrap();
        assert_eq!(&profile, expected);
        assert_eq!(profile["runtime"], "web");
        assert_eq!(profile["dataAccess"], true);
        assert_eq!(profile["pathAccess"], "none");
        assert_eq!(profile["title"], "俄罗斯方块");
        assert_eq!(profile["searchQuery"], "tetris");
        let mut wrong = manifest.clone();
        wrong["features"][0]["code"] = json!("other");
        assert!(reviewed_converted_profile(
            &wrong,
            expected["directorySha256"].as_str().unwrap(),
            "converted-tetris-source"
        )
        .is_err());
    }

    #[test]
    fn converted_todo_profile_matches_ordered_manifest_and_pinned_installed_tree() {
        let manifest = json!({"name":"todo-neo","title":"Todo","version":"0.0.1","main":"index.html",
            "preload":"preload/services.js","features":[
                {"code":"todo","cmds":["ToDo 待办"]},
                {"code":"add","cmds":[{"type":"over","label":"添加到待办"}]}]});
        let registry: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/converted-source-cases.json"
        ))
        .unwrap();
        let expected = registry["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|profile| profile["caseId"] == "converted-todo-neo-source")
            .unwrap();
        let profile = reviewed_converted_profile(
            &manifest,
            expected["directorySha256"].as_str().unwrap(),
            "converted-todo-neo-source",
        )
        .unwrap();
        assert_eq!(&profile, expected);
        assert_eq!(profile["runtime"], "web");
        assert_eq!(profile["dataAccess"], true);
        assert_eq!(profile["pathAccess"], "none");
        assert_eq!(profile["verifyDataPersistence"], true);
        assert_eq!(
            profile["directorySha256"],
            "203ea9df26e6be26c4844930b14a6413e59113f5ab571e814d3b96d76de0789f"
        );

        let mut reversed = manifest.clone();
        reversed["features"] = json!([
            manifest["features"][1].clone(),
            manifest["features"][0].clone()
        ]);
        assert!(reviewed_converted_profile(
            &reversed,
            expected["directorySha256"].as_str().unwrap(),
            "converted-todo-neo-source"
        )
        .is_err());
        let mut changed_command = manifest;
        changed_command["features"][0]["cmds"][0] = json!("unreviewed");
        assert!(reviewed_converted_profile(
            &changed_command,
            expected["directorySha256"].as_str().unwrap(),
            "converted-todo-neo-source"
        )
        .is_err());
    }

    #[test]
    fn original_ascii_tree_requires_node_preload_and_declares_data_persistence() {
        let mut manifest = json!({"name":"ascii-tree","version":"1.0.0","main":"index.html",
            "preload":"preload.js","features":[{"code":"ascii-tree-open"}]});
        let profile = reviewed_profile("local-ascii-tree", &manifest).unwrap();
        assert_eq!(profile["runtime"], "node");
        assert_eq!(profile["dataAccess"], true);
        assert_eq!(profile["pathAccess"], "none");
        assert_eq!(profile["verifyDataPersistence"], true);
        manifest["preload"] = Value::Null;
        assert!(reviewed_profile("local-ascii-tree", &manifest).is_err());
        manifest["preload"] = json!("preload.js");
        manifest["features"] = json!([{"code":"other"}]);
        assert!(reviewed_profile("local-ascii-tree", &manifest).is_err());
    }

    #[test]
    fn mybatis_head_profile_matches_the_pinned_git_manifest_and_web_preload() {
        use sha2::{Digest, Sha256};
        let head_manifest_bytes =
            include_bytes!("../../../tests/fixtures/mybatis-head-plugin.json");
        let head_manifest_sha256 = format!("{:x}", Sha256::digest(head_manifest_bytes));
        assert_eq!(
            head_manifest_sha256,
            "757dca4b7e993cb2a7e6810a55c29242c31ecfe04d42f556d6b749039e782bf2"
        );
        let mut manifest: Value = serde_json::from_slice(head_manifest_bytes).unwrap();
        let profile = reviewed_profile("local-mybatis-sql-formatter-head", &manifest).unwrap();
        assert_eq!(profile["runtime"], "web");
        assert_eq!(profile["dataAccess"], false);
        assert_eq!(profile["dialogAccess"], "none");
        assert_eq!(profile["pathAccess"], "none");
        assert_eq!(manifest["features"][0]["cmds"][3], "sql日志");
        for (key, value) in [
            ("title", json!("Other")),
            ("main", json!("other.html")),
            ("preload", json!("preload/services.js")),
        ] {
            let mut changed = manifest.clone();
            changed[key] = value;
            assert!(
                reviewed_profile("local-mybatis-sql-formatter-head", &changed).is_err(),
                "{key}"
            );
        }
        manifest["features"][0]["cmds"][3] = json!("SQL日志");
        assert!(
            reviewed_profile("local-mybatis-sql-formatter-head", &manifest).is_err(),
            "command case drift"
        );
        manifest["features"][0]["cmds"][3] = json!("sql日志");
        manifest["features"][0]["cmds"][5]["maxLength"] = json!(50001);
        assert!(
            reviewed_profile("local-mybatis-sql-formatter-head", &manifest).is_err(),
            "overlong input limit"
        );
        manifest["features"][0]["cmds"][5]["maxLength"] = json!(50000);
        manifest["features"]
            .as_array_mut()
            .unwrap()
            .push(json!({"code":"unreviewed"}));
        assert!(
            reviewed_profile("local-mybatis-sql-formatter-head", &manifest).is_err(),
            "extra feature"
        );
    }
}
