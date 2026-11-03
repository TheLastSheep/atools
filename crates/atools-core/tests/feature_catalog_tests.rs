use atools_core::{matcher::search_all, Database, Feature, Plugin};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Barrier},
    time::Instant,
};

#[path = "support/query_cpu.rs"]
mod query_cpu;

fn plugin(id: &str, features: Value) -> Plugin {
    Plugin {
        id: id.into(),
        name: id.into(),
        version: "1".into(),
        path: "/nonexistent/plugin".into(),
        enabled: true,
        manifest: serde_json::from_value(json!({"name":id,"title":"颜色助手","features":features}))
            .unwrap(),
        created_at: "now".into(),
        updated_at: "now".into(),
    }
}
fn features(value: Value) -> Vec<Feature> {
    serde_json::from_value(value).unwrap()
}

#[test]
fn static_color_titles_preserve_command_identity_and_never_downgrade_existing_matches() {
    let db = Database::in_memory().unwrap();
    let p = plugin(
        "color-helper",
        json!([
            {"code":"color","explain":"颜色","cmds":["Color","颜色",{"type":"regex","match":"^#[0-9a-f]+$","label":"颜色"}]},
            {"code":"collect","explain":"收藏颜色","cmds":["收藏颜色"]},
            {"code":"ui","cmds":["UI 色卡"]}, {"code":"unknown","cmds":[]}
        ]),
    );
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    let snapshot = db.feature_catalog_snapshot().unwrap();
    assert_eq!(snapshot.find(&p.id, "color").unwrap().display_label, "颜色");
    assert_eq!(
        snapshot.find(&p.id, "collect").unwrap().display_label,
        "收藏颜色"
    );
    assert_eq!(snapshot.find(&p.id, "ui").unwrap().display_label, "UI 色卡");
    assert_eq!(
        snapshot.find(&p.id, "unknown").unwrap().display_label,
        "颜色助手"
    );
    assert_eq!(
        snapshot.find(&p.id, "color").unwrap().feature.label,
        "color"
    );
    for query in [
        "", "Color", "col", "颜色", "yanse", "scys", "#aabbcc", "missing",
    ] {
        let actual = snapshot.search(query);
        for original in search_all(&db.all_features().unwrap(), query) {
            let matched = actual
                .iter()
                .find(|item| {
                    item.plugin_id == original.plugin_id
                        && item.feature_code == original.feature_code
                })
                .unwrap();
            assert!(matched.score >= original.score, "{query}");
            if matched.score == original.score {
                assert_eq!(matched, &original, "{query}");
            }
        }
    }
    assert!(Arc::ptr_eq(
        &snapshot,
        &db.clone().feature_catalog_snapshot().unwrap()
    ));
    // Ordinary settings/data writes and runtime resets do not affect this generation.
    db.set_setting("theme", "dark").unwrap();
    assert!(Arc::ptr_eq(
        &snapshot,
        &db.feature_catalog_snapshot().unwrap()
    ));
}

#[test]
fn original_color_manifest_metadata_indexes_through_real_database_without_loading_code() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../ZTools-plugins/plugins/color-helper/plugin.json");
    let manifest = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let p = Plugin {
        manifest,
        ..plugin("color-helper", json!([]))
    };
    let db = Database::in_memory().unwrap();
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    let snapshot = db.feature_catalog_snapshot().unwrap();
    assert_eq!(
        snapshot
            .find("color-helper", "color")
            .unwrap()
            .display_label,
        "颜色"
    );
    assert_eq!(
        snapshot
            .find("color-helper", "collect")
            .unwrap()
            .display_label,
        "收藏颜色"
    );
    assert_eq!(snapshot.search("Color")[0].feature_code, "color");
}

#[test]
fn explicit_dynamic_same_code_labels_survive_restart_and_all_mutations_invalidate() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("catalog.db");
    let db = Database::open(&file).unwrap();
    let mut p = plugin(
        "hash",
        json!([{"code":"MD5","label":"旧标题","cmds":["md5"]}]),
    );
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    let first = db.feature_catalog_snapshot().unwrap();
    db.index_features(
        &p.id,
        &features(json!([{"code":"MD5","label":"MD5","explain":"摘要说明","cmds":["md5"]}])),
    )
    .unwrap();
    let next = db.feature_catalog_snapshot().unwrap();
    assert!(!Arc::ptr_eq(&first, &next));
    assert_eq!(next.find(&p.id, "MD5").unwrap().display_label, "MD5");
    assert_eq!(next.find(&p.id, "MD5").unwrap().label_source, "declared");
    drop(db);
    let db = Database::open(&file).unwrap();
    assert_eq!(
        db.feature_catalog_snapshot()
            .unwrap()
            .find(&p.id, "MD5")
            .unwrap()
            .display_label,
        "MD5"
    );
    assert!(db.delete_feature(&p.id, "MD5").unwrap());
    let empty = db.feature_catalog_snapshot().unwrap();
    assert!(empty.entries().is_empty());
    assert!(!db.delete_feature(&p.id, "missing").unwrap());
    assert!(Arc::ptr_eq(&empty, &db.feature_catalog_snapshot().unwrap()));
    db.index_features(
        &p.id,
        &features(json!([{"code":"x","label":"新名称","cmds":["x"]}])),
    )
    .unwrap();
    p.enabled = false;
    db.save_plugin(&p).unwrap();
    assert!(db.feature_catalog_snapshot().unwrap().entries().is_empty());
    p.enabled = true;
    db.save_plugin(&p).unwrap();
    assert_eq!(
        db.feature_catalog_snapshot()
            .unwrap()
            .find(&p.id, "x")
            .unwrap()
            .display_label,
        "新名称"
    );
    db.delete_plugin(&p.id).unwrap();
    assert!(db.feature_catalog_snapshot().unwrap().entries().is_empty());
}

#[test]
fn second_connection_metadata_commits_refresh_the_first_connection() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("shared.db");
    let first = Database::open(&file).unwrap();
    let mut p = plugin(
        "p",
        json!([{"code":"color","explain":"颜色","cmds":["color"]}]),
    );
    first
        .save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    let old = first.feature_catalog_snapshot().unwrap();
    let second = Database::open(&file).unwrap();
    p.manifest.title = Some("新插件标题".into());
    second.save_plugin(&p).unwrap();
    let current = first.feature_catalog_snapshot().unwrap();
    assert!(!Arc::ptr_eq(&old, &current));
    assert_ne!(old.generation, current.generation);
    assert_eq!(
        current.find("p", "color").unwrap().plugin_display_name,
        "新插件标题"
    );
    second
        .index_features(
            "p",
            &features(json!([{"code":"color","label":"动态名称","cmds":["color"]}])),
        )
        .unwrap();
    assert_eq!(
        first
            .feature_catalog_snapshot()
            .unwrap()
            .find("p", "color")
            .unwrap()
            .display_label,
        "动态名称"
    );
    second.delete_feature("p", "color").unwrap();
    assert!(first
        .feature_catalog_snapshot()
        .unwrap()
        .entries()
        .is_empty());
}

#[test]
fn failed_transaction_and_failed_single_write_do_not_publish_or_invalidate() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("failure.db");
    let db = Database::open(&file).unwrap();
    let mut p = plugin("p", json!([{"code":"ok","label":"原名称","cmds":["ok"]}]));
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    let sql = rusqlite::Connection::open(&file).unwrap();
    sql.execute_batch("CREATE TRIGGER fail_feature BEFORE INSERT ON features WHEN NEW.code='bad' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;
        CREATE TRIGGER fail_plugin BEFORE UPDATE ON plugins WHEN NEW.name='bad' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    let before = db.feature_catalog_snapshot().unwrap();
    p.manifest.title = Some("不应发布".into());
    assert!(db
        .save_plugin_with_features(&p, &features(json!([{"code":"bad","label":"错误"}])))
        .is_err());
    assert!(Arc::ptr_eq(
        &before,
        &db.feature_catalog_snapshot().unwrap()
    ));
    assert_eq!(
        db.get_plugin("p").unwrap().manifest.title.as_deref(),
        Some("颜色助手")
    );
    p.name = "bad".into();
    assert!(db.save_plugin(&p).is_err());
    assert!(Arc::ptr_eq(
        &before,
        &db.feature_catalog_snapshot().unwrap()
    ));
}

#[test]
fn old_schema_migrates_once_under_concurrent_open_without_rewriting_legacy_labels() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("legacy.db");
    let sql = rusqlite::Connection::open(&file).unwrap();
    sql.execute_batch("CREATE TABLE plugins(id TEXT PRIMARY KEY,name TEXT NOT NULL,version TEXT NOT NULL,path TEXT NOT NULL,enabled INTEGER NOT NULL,config TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE features(code TEXT PRIMARY KEY,plugin_id TEXT NOT NULL,label TEXT NOT NULL,icon TEXT,explain TEXT NOT NULL,cmds TEXT NOT NULL,main_push INTEGER NOT NULL,priority INTEGER NOT NULL);").unwrap();
    let p = plugin(
        "p",
        json!([{"code":"color","explain":"颜色","cmds":["颜色"]}]),
    );
    sql.execute(
        "INSERT INTO plugins VALUES(?1,?1,'1','/missing',1,?2,'now','now')",
        rusqlite::params![p.id, serde_json::to_string(&p.manifest).unwrap()],
    )
    .unwrap();
    sql.execute_batch(
        "INSERT INTO features VALUES('color','p','color',NULL,'颜色','[\"颜色\"]',0,0);",
    )
    .unwrap();
    drop(sql);
    let barrier = Arc::new(Barrier::new(2));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let file = file.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                Database::open(&file).unwrap()
            })
        })
        .collect();
    for thread in threads {
        let db = thread.join().unwrap();
        assert_eq!(
            db.feature_catalog_snapshot()
                .unwrap()
                .find("p", "color")
                .unwrap()
                .display_label,
            "颜色"
        );
        assert_eq!(db.get_feature("color").unwrap().label, "color");
    }
    let sql = rusqlite::Connection::open(&file).unwrap();
    assert_eq!(
        sql.query_row("SELECT label_declared FROM features", [], |r| r
            .get::<_, Option<bool>>(0))
            .unwrap(),
        None
    );
}

#[test]
fn metadata_and_index_limits_reject_writes_without_invalidating_a_working_catalog() {
    let db = Database::in_memory().unwrap();
    let p = plugin("p", json!([]));
    db.save_plugin(&p).unwrap();
    let huge = "x".repeat(3 * 1024 * 1024);
    let before=db.feature_catalog_snapshot().unwrap();
    assert!(db.index_features("p", &features(json!([{"code":"big","cmds":[huge]}])))
        .unwrap_err().to_string().contains("index"));
    assert!(Arc::ptr_eq(&before,&db.feature_catalog_snapshot().unwrap()));
    db.index_features(
        "p",
        &features(json!([{"code":"ok","explain":"可用","cmds":["ok"]}])),
    )
    .unwrap();
    assert_eq!(db.feature_catalog_snapshot().unwrap().entries().len(), 1);
    let mut large = p;
    large.manifest.description = Some("x".repeat(17 * 1024 * 1024));
    let before=db.feature_catalog_snapshot().unwrap();
    assert!(db.save_plugin(&large).unwrap_err().to_string().contains("metadata"));
    assert!(Arc::ptr_eq(&before,&db.feature_catalog_snapshot().unwrap()));
}

#[test]
fn feature_count_limit_reports_an_error_instead_of_silently_omitting_entries() {
    let db = Database::in_memory().unwrap();
    let p = plugin("p", json!([]));
    db.save_plugin(&p).unwrap();
    let declared = (0..20_001)
        .map(|i| json!({"code":format!("f{i}")}))
        .collect::<Vec<_>>();
    let before=db.feature_catalog_snapshot().unwrap();
    assert!(db.index_features("p", &features(Value::Array(declared)))
        .unwrap_err().to_string().contains("20000"));
    assert!(Arc::ptr_eq(&before,&db.feature_catalog_snapshot().unwrap()));
    assert!(db.all_features().unwrap().is_empty());
}

#[test]
fn twelve_hundred_features_have_bounded_cold_and_repeated_search_cost() {
    let db = Database::in_memory().unwrap();
    let declared = (0..1200).map(|i| json!({"code":format!("cmd-{i}"),"explain":format!("功能 {i}"),"cmds":[format!("command-{i}"),format!("功能{i}")]})).collect::<Vec<_>>();
    let p = plugin("performance", Value::Array(declared));
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    let cold_cpu_start = query_cpu::start_ns();
    let started = Instant::now();
    let snapshot = db.feature_catalog_snapshot().unwrap();
    let cold = started.elapsed();
    let cold_cpu = query_cpu::elapsed_ns(cold_cpu_start);
    let mut maximum = std::time::Duration::ZERO;
    for query in ["command-1199", "功能1199", "gn1199", "gongneng1199"]
        .into_iter()
        .cycle()
        .take(120)
    {
        let cpu_start = query_cpu::start_ns();
        let started = Instant::now();
        let warm = db.feature_catalog_snapshot().unwrap();
        let matches = warm.search(query);
        let elapsed = started.elapsed();
        maximum = maximum.max(elapsed);
        let cpu = query_cpu::elapsed_ns(cpu_start);
        eprintln!(
            "catalog1200_query query={query} results={} wall_ns={} thread_cpu_ns={}",
            matches.len(),
            elapsed.as_nanos(),
            query_cpu::display(cpu)
        );
        assert!(Arc::ptr_eq(&snapshot, &warm));
        assert!(!matches.is_empty());
    }
    eprintln!(
        "catalog 1200: cold={cold:?}, cold_thread_cpu_ns={}, warm max={maximum:?}, metadata={}, index allowance={}",
        query_cpu::display(cold_cpu), snapshot.metadata_bytes, snapshot.index_budget_bytes
    );
    assert!(cold < std::time::Duration::from_secs(2), "cold={cold:?}");
    assert!(
        maximum < std::time::Duration::from_millis(25),
        "warm={maximum:?}"
    );
}

#[test]
fn concurrent_connection_writes_never_mix_plugin_and_feature_generations() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("coherent.db");
    let reader = Database::open(&file).unwrap();
    let make = |version: usize| {
        let title = format!("版本{version}");
        let mut p = plugin(
            "coherent",
            json!([{"code":"same-code","explain":title,"cmds":["same"]}]),
        );
        p.manifest.title = Some(title);
        p
    };
    let p = make(0);
    reader
        .save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    let writer_file = file.clone();
    let writer = std::thread::spawn(move || {
        let db = Database::open(&writer_file).unwrap();
        for version in 1..=40 {
            let p = make(version);
            db.save_plugin_with_features(&p, &p.manifest.features)
                .unwrap();
        }
    });
    for _ in 0..120 {
        let snapshot = reader.feature_catalog_snapshot().unwrap();
        let item = snapshot.find("coherent", "same-code").unwrap();
        assert_eq!(item.plugin_display_name, item.feature.explain);
        assert_eq!(item.display_label, item.feature.explain);
    }
    writer.join().unwrap();
    assert_eq!(
        reader
            .feature_catalog_snapshot()
            .unwrap()
            .find("coherent", "same-code")
            .unwrap()
            .display_label,
        "版本40"
    );
}
