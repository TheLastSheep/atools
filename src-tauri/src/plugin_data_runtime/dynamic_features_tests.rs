use super::{
    dynamic_features, operations, privacy, registry,
    source_hint::{Hints, Usage},
    tests::fixture,
    types::Invocation,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

fn feature(code: &str) -> Value {
    json!({"code":code,"explain":"private dynamic label","cmds":["private dynamic command"]})
}

fn request(method: &str, args: Value) -> Value {
    json!({"method":method,"args":args})
}

#[test]
fn dynamic_feature_runtime_returns_synchronous_values_and_only_dynamic_records() {
    let (db, mut plugin, _, _, _) = fixture();
    plugin.manifest.features = serde_json::from_value(json!([
        {"code":"manifest-only","explain":"Static entry","cmds":["static"]}
    ]))
    .unwrap();
    db.save_plugin(&plugin).unwrap();
    let call =
        |method: &str, args| operations::execute(&db, &plugin.id, &request(method, args)).unwrap();
    assert_eq!(call("features.get", json!([])), json!([]));
    assert_eq!(call("features.set", json!([feature("dynamic-a")])), true);
    assert_eq!(
        call(
            "features.set",
            json!([[feature("dynamic-b"), feature("dynamic-c")]])
        ),
        true
    );
    let records = call("features.get", json!([]));
    assert_eq!(records.as_array().unwrap().len(), 3);
    assert!(records
        .as_array()
        .unwrap()
        .iter()
        .all(|record| record["code"] != "manifest-only"));
    assert_eq!(
        call("features.get", json!([["missing", "dynamic-b"]]))[0]["code"],
        "dynamic-b"
    );
    assert_eq!(call("features.get", json!([[]])), json!([]));
    assert_eq!(call("features.set", json!([feature("dynamic-a")])), true);
    assert_eq!(call("features.set", json!([[]])), true);
    assert_eq!(call("features.remove", json!(["missing"])), false);
    assert_eq!(
        call("features.remove", json!([["missing", "dynamic-b"]])),
        true
    );
    assert_eq!(call("features.remove", json!([[]])), false);
    assert_eq!(call("features.get", json!([])).as_array().unwrap().len(), 2);
    let mut other = plugin.clone();
    other.id = "other-data-plugin".into();
    db.save_plugin(&other).unwrap();
    assert_eq!(
        operations::execute(&db, &other.id, &request("features.get", json!([]))).unwrap(),
        json!([])
    );
    assert_eq!(
        db.get_plugin(&plugin.id).unwrap().manifest.features.len(),
        1
    );
}

#[test]
fn dynamic_feature_runtime_rejects_invalid_shape_count_and_budget_before_write() {
    let (db, plugin, _, _, _) = fixture();
    for (method, args) in [
        ("features.get", json!([null])),
        ("features.get", json!(["code"])),
        ("features.get", json!([[], []])),
        ("features.get", json!([["code", 42]])),
        ("features.set", json!([])),
        ("features.set", json!([null])),
        ("features.set", json!([feature("a"), feature("b")])),
        ("features.set", json!([[feature("a"), false]])),
        ("features.remove", json!([])),
        ("features.remove", json!([null])),
        ("features.remove", json!(["a", "b"])),
        ("features.remove", json!([["a", 7]])),
        ("features.get", json!([vec!["a"; 129]])),
        ("features.set", json!([vec![feature("a"); 129]])),
        ("features.remove", json!([vec!["a"; 129]])),
        (
            "features.set",
            json!([{"code":"a","cmds":["x".repeat(512*1024)]}]),
        ),
    ] {
        let request = request(method, args);
        assert!(operations::validate(&request).is_err(), "{method}");
        assert!(
            operations::execute(&db, &plugin.id, &request).is_err(),
            "{method}"
        );
        assert!(db
            .plugin_dynamic_features(&plugin.id, None)
            .unwrap()
            .is_empty());
    }
    for value in [
        json!({"method":"features.set","args":[feature("a")],"pluginId":"foreign"}),
        json!({"method":"features.clear","args":[]}),
    ] {
        assert!(operations::validate(&value).is_err());
    }
}

#[test]
fn dynamic_feature_runtime_batch_is_atomic_on_core_validation_failure() {
    let (db, plugin, _, _, _) = fixture();
    let result = operations::execute(
        &db,
        &plugin.id,
        &request(
            "features.set",
            json!([
                [feature("accepted-shape"), {"code":"","cmds":["invalid"]}]
            ]),
        ),
    );
    assert!(result.is_err());
    assert!(db
        .plugin_dynamic_features(&plugin.id, None)
        .unwrap()
        .is_empty());
}

#[test]
fn dynamic_feature_runtime_bound_write_rejects_closed_disabled_revoked_and_foreign_tickets() {
    for mode in 0..11 {
        let (db, mut plugin, runtime, owner, binding) = fixture();
        registry::ensure_tool(&db, &plugin).unwrap();
        let (document, document_active) = crate::plugin_page_runtime::test_binding();
        let intent = runtime
            .intent(
                runtime.begin_bound(owner.clone(), Some(document)).unwrap(),
                binding.clone(),
            )
            .unwrap();
        let session = runtime.open(&intent, &binding).unwrap();
        let args = vec![feature("must-not-write")];
        let invocation = Arc::new(Invocation {
            session: if mode == 10 {
                "foreign-session".into()
            } else {
                session.id.clone()
            },
            request: request("features.set", Value::Array(args.clone())),
            claimed: AtomicBool::new(mode != 6),
            dynamic_features_changed: AtomicBool::new(false),
            run: parking_lot::Mutex::new(Some("private-unit-run".into())),
            result: parking_lot::Mutex::new(None),
        });
        runtime
            .store
            .lock()
            .invocations
            .insert("fixed-ticket".into(), invocation.clone());
        let mut supplied_args = args;
        match mode {
            0 => {
                runtime.close(Some(&owner), None, None, false);
            }
            1 => {
                plugin.enabled = false;
                db.save_plugin(&plugin).unwrap();
            }
            2 => {
                crate::agent_tools::set_agent_scope_policy(&db, "plugin_data", "deny").unwrap();
            }
            3 => {
                db.set_agent_tool_enabled(&session.tool, false).unwrap();
            }
            4 => {
                crate::plugin_code_revision::CodeRevision::begin(&db, &plugin.id)
                    .unwrap()
                    .finish(&db)
                    .unwrap();
            }
            5 => {
                document_active.store(false, Ordering::Release);
            }
            6 => {}
            7 => {
                runtime.store.lock().invocations.remove("fixed-ticket");
            }
            8 => {
                supplied_args = vec![feature("foreign-payload")];
            }
            9 => {
                *session.active.lock() = false;
            }
            _ => {}
        }
        let result = dynamic_features::execute_bound(
            &db,
            &plugin.id,
            "features.set",
            &supplied_args,
            Some((&runtime, &session, "fixed-ticket")),
        );
        assert!(result.is_err(), "mode {mode}");
        assert!(!invocation.dynamic_features_changed.load(Ordering::Acquire));
        plugin.enabled = true;
        db.save_plugin(&plugin).unwrap();
        assert!(
            db.plugin_dynamic_features(&plugin.id, None)
                .unwrap()
                .is_empty(),
            "mode {mode}"
        );
    }
}

#[test]
fn dynamic_feature_runtime_private_change_flag_tracks_only_actual_committed_changes() {
    let (db, plugin, runtime, owner, binding) = fixture();
    registry::ensure_tool(&db, &plugin).unwrap();
    let intent = runtime
        .intent(runtime.begin(owner).unwrap(), binding.clone())
        .unwrap();
    let session = runtime.open(&intent, &binding).unwrap();
    for (index, (method, args, expected, changed)) in [
        ("features.set", json!([feature("a")]), json!(true), true),
        ("features.set", json!([feature("a")]), json!(true), false),
        ("features.get", json!([]), json!([feature("a")]), false),
        ("features.remove", json!(["missing"]), json!(false), false),
        ("features.remove", json!(["a"]), json!(true), true),
    ]
    .into_iter()
    .enumerate()
    {
        let ticket = format!("fixed-{index}");
        let invocation = Arc::new(Invocation {
            session: session.id.clone(),
            request: request(method, args.clone()),
            claimed: AtomicBool::new(true),
            dynamic_features_changed: AtomicBool::new(false),
            run: parking_lot::Mutex::new(Some("private-unit-run".into())),
            result: parking_lot::Mutex::new(None),
        });
        runtime
            .store
            .lock()
            .invocations
            .insert(ticket.clone(), invocation.clone());
        let result = dynamic_features::execute_bound(
            &db,
            &plugin.id,
            method,
            args.as_array().unwrap(),
            Some((&runtime, &session, &ticket)),
        )
        .unwrap();
        if method == "features.get" {
            assert_eq!(result[0]["code"], expected[0]["code"]);
        } else {
            assert_eq!(result, expected);
        }
        assert_eq!(
            invocation.dynamic_features_changed.load(Ordering::Acquire),
            changed
        );
    }
}

#[test]
fn dynamic_feature_runtime_refresh_requires_successful_changed_mutation() {
    let success = Ok(json!(true));
    for method in ["features.get", "db.put", "webStorage.setItem"] {
        assert!(!dynamic_features::should_refresh(
            method,
            true,
            Some(&success),
            true
        ));
    }
    for method in ["features.set", "features.remove"] {
        assert!(dynamic_features::should_refresh(
            method,
            true,
            Some(&success),
            true
        ));
        assert!(!dynamic_features::should_refresh(
            method,
            false,
            Some(&success),
            true
        ));
        assert!(!dynamic_features::should_refresh(
            method,
            true,
            Some(&success),
            false
        ));
        for result in [
            None,
            Some(Err("private failure".into())),
            Some(Ok(json!(false))),
            Some(Ok(json!({"changed":true}))),
        ] {
            assert!(!dynamic_features::should_refresh(
                method,
                true,
                result.as_ref(),
                true
            ));
        }
        assert!(operations::logical_failure(method, &json!(false)));
        assert!(!operations::logical_failure(method, &json!(true)));
    }
    assert!(!operations::logical_failure("features.get", &json!([])));
}

#[test]
fn dynamic_feature_runtime_metadata_excludes_registration_body_and_requires_matching_private_ticket(
) {
    let (db, plugin, runtime, owner, binding) = fixture();
    registry::ensure_tool(&db, &plugin).unwrap();
    let intent = runtime
        .intent(runtime.begin(owner).unwrap(), binding.clone())
        .unwrap();
    let session = runtime.open(&intent, &binding).unwrap();
    let invocation = Arc::new(Invocation {
        session: session.id.clone(),
        request: request("features.set", json!([feature("private-code")])),
        claimed: AtomicBool::new(false),
        dynamic_features_changed: AtomicBool::new(false),
        run: parking_lot::Mutex::new(None),
        result: parking_lot::Mutex::new(None),
    });
    runtime
        .store
        .lock()
        .invocations
        .insert("private-ticket".into(), invocation);
    let metadata = json!({"operation":"request","sessionId":session.id,"invocationId":"private-ticket","method":"features.set"});
    privacy::validate(&runtime, &plugin.id, &session.tool, &metadata).unwrap();
    assert!(privacy::validate(&runtime, "foreign-plugin", &session.tool, &metadata).is_err());
    for private in [
        "private-code",
        "private dynamic command",
        "private dynamic label",
        "cmds",
        "icon",
    ] {
        assert!(!metadata.to_string().contains(private));
    }
    let mut raw = metadata.clone();
    raw["feature"] = feature("private-code");
    assert!(privacy::validate(&runtime, &plugin.id, &session.tool, &raw).is_err());
    let mut foreign = metadata;
    foreign["method"] = json!("features.remove");
    assert!(privacy::validate(&runtime, &plugin.id, &session.tool, &foreign).is_err());
}

#[test]
fn dynamic_feature_runtime_source_hint_covers_bounded_original_api_spellings() {
    let (db, mut plugin, _, _, _) = fixture();
    let directory = tempfile::tempdir().unwrap();
    plugin.path = directory.path().to_string_lossy().into_owned();
    db.save_plugin(&plugin).unwrap();
    let hints = Hints::default();
    for source in [
        "window.ztools . getFeatures ()",
        "utools . setFeature ({code:'test'})",
        "ztools['removeFeature']('test')",
        "window [ 'utools' ] [ \"getFeatures\" ] (['test'])",
        "window.ztools?.setFeature?.({code:'test'})",
    ] {
        std::fs::write(directory.path().join("entry.js"), source).unwrap();
        assert_eq!(hints.scan(&plugin, None), Usage::Detected, "{source}");
    }
    std::fs::write(directory.path().join("entry.js"), "unrelatedFunction()").unwrap();
    assert_eq!(hints.scan(&plugin, None), Usage::NotDetected);
    std::fs::write(
        directory.path().join("entry.js"),
        format!("{}ztools.setFeature({{}})", " ".repeat(2 * 1024 * 1024)),
    )
    .unwrap();
    assert_eq!(hints.scan(&plugin, None), Usage::Unknown);
}
