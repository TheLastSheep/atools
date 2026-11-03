use super::{validate_roots, NativeWatcher};
use std::{
    fs,
    os::unix::fs::symlink,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

const EVENT_TIMEOUT: Duration = Duration::from_secs(10);
const QUIET_WINDOW: Duration = Duration::from_millis(1800);

#[test]
fn canonicalizes_parent_aliases_without_following_a_symlink_root() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("Applications");
    let target = temporary.path().join("OtherApplications");
    let link = temporary.path().join("ApplicationsLink");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&target).unwrap();

    let (normalized, _) = validate_roots(std::slice::from_ref(&root)).unwrap();
    assert_eq!(normalized[0], fs::canonicalize(&root).unwrap());

    symlink(&target, &link).unwrap();
    assert!(validate_roots(&[link]).is_err());
    assert!(target.is_dir());
}

fn start_watcher(root: &Path, count: Arc<AtomicUsize>) -> NativeWatcher {
    NativeWatcher::start(
        &[root.to_path_buf()],
        Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        }),
    )
    .expect("private temporary directory should support FSEvents")
}

fn wait_for_count(count: &AtomicUsize, expected_minimum: usize) {
    let deadline = Instant::now() + EVENT_TIMEOUT;
    while Instant::now() < deadline {
        if count.load(Ordering::SeqCst) >= expected_minimum {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        count.load(Ordering::SeqCst) >= expected_minimum,
        "FSEvents did not report the expected private directory change"
    );
}

fn wait_for_quiet(count: &AtomicUsize) {
    let timeout = EVENT_TIMEOUT;
    let deadline = Instant::now() + timeout;
    let mut previous = count.load(Ordering::SeqCst);
    let mut quiet_since = Instant::now();
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
        let current = count.load(Ordering::SeqCst);
        if current != previous {
            previous = current;
            quiet_since = Instant::now();
        } else if quiet_since.elapsed() >= QUIET_WINDOW {
            return;
        }
    }
    panic!("FSEvents callback stream did not settle within the bounded wait");
}

#[test]
fn reports_private_app_add_rename_and_remove() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("Applications");
    fs::create_dir(&root).unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let mut watcher = start_watcher(&root, Arc::clone(&count));
    wait_for_quiet(&count);

    let baseline = count.load(Ordering::SeqCst);
    let original = root.join("OwnedFixture.app");
    fs::create_dir(&original).unwrap();
    wait_for_count(&count, baseline + 1);
    wait_for_quiet(&count);

    let baseline = count.load(Ordering::SeqCst);
    let renamed = root.join("OwnedFixtureRenamed.app");
    fs::rename(&original, &renamed).unwrap();
    wait_for_count(&count, baseline + 1);
    wait_for_quiet(&count);

    let baseline = count.load(Ordering::SeqCst);
    fs::remove_dir(&renamed).unwrap();
    wait_for_count(&count, baseline + 1);
    wait_for_quiet(&count);

    watcher.stop();
    watcher.stop();
}

#[test]
fn reports_nested_directories_but_ignores_bundle_contents_and_out_of_depth_paths() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("Applications");
    let depth_three = root.join("one/two/three");
    let depth_four = depth_three.join("four");
    let app_bundle = root.join("Existing.app");
    fs::create_dir_all(&depth_four).unwrap();
    fs::create_dir(&app_bundle).unwrap();

    let count = Arc::new(AtomicUsize::new(0));
    let mut watcher = start_watcher(&root, Arc::clone(&count));
    wait_for_quiet(&count);

    let baseline = count.load(Ordering::SeqCst);
    fs::create_dir(depth_three.join("NewDirectory")).unwrap();
    wait_for_count(&count, baseline + 1);
    wait_for_quiet(&count);

    let baseline = count.load(Ordering::SeqCst);
    fs::create_dir(app_bundle.join("InternalDirectory")).unwrap();
    wait_for_quiet(&count);
    assert_eq!(count.load(Ordering::SeqCst), baseline);

    fs::write(app_bundle.join("InternalMetadata.plist"), b"owned fixture").unwrap();
    wait_for_quiet(&count);
    assert_eq!(count.load(Ordering::SeqCst), baseline);

    fs::create_dir(depth_four.join("TooDeep")).unwrap();
    wait_for_quiet(&count);
    assert_eq!(count.load(Ordering::SeqCst), baseline);

    watcher.stop();
}

#[test]
fn reports_missing_root_creation_deletion_and_recreation() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("InitiallyMissingApplications");
    assert!(!root.exists());

    let count = Arc::new(AtomicUsize::new(0));
    let mut watcher = start_watcher(&root, Arc::clone(&count));
    wait_for_quiet(&count);

    let baseline = count.load(Ordering::SeqCst);
    fs::create_dir(&root).unwrap();
    wait_for_count(&count, baseline + 1);
    wait_for_quiet(&count);

    let baseline = count.load(Ordering::SeqCst);
    fs::create_dir(root.join("First.app")).unwrap();
    wait_for_count(&count, baseline + 1);
    wait_for_quiet(&count);

    let baseline = count.load(Ordering::SeqCst);
    fs::remove_dir_all(&root).unwrap();
    wait_for_count(&count, baseline + 1);
    wait_for_quiet(&count);

    let baseline = count.load(Ordering::SeqCst);
    fs::create_dir(&root).unwrap();
    wait_for_count(&count, baseline + 1);
    wait_for_quiet(&count);

    let baseline = count.load(Ordering::SeqCst);
    fs::create_dir(root.join("Second.app")).unwrap();
    wait_for_count(&count, baseline + 1);
    wait_for_quiet(&count);

    watcher.stop();
}

#[test]
fn stop_is_idempotent_and_releases_callback_context() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("Applications");
    fs::create_dir(&root).unwrap();

    let captured = Arc::new(());
    let weak_capture = Arc::downgrade(&captured);
    let callback_capture = Arc::clone(&captured);
    let mut watcher = NativeWatcher::start(
        &[root],
        Arc::new(move || {
            let _keep_capture_alive = &callback_capture;
        }),
    )
    .expect("private temporary directory should support FSEvents");
    drop(captured);
    assert!(weak_capture.upgrade().is_some());

    watcher.stop();
    assert!(weak_capture.upgrade().is_none());
    watcher.stop();
    drop(watcher);
    assert!(weak_capture.upgrade().is_none());
}
