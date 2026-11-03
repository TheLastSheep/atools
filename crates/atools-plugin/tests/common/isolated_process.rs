//! Re-exec only known builtin tool tests with a private user/config/temp profile.
//! No process-global environment changes can leak across parallel tests.
use std::{ffi::OsString, path::PathBuf, process::Command};

pub fn reexec(test: &str) -> bool {
    if std::env::var("ATOOLS_PRELOAD_TEST_CHILD").ok().as_deref() == Some(test) {
        let root =
            PathBuf::from(std::env::var_os("ATOOLS_PRELOAD_TEST_ROOT").expect("private test root"));
        assert_eq!(
            std::env::var_os("HOME"),
            Some(root.join("home").into_os_string())
        );
        assert_eq!(
            std::env::var_os("TMPDIR"),
            Some(root.join("tmp").into_os_string())
        );
        assert!(root.is_dir());
        return false;
    }
    let profile = tempfile::Builder::new()
        .prefix("atools-builtin-test-")
        .tempdir()
        .unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap());
    child
        .arg("--exact")
        .arg(test)
        .arg("--nocapture")
        .env_clear();
    for key in ["PATH", "SystemRoot", "WINDIR", "ATOOLS_NODE_BINARY"] {
        if let Some(value) = std::env::var_os(key) {
            child.env(key, value);
        }
    }
    child
        .env("LANG", "C.UTF-8")
        .env("ATOOLS_PRELOAD_TEST_CHILD", test)
        .env("ATOOLS_PRELOAD_TEST_ROOT", profile.path());
    for (folder, keys) in [
        ("home", &["HOME", "USERPROFILE"][..]),
        ("tmp", &["TMPDIR", "TMP", "TEMP"][..]),
        (
            "config",
            &["XDG_CONFIG_HOME", "XDG_CONFIG_DIRS", "APPDATA"][..],
        ),
        (
            "data",
            &["XDG_DATA_HOME", "XDG_DATA_DIRS", "LOCALAPPDATA"][..],
        ),
        ("cache", &["XDG_CACHE_HOME"][..]),
        ("state", &["XDG_STATE_HOME"][..]),
        ("runtime", &["XDG_RUNTIME_DIR"][..]),
    ] {
        let directory = profile.path().join(folder);
        std::fs::create_dir(&directory).unwrap();
        for key in keys {
            child.env(key, OsString::from(&directory));
        }
    }
    let status = child.status().expect("isolated builtin test child");
    assert!(status.success(), "Isolated builtin test failed: {status}");
    let path = profile.path().to_path_buf();
    drop(profile);
    assert!(!path.exists(), "Builtin test profile was not removed");
    true
}
