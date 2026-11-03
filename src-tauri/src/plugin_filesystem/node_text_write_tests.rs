use super::handle;
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    sync::mpsc,
    time::Duration,
};
use tempfile::tempdir;

struct WorkerExit(mpsc::Sender<()>);

impl Drop for WorkerExit {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

struct RestoreDirectoryMode(PathBuf);

impl Drop for RestoreDirectoryMode {
    fn drop(&mut self) {
        let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
    }
}

fn request(path: &Path, text: &str) -> Value {
    json!({"method":"writeTextPath","params":{"path":path.as_os_str().to_str().unwrap(),"text":text}})
}

async fn write(path: &Path, text: &str) -> Result<Value, String> {
    handle(&request(path, text)).await
}

#[tokio::test]
async fn creates_and_overwrites_utf8_without_replacing_inode_or_hardlinks() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("文档.md");
    let alias = dir.path().join("alias.md");
    fs::write(&path, "old text that should be truncated").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    fs::hard_link(&path, &alias).unwrap();
    let before = fs::metadata(&path).unwrap();

    assert_eq!(
        write(&path, "\u{feff}你好🧪").await.unwrap(),
        json!({"handled":true})
    );
    let after = fs::metadata(&path).unwrap();
    assert_eq!(after.ino(), before.ino());
    assert_eq!(after.mode() & 0o777, 0o640);
    assert_eq!(fs::read_to_string(&alias).unwrap(), "\u{feff}你好🧪");

    let empty = dir.path().join("empty.txt");
    assert_eq!(write(&empty, "").await.unwrap(), json!({"handled":true}));
    assert_eq!(fs::read(&empty).unwrap(), b"");
}

#[tokio::test]
async fn write_needs_directory_search_and_write_permissions_but_not_read_permission() {
    let dir = tempdir().unwrap();
    let parent = dir.path().join("search-only");
    fs::create_dir(&parent).unwrap();
    let _restore_mode = RestoreDirectoryMode(parent.clone());
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o333)).unwrap();

    let path = parent.join("known.txt");
    assert_eq!(
        write(&path, "created through search-only parent")
            .await
            .unwrap(),
        json!({"handled":true})
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "created through search-only parent"
    );
    assert_eq!(
        write(&path, "overwritten without directory read")
            .await
            .unwrap(),
        json!({"handled":true})
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "overwritten without directory read"
    );
}

#[tokio::test]
async fn exact_byte_limit_is_written_and_oversize_leaves_existing_file_unchanged() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("bounded.txt");
    let exact = "界".repeat((512 * 1024) / "界".len());
    let exact = format!("{exact}xx"); // exactly 512 KiB in UTF-8 bytes
    assert_eq!(exact.len(), 512 * 1024);
    assert_eq!(write(&path, &exact).await.unwrap(), json!({"handled":true}));
    let before = fs::read(&path).unwrap();

    let over = format!("{exact}z");
    assert_eq!(write(&path, &over).await.unwrap(), json!({"handled":false}));
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[tokio::test]
async fn unsupported_leaf_types_and_missing_parent_do_not_create_or_block() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("target.txt");
    fs::write(&target, "target").unwrap();
    let symlink = dir.path().join("link.txt");
    std::os::unix::fs::symlink(&target, &symlink).unwrap();
    let child_dir = dir.path().join("folder");
    fs::create_dir(&child_dir).unwrap();
    let fifo = dir.path().join("pipe");
    let fifo_c = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);

    for path in [&symlink, &child_dir, &fifo] {
        assert_eq!(
            write(path, "must not write").await.unwrap(),
            json!({"handled":false})
        );
    }
    assert_eq!(fs::read_to_string(&target).unwrap(), "target");
    assert_eq!(
        write(&dir.path().join("missing-parent/file"), "x")
            .await
            .unwrap_err(),
        "ERR_ATOOLS_NATIVE_FS:ENOENT"
    );
    assert!(!dir.path().join("missing-parent").exists());
}

#[tokio::test]
async fn schema_path_and_readonly_errors_are_fixed_and_do_not_leak_values() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("readonly.txt");
    fs::write(&path, "private body").unwrap();

    for malformed in [
        json!({"method":"writeTextPath","params":{"path":path,"text":"x","extra":true}}),
        json!({"method":"readTextPath","params":{"path":"/tmp/x","text":"x"}}),
        json!({"method":"writeTextPath","params":{"path":"/tmp/x"}}),
    ] {
        let error = handle(&malformed).await.unwrap_err();
        assert_eq!(error, "ERR_ATOOLS_NATIVE_FS:EINVAL");
        assert!(!error.contains("private body"));
    }
    assert_eq!(
        handle(&request(Path::new("relative.txt"), "x"))
            .await
            .unwrap(),
        json!({"handled":false})
    );
    let too_long = format!("/tmp/{}", "p".repeat(8192));
    assert_eq!(
        handle(&request(Path::new(&too_long), "x")).await.unwrap(),
        json!({"handled":false})
    );

    if unsafe { libc::geteuid() } != 0 {
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        let error = write(&path, "replacement private body").await.unwrap_err();
        assert_eq!(error, "ERR_ATOOLS_NATIVE_FS:EACCES");
        assert!(!error.contains("private body"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "private body");
    }
}

#[tokio::test]
async fn cancelled_or_expired_authorization_wait_does_not_late_create_or_truncate() {
    let dir = tempdir().unwrap();
    let existing = dir.path().join("existing.txt");
    let absent = dir.path().join("absent.txt");
    fs::write(&existing, "keep existing contents").unwrap();

    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (worker_exit_tx, worker_exit_rx) = mpsc::channel();
    let cancellation_request = request(&existing, "must not truncate");
    let cancelled = tokio::spawn(async move {
        let worker_exit = WorkerExit(worker_exit_tx);
        super::handle_authorized_with_deadline(
            &cancellation_request,
            move || {
                let _keep_until_worker_exit = &worker_exit;
                ready_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            },
            Duration::from_secs(2),
        )
        .await
    });
    tokio::task::spawn_blocking(move || ready_rx.recv_timeout(Duration::from_secs(1)).unwrap())
        .await
        .unwrap();
    cancelled.abort();
    let _ = cancelled.await;
    release_tx.send(()).unwrap();
    tokio::task::spawn_blocking(move || {
        worker_exit_rx.recv_timeout(Duration::from_secs(1)).unwrap()
    })
    .await
    .unwrap();
    assert_eq!(
        fs::read_to_string(&existing).unwrap(),
        "keep existing contents"
    );

    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (worker_exit_tx, worker_exit_rx) = mpsc::channel();
    let timeout_request = request(&absent, "must not create");
    let timeout_result = tokio::spawn(async move {
        let worker_exit = WorkerExit(worker_exit_tx);
        super::handle_authorized_with_deadline(
            &timeout_request,
            move || {
                let _keep_until_worker_exit = &worker_exit;
                ready_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            },
            Duration::from_millis(20),
        )
        .await
    });
    tokio::task::spawn_blocking(move || ready_rx.recv_timeout(Duration::from_secs(1)).unwrap())
        .await
        .unwrap();
    assert_eq!(
        timeout_result.await.unwrap().unwrap_err(),
        "ERR_ATOOLS_NATIVE_FS:ETIMEDOUT"
    );
    release_tx.send(()).unwrap();
    tokio::task::spawn_blocking(move || {
        worker_exit_rx.recv_timeout(Duration::from_secs(1)).unwrap()
    })
    .await
    .unwrap();
    assert!(!absent.exists());
}

#[tokio::test]
async fn authorization_failure_does_not_change_existing_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("protected.txt");
    fs::write(&path, "keep this").unwrap();
    let error = super::handle_authorized(&request(&path, "replacement"), || {
        Err("ERR_ATOOLS_NATIVE_FS:EACCES".into())
    })
    .await
    .unwrap_err();
    assert_eq!(error, "ERR_ATOOLS_NATIVE_FS:EACCES");
    assert_eq!(fs::read_to_string(path).unwrap(), "keep this");
}
