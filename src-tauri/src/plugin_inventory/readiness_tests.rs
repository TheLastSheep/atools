use super::{list_plugins_when_ready_with_timeout, PluginInventoryReadiness, PluginSourceKind};
use atools_core::db::Database;
use std::{path::PathBuf, sync::Arc, time::Duration};

struct InventoryFixture {
    _directory: tempfile::TempDir,
    db: Arc<Database>,
    imported_root: PathBuf,
    builtin_root: PathBuf,
}

impl InventoryFixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let db_path = directory.path().join("fixture.sqlite3");
        let db = Arc::new(Database::open(&db_path).unwrap());
        let imported_root = directory.path().join("plugins");
        std::fs::create_dir_all(&imported_root).unwrap();
        let builtin_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("resources/plugins/builtin");
        assert!(builtin_root.join("timestamp/plugin.json").is_file());
        Self {
            _directory: directory,
            db,
            imported_root,
            builtin_root,
        }
    }

    async fn list(
        &self,
        readiness: &PluginInventoryReadiness,
        timeout: Duration,
    ) -> Result<Vec<super::PluginInventoryRecord>, String> {
        list_plugins_when_ready_with_timeout(
            readiness,
            Arc::clone(&self.db),
            self.imported_root.clone(),
            Some(self.builtin_root.clone()),
            timeout,
        )
        .await
    }

    async fn list_with_default_wait(
        &self,
        readiness: &PluginInventoryReadiness,
    ) -> Result<Vec<super::PluginInventoryRecord>, String> {
        super::list_plugins_when_ready(
            readiness,
            Arc::clone(&self.db),
            self.imported_root.clone(),
            Some(self.builtin_root.clone()),
        )
        .await
    }

    async fn load_metadata(&self) -> Result<(), String> {
        crate::builtin_plugins::load_builtin_plugins(
            Arc::clone(&self.db),
            Some(self.builtin_root.clone()),
        )
        .await
        .map_err(|error| error.to_string())
    }

    fn assert_timestamp_inventory(&self, records: &[super::PluginInventoryRecord]) {
        let expected =
            atools_plugin::loader::load_plugin_from_disk(&self.builtin_root.join("timestamp"))
                .unwrap();
        assert_eq!(expected.name, "timestamp");

        let record = records
            .iter()
            .find(|record| record.plugin.id == expected.id)
            .expect("inventory should contain the production-derived timestamp plugin ID");
        assert_eq!(record.plugin.id, expected.id);
        assert_eq!(record.plugin.name, expected.name);
        assert_eq!(record.source_kind, PluginSourceKind::Builtin);
        let expected_feature_codes = expected
            .manifest
            .features
            .iter()
            .map(|feature| feature.code.as_str())
            .collect::<Vec<_>>();
        let actual_feature_codes = record
            .plugin
            .manifest
            .features
            .iter()
            .map(|feature| feature.code.as_str())
            .collect::<Vec<_>>();
        assert!(!expected_feature_codes.is_empty());
        assert_eq!(actual_feature_codes, expected_feature_codes);
    }
}

#[tokio::test]
async fn real_inventory_query_waits_for_builtin_metadata_and_then_returns_timestamp() {
    let fixture = InventoryFixture::new();
    let readiness = PluginInventoryReadiness::pending();
    let completion = readiness.begin_bootstrap().unwrap();
    let query = fixture.list_with_default_wait(&readiness);
    tokio::pin!(query);

    tokio::select! {
        biased;
        result = &mut query => panic!("list_plugins completed before metadata load: {}", result.is_ok()),
        _ = tokio::task::yield_now() => {}
    }
    readiness
        .wait_until_waiting(Duration::from_secs(1))
        .await
        .unwrap();

    fixture.load_metadata().await.unwrap();
    completion.complete(Ok(()));

    let plugins = query.await.unwrap();
    fixture.assert_timestamp_inventory(&plugins);
}

#[tokio::test]
async fn failed_or_dropped_bootstrap_rejects_inventory_query() {
    let fixture = InventoryFixture::new();
    let failed = PluginInventoryReadiness::pending();
    failed
        .begin_bootstrap()
        .unwrap()
        .complete(Err("private loader detail".into()));
    let error = fixture
        .list(&failed, Duration::from_secs(1))
        .await
        .unwrap_err();
    assert_eq!(error, "PLUGIN_INVENTORY_BOOTSTRAP_FAILED");

    let dropped = PluginInventoryReadiness::pending();
    drop(dropped.begin_bootstrap().unwrap());
    let error = fixture
        .list(&dropped, Duration::from_secs(1))
        .await
        .unwrap_err();
    assert_eq!(error, "PLUGIN_INVENTORY_BOOTSTRAP_ABORTED");
}

#[tokio::test]
async fn panic_unwinding_drops_guard_and_rejects_inventory_query() {
    let fixture = InventoryFixture::new();
    let readiness = PluginInventoryReadiness::pending();
    let producer_readiness = readiness.clone();
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _completion = producer_readiness.begin_bootstrap().unwrap();
        panic!("simulated builtin metadata loader panic");
    }));
    assert!(panic.is_err());

    let error = fixture
        .list(&readiness, Duration::from_secs(1))
        .await
        .unwrap_err();
    assert_eq!(error, "PLUGIN_INVENTORY_BOOTSTRAP_PANICKED");
}

#[tokio::test]
async fn one_waiter_timeout_does_not_cancel_bootstrap_or_block_later_inventory_read() {
    let fixture = InventoryFixture::new();
    let readiness = PluginInventoryReadiness::pending();
    let completion = readiness.begin_bootstrap().unwrap();

    let error = fixture.list(&readiness, Duration::ZERO).await.unwrap_err();
    assert_eq!(error, "PLUGIN_INVENTORY_WAIT_TIMEOUT");

    fixture.load_metadata().await.unwrap();
    completion.complete(Ok(()));
    let plugins = fixture
        .list(&readiness, Duration::from_secs(5))
        .await
        .unwrap();
    fixture.assert_timestamp_inventory(&plugins);
}
