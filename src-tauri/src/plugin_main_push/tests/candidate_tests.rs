use super::*;
#[test]
fn main_push_candidates_only_match_raw_declared_commands_and_enabled_main_push_owners() {
    let (db, mut p, _root) = setup();
    assert!(candidates::search(&db, "发现标题仅用于展示", false, None)
        .unwrap()
        .is_empty());
    assert!(candidates::search(&db, "", false, None).unwrap().is_empty());
    assert!(candidates::search(&db, " \n\t ", false, None)
        .unwrap()
        .is_empty());
    let exact = candidates::search(&db, "keyword", false, None).unwrap();
    assert_eq!(exact.len(), 1);
    assert_eq!(exact[0].identity.command_type, CommandType::Text);
    assert_eq!(exact[0].result.label, "发现标题仅用于展示");
    assert_eq!(
        candidates::search(&db, "123", false, None).unwrap()[0]
            .identity
            .command_type,
        CommandType::Regex
    );
    assert!(candidates::search(&db, "skip", false, None)
        .unwrap()
        .is_empty());
    assert_eq!(
        candidates::search(&db, "skip", true, None).unwrap()[0]
            .identity
            .command_type,
        CommandType::Over
    );
    p.enabled = false;
    db.save_plugin(&p).unwrap();
    assert!(candidates::search(&db, "keyword", false, None)
        .unwrap()
        .is_empty());
    assert!(candidates::validate(&db, &exact[0].identity).is_err());
}

#[test]
fn main_push_current_owner_and_code_revision_are_rechecked_without_original_query() {
    let (db, p, _root) = setup();
    let identity = candidates::search(&db, "keyword", false, None)
        .unwrap()
        .remove(0)
        .identity;
    candidates::validate(&db, &identity).unwrap();
    let revision = crate::plugin_code_revision::CodeRevision::begin(&db, &p.id).unwrap();
    assert!(candidates::validate(&db, &identity).is_err());
    revision.finish(&db).unwrap();
    assert!(candidates::validate(&db, &identity).is_err());
    let current = candidates::search(&db, "keyword", false, None)
        .unwrap()
        .remove(0)
        .identity;
    assert_ne!(current.code_revision, identity.code_revision);
    let mut replacement = plugin("other");
    replacement
        .manifest
        .features
        .retain(|f| f.code == "dynamic");
    db.save_plugin_with_features(&replacement, &replacement.manifest.features)
        .unwrap();
    assert!(candidates::validate(&db, &current).is_err());
}

#[test]
fn main_push_node_preload_panel_is_eligible_without_web_runtime_kind_shortcut() {
    let (db, mut p, _root) = setup();
    p.manifest.main = None;
    p.manifest.preload = Some("preload.cjs".into());
    p.manifest.runtime = Some(
        serde_json::from_value(
            json!({"kind":"node","transport":"json_rpc_stdio","entry":"sidecar.cjs"}),
        )
        .unwrap(),
    );
    db.save_plugin(&p).unwrap();
    assert_eq!(
        candidates::search(&db, "keyword", false, None)
            .unwrap()
            .len(),
        1
    );
    p.manifest.preload = None;
    db.save_plugin(&p).unwrap();
    assert!(candidates::search(&db, "keyword", false, None)
        .unwrap()
        .is_empty());
}

#[test]
fn main_push_closed_metadata_rejects_private_strings_and_prepare_query_bytes() {
    let r = request(Operation::Query);
    let value = serde_json::to_value(&r).unwrap();
    assert_eq!(super::super::parse(&value).unwrap(), r);
    for field in ["query", "payload", "option", "rows", "error", "path"] {
        let mut forged = value.clone();
        forged[field] = json!("PRIVATE_INPUT_SENTINEL");
        let error = super::super::parse(&forged).unwrap_err();
        assert!(!error.contains("PRIVATE_INPUT_SENTINEL"));
    }
    let mut r = request(Operation::Prepare);
    r.input_bytes = 1;
    assert!(r.validate().is_err());
    r = request(Operation::Query);
    r.input_bytes = 1_048_577;
    assert!(r.validate().is_err());
    r = request(Operation::Query);
    r.identity.plugin_id = " bad".into();
    assert!(r.validate().is_err());
}

#[test]
fn main_push_stable_tool_has_no_implicit_resource_grants_and_pruned_code_grants_are_revoked() {
    let (db, p, _root) = setup();
    let name = registry::ensure(&db, &p).unwrap();
    let tool = db.get_agent_tool(&name).unwrap().unwrap();
    assert!(tool.scopes.is_empty());
    assert_eq!(tool.source, registry::SOURCE);
    assert!(tool.input_schema["additionalProperties"] == false);
    db.grant_agent_tool("atools-ui", &name).unwrap();
    db.delete_agent_tools_by_source_except(registry::SOURCE, &[])
        .unwrap();
    crate::plugin_lifecycle_permissions::revoke_code_grants(&db, &p.id).unwrap();
    assert!(!db.is_agent_tool_granted("atools-ui", &name).unwrap());
}

#[test]
fn main_push_private_created_run_retains_capability_digest_and_redacted_input() {
    use atools_core::task_run::{TaskRun, TaskRunInitiator};
    let (db, p, _root) = setup();
    let name = registry::ensure(&db, &p).unwrap();
    let input = serde_json::to_value(request(Operation::Prepare)).unwrap();
    let mut first = TaskRun::new(
        &name,
        TaskRunInitiator::human(Some("atools-ui".into())),
        input.clone(),
    );
    crate::agent_tools::initialize_new_task_run(&db, &mut first).unwrap();
    assert_eq!(first.input, input);
    let digest = first.output["capabilitySnapshot"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(digest.len(), 64);
    crate::plugin_code_revision::CodeRevision::begin(&db, &p.id)
        .unwrap()
        .finish(&db)
        .unwrap();
    let mut next = TaskRun::new(
        &name,
        TaskRunInitiator::human(Some("atools-ui".into())),
        input,
    );
    crate::agent_tools::initialize_new_task_run(&db, &mut next).unwrap();
    assert_ne!(next.output["capabilitySnapshot"].as_str().unwrap(), digest);
}

#[test]
fn main_push_legacy_config_cannot_erase_original_package_platform_restrictions() {
    let (db, p, root) = setup();
    let mut source = serde_json::to_value(&p.manifest).unwrap();
    let foreign = if cfg!(target_os = "windows") {
        "darwin"
    } else {
        "win32"
    };
    source["platform"] = json!([foreign]);
    std::fs::write(
        root.path().join("plugin.json"),
        serde_json::to_vec(&source).unwrap(),
    )
    .unwrap();
    // Persisted pre-platform config looks unrestricted; original package is not.
    assert!(db.get_plugin(&p.id).unwrap().manifest.platform.is_empty());
    assert!(candidates::search(&db, "keyword", false, None)
        .unwrap()
        .is_empty());
    super::super::platform_source::invalidate(Some(&p.id));
    source.as_object_mut().unwrap().remove("platform");
    source["features"][0]["platform"] = json!([foreign]);
    std::fs::write(
        root.path().join("plugin.json"),
        serde_json::to_vec(&source).unwrap(),
    )
    .unwrap();
    assert!(candidates::search(&db, "keyword", false, None)
        .unwrap()
        .is_empty());
}

#[test]
fn main_push_dynamic_platform_comes_from_authoritative_original_declaration() {
    let (db, p, _root) = setup();
    let foreign = if cfg!(target_os = "windows") {
        "darwin"
    } else {
        "win32"
    };
    db.plugin_dynamic_features_set(&p.id,&[json!({"code":"dynamic-only","mainPush":true,"platform":[foreign],"cmds":["dynamic-only"]})]).unwrap();
    assert!(candidates::search(&db, "dynamic-only", false, None)
        .unwrap()
        .iter()
        .all(|c| c.identity.feature_code != "dynamic-only"));
    db.plugin_dynamic_features_set(
        &p.id,
        &[json!({"code":"dynamic-only","mainPush":true,"cmds":["dynamic-only"]})],
    )
    .unwrap();
    let candidate = candidates::search(&db, "dynamic-only", false, None)
        .unwrap()
        .into_iter()
        .find(|c| c.identity.feature_code == "dynamic-only")
        .unwrap();
    candidates::validate(&db, &candidate.identity).unwrap();
    db.plugin_dynamic_features_set(&p.id,&[json!({"code":"dynamic-only","mainPush":true,"platform":[foreign],"cmds":["dynamic-only"]})]).unwrap();
    assert!(candidates::validate(&db, &candidate.identity).is_err());
}

#[test]
fn main_push_headless_and_pruned_private_tool_names_fail_before_persistence() {
    let (db, p, _root) = setup();
    let name = registry::ensure(&db, &p).unwrap();
    assert_eq!(
        super::super::private_tool(&db, "agent", &name).unwrap_err(),
        "ERR_MAIN_PUSH_UI_REQUIRED"
    );
    db.delete_agent_tools_by_source_except(registry::SOURCE, &[])
        .unwrap();
    assert_eq!(
        super::super::private_tool(&db, "atools-ui", &name).unwrap_err(),
        "ERR_MAIN_PUSH_UI_REQUIRED"
    );
    assert!(
        super::super::private_tool(&db, "agent", "unrelated-ordinary-tool")
            .unwrap()
            .is_none()
    );
    assert!(db.list_task_runs(10).unwrap().is_empty());
}

#[test]
fn main_push_original_platform_source_cache_has_a_strict_total_entry_budget() {
    let (_db, mut p, _root) = setup();
    p.id = "x".repeat(8 * 1024 * 1024);
    let error = super::super::platform_source::current(&p, "bounded-key")
        .err()
        .unwrap();
    assert_eq!(error, "ERR_MAIN_PUSH_PLATFORM_UNAVAILABLE");
}
#[test]
fn main_push_platform_source_is_reused_only_for_the_same_managed_code_identity() {
    let (db, p, root) = setup();
    let first = candidates::search(&db, "keyword", false, None).unwrap();
    assert_eq!(first.len(), 1);
    std::fs::remove_file(root.path().join("plugin.json")).unwrap();
    let second = candidates::search(&db, "keyword", false, None).unwrap();
    assert_eq!(second.len(), 1);
    assert_eq!(first[0].identity, second[0].identity);
    crate::plugin_code_revision::CodeRevision::begin(&db, &p.id)
        .unwrap()
        .finish(&db)
        .unwrap();
    assert!(candidates::search(&db, "keyword", false, None)
        .unwrap()
        .is_empty());
    assert!(candidates::validate(&db, &first[0].identity).is_err());
}
