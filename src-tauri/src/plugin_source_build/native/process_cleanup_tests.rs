use super::*;
use std::collections::BTreeSet;
use std::os::unix::fs::PermissionsExt;

fn stages() -> BTreeSet<PathBuf> {
    let root = std::env::temp_dir().canonicalize().unwrap();
    fs::read_dir(root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("atools-source-build-")
        })
        .map(|entry| entry.path())
        .collect()
}

#[tokio::test]
#[ignore = "explicit private macOS original stage cleanup and no-import gate"]
async fn locked_untrusted_child_blocks_prepared_package_and_records_recovery() {
    let tools = tools();
    let (source,plan)=fixture(&tools,"import fs from 'node:fs'; export default {plugins:[{name:'lock',closeBundle(){fs.mkdirSync('locked');fs.chmodSync('locked',0);}}]};");
    let revision = staging::source_digest(source.path(), &AtomicBool::new(false))
        .unwrap()
        .0;
    let signal = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let before = stages();
    let result = build(
        plan,
        tools.node,
        Arc::new(AtomicBool::new(false)),
        finished.clone(),
        signal.clone(),
        revision.clone(),
    )
    .await;
    assert!(matches!(result,Err(error)if error=="SOURCE_BUILD_CLEANUP_UNCONFIRMED"));
    assert!(signal.load(Ordering::Acquire) && finished.load(Ordering::Acquire));
    assert_eq!(
        staging::source_digest(source.path(), &AtomicBool::new(false))
            .unwrap()
            .0,
        revision
    );
    let created = stages().difference(&before).cloned().collect::<Vec<_>>();
    assert_eq!(created.len(), 1);
    let bytes =
        staging::read_regular(&created[0].join(".atools-cleanup-recovery.json"), 1024).unwrap();
    let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let name = data["workspace"].as_str().unwrap();
    uuid::Uuid::parse_str(name.strip_prefix("atools-source-build-").unwrap()).unwrap();
    let owned = std::env::temp_dir().canonicalize().unwrap().join(name);
    let locked = owned.join("work/locked");
    assert!(fs::symlink_metadata(&locked).unwrap().is_dir());
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    fs::remove_dir_all(owned).unwrap();
}
