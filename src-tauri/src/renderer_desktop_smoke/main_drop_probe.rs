//! Fixed catalog adjunct. Source/owner authority never comes from the environment flag alone.
use super::{catalog_journey::Harness, fixture_owner, profile::Profile};
use tauri::{AppHandle, Manager};
#[path = "main_drop_probe_owned_fixture.rs"]
mod owned_fixture;
const ENV: &str = "ATOOLS_MAIN_DROP_PROBE";
pub(super) fn requested() -> bool {
    std::env::var(ENV).ok().as_deref() == Some("1")
}
fn valid_flag(flag: Option<&str>, catalog: bool, window_drag: bool) -> bool {
    flag.is_none() || flag == Some("1") && catalog && !window_drag
}
pub(super) fn validate_requested(profile: &Profile) -> Result<(), String> {
    let flag = match std::env::var(ENV) {
        Ok(v) => Some(v),
        Err(std::env::VarError::NotPresent) => None,
        Err(_) => return Err("main-drop-probe-profile-rejected".into()),
    };
    if valid_flag(
        flag.as_deref(),
        profile.catalog_journey,
        profile.window_drag,
    ) {
        Ok(())
    } else {
        Err("main-drop-probe-profile-rejected".into())
    }
}
fn private_owner(profile: &Profile) -> bool {
    use std::os::unix::fs::MetadataExt;
    fixture_owner::verify(profile).is_ok()
        && [
            (profile.root.clone(), 0o700, true),
            (
                profile.root.join(".atools-renderer-smoke-owner.json"),
                0o600,
                false,
            ),
        ]
        .iter()
        .all(|(path, mode, directory)| {
            std::fs::symlink_metadata(path).is_ok_and(|m| {
                !m.file_type().is_symlink()
                    && m.uid() == unsafe { libc::geteuid() }
                    && (m.mode() & 0o777) == *mode
                    && if *directory {
                        m.is_dir()
                    } else {
                        m.is_file() && m.nlink() == 1
                    }
            })
        })
}
pub(crate) fn authorizes(app: &AppHandle) -> bool {
    if !requested() {
        return false;
    }
    let Some(h) = app.try_state::<Harness>() else {
        return false;
    };
    let p = h.profile();
    validate_requested(p).is_ok()
        && p.catalog_journey
        && p.identifier == app.config().identifier
        && private_owner(p)
        && std::fs::read(p.dist.join("build-provenance.json")).is_ok_and(|bytes| {
            bytes
                == include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../packages/ztools-renderer/dist/build-provenance.json"
                ))
        })
}

use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
struct Receipt(Mutex<Value>);
const QUERY: &str = "ATools Catalog";
pub(crate) fn install_reader(app: &AppHandle) {
    if !authorizes(app) {
        return;
    }
    let Some(h) = app.try_state::<Harness>() else {
        return;
    };
    let Ok(root) = serde_json::to_string(&h.profile().root.to_string_lossy()) else {
        return;
    };
    let script = include_str!("main_drop_probe.js").replace("__ROOT__", &root);
    if let Ok(main) = crate::window::main_webview(app) {
        if main.eval(script).is_err() {
            tracing::warn!(diagnostic="main-drop-probe-early-install-eval-rejected", "Early reader installation was not accepted; catalog readiness remains authoritative");
        }
    }
}
enum Action {
    Install,
    Ready,
    Observe,
    Prime,
    Restore,
}
async fn evaluate(app: &AppHandle, action: Action) -> Result<Value, &'static str> {
    if !authorizes(app) {
        return Err("main-drop-probe-owner-rejected");
    }
    let main = crate::window::main_webview(app).map_err(|_| "main-drop-probe-main-missing")?;
    let script = match action {
        Action::Install => {
            let h = app
                .try_state::<Harness>()
                .ok_or("main-drop-probe-owner-rejected")?;
            let root = serde_json::to_string(&h.profile().root.to_string_lossy())
                .map_err(|_| "main-drop-probe-owner-rejected")?;
            include_str!("main_drop_probe.js").replace("__ROOT__", &root)
        }
        action => include_str!("main_drop_probe_action.js").replace(
            "__ACTION__",
            match action {
                Action::Ready => "\"ready\"",
                Action::Observe => "\"observe\"",
                Action::Prime => "\"prime\"",
                Action::Restore => "\"restore\"",
                Action::Install => unreachable!(),
            },
        ),
    };
    let (send, receive) = tokio::sync::oneshot::channel();
    let send = Arc::new(Mutex::new(Some(send)));
    main.eval_with_callback(&script, move |value| {
        if let Some(send) = send.lock().unwrap().take() {
            let _ = send.send(value);
        }
    })
    .map_err(|_| "main-drop-probe-eval-rejected")?;
    let text = tokio::time::timeout(Duration::from_secs(3), receive)
        .await
        .map_err(|_| "main-drop-probe-callback-timeout")?
        .map_err(|_| "main-drop-probe-callback-closed")?;
    if text.len() > 16 * 1024 {
        return Err("main-drop-probe-receipt-oversized");
    }
    serde_json::from_str(&text).map_err(|_| "main-drop-probe-receipt-invalid")
}
fn action_ack(value: &Value) -> Result<(), &'static str> {
    let o = value
        .as_object()
        .filter(|o| o.len() == 2 && o.contains_key("ok") && o.contains_key("error"))
        .ok_or("main-drop-probe-action-receipt-invalid")?;
    if o["ok"] == true && o["error"].is_null() {
        return Ok(());
    }
    if o["ok"] != false {
        return Err("main-drop-probe-action-receipt-invalid");
    }
    Err(match o["error"].as_str() {
        Some("api-unavailable") => "main-drop-probe-api-unavailable",
        Some("wrapper-rejected") => "main-drop-probe-wrapper-rejected",
        Some("install-exception") => "main-drop-probe-install-exception",
        Some("reader-missing") => "main-drop-probe-reader-missing",
        Some("prime-missing") => "main-drop-probe-prime-missing",
        Some("input-missing") => "main-drop-probe-input-missing",
        Some("setter-missing") => "main-drop-probe-setter-missing",
        Some("ready-exception") => "main-drop-probe-ready-exception",
        Some("prime-false") => "main-drop-probe-prime-false",
        Some("prime-exception") => "main-drop-probe-prime-exception",
        Some("restore-false") => "main-drop-probe-restore-false",
        Some("restore-exception") => "main-drop-probe-restore-exception",
        _ => "main-drop-probe-action-receipt-invalid",
    })
}
async fn wait(app: &AppHandle, predicate: impl Fn(&Value) -> bool) -> Result<Value, &'static str> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let value = evaluate(app, Action::Observe).await?;
        if value["invalidContext"] == true {
            return Err("main-drop-probe-context-outside-fixture");
        }
        if predicate(&value) {
            return Ok(value);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("main-drop-probe-observation-timeout");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
pub(in crate::renderer_desktop_smoke) async fn run(
    app: &AppHandle,
    profile: &Profile,
) -> Result<(), &'static str> {
    if !requested() {
        return Ok(());
    }
    if !authorizes(app) {
        return Err("main-drop-probe-owner-rejected");
    }
    let initial = json!({"schemaVersion":1,"kind":"renderer-main-file-drop","inputSource":"rust-injected-native-drop",
 "runId":profile.run_id,"pid":std::process::id(),"root":profile.root,"passed":false,"errors":[],"stagesCompleted":[],
 "observed":{},"contextObservation":"accepted-updateLaunchContext-call",
 "guiAcceptance":"unverified","osDropAcceptance":"unverified"});
    app.manage(Receipt(Mutex::new(initial)));
    match run_inner(app, profile).await {
        Ok(()) => Ok(()),
        Err(error) => {
            if let Some(r) = app.try_state::<Receipt>() {
                r.0.lock().unwrap()["errors"] = json!([error]);
            }
            Err(error)
        }
    }
}
fn update(app: &AppHandle, f: impl FnOnce(&mut Value)) {
    if let Some(r) = app.try_state::<Receipt>() {
        f(&mut r.0.lock().unwrap())
    }
}
fn stage(app: &AppHandle, name: &str) {
    update(app, |r| {
        r["stagesCompleted"]
            .as_array_mut()
            .unwrap()
            .push(json!(name))
    })
}
async fn run_inner(app: &AppHandle, profile: &Profile) -> Result<(), &'static str> {
    let root = profile.root.join("r77-main-drop");
    owned_fixture::create(profile, |_| {})?;
    // Catalog ready has already proven the real input/adapter. Installation is
    // idempotent, but the following side-effecting Prime is dispatched only once.
    action_ack(&evaluate(app, Action::Install).await?)?;
    action_ack(&evaluate(app, Action::Ready).await?)?;
    action_ack(&evaluate(app, Action::Prime).await?)?;
    let before = wait(app, |v| {
        v["query"] == QUERY
            && v["fileCount"] == 0
            && v["context"]["query"] == QUERY
            && v["context"]["files"].as_array().is_some_and(Vec::is_empty)
            && crate::renderer_main_drop::fixture_snapshot(app)["targetRegistered"] == true
    })
    .await?;
    update(
        app,
        |r| {
            r["observed"]["inputBefore"] =
                json!({"query":before["query"],"files":before["context"]["files"]})
        },
    );
    stage(app, "registered");
    let count = crate::renderer_main_drop::fixture_snapshot(app)["nativeAccepted"]
        .as_u64()
        .ok_or("main-drop-probe-native-counts-invalid")?;
    crate::renderer_main_drop::inject_fixture(
        app,
        vec![
            root.join("file.txt"),
            root.join("missing"),
            root.join("folder"),
            root.join("file.txt"),
        ],
    )
    .map_err(|_| "main-drop-probe-injection-rejected")?;
    stage(app, "injected");
    let dropped = wait(app, |v| {
        v["query"] == ""
            && v["fileCount"] == 2
            && v["context"]["query"] == ""
            && v["context"]["files"]
                .as_array()
                .is_some_and(|f| f.len() == 2)
    })
    .await?;
    let native = crate::renderer_main_drop::fixture_snapshot(app);
    let accepted = native["nativeAccepted"]
        .as_u64()
        .is_some_and(|n| n == count + 1);
    if !accepted || native["metadataFiles"] != 2 {
        return Err("main-drop-probe-native-counts-invalid");
    }
    update(app, |r| {
        r["observed"] = json!({"targetRegistered":native["targetRegistered"],"nativeDropAccepted":accepted,"metadataFiles":native["metadataFiles"],
 "mainChipCount":dropped["chipCount"],"mainFileCount":dropped["fileCount"],"chipNames":dropped["chipNames"],
 "launchContextQuery":dropped["context"]["query"],"launchContextFiles":dropped["context"]["files"],
 "inputBefore":r["observed"]["inputBefore"]})
    });
    stage(app, "main-observed");
    action_ack(&evaluate(app, Action::Restore).await?)?;
    let restored = wait(app, |v| {
        v["query"] == QUERY
            && v["fileCount"] == 0
            && v["context"]["query"] == QUERY
            && v["context"]["files"].as_array().is_some_and(Vec::is_empty)
    })
    .await?;
    update(
        app,
        |r| {
            r["observed"]["inputAfterRestore"] =
                json!({"query":restored["query"],"files":restored["context"]["files"]})
        },
    );
    stage(app, "input-restored");
    Ok(())
}
pub(in crate::renderer_desktop_smoke) fn finish(
    app: &AppHandle,
    profile: &Profile,
) -> Result<(), &'static str> {
    if !requested() {
        return Ok(());
    }
    if !authorizes(app) {
        return Err("main-drop-probe-final-owner-rejected");
    }
    let r = app
        .try_state::<Receipt>()
        .ok_or("main-drop-probe-missing-report")?;
    let native = crate::renderer_main_drop::fixture_snapshot(app);
    let mut report = r.0.lock().unwrap();
    report["observed"]["targetRevoked"] = json!(native["targetRegistered"] == false);
    report["observed"]["actualWorkers"] = native["actualWorkers"].clone();
    report["observed"]["pendingBatches"] = native["pendingBatches"].clone();
    let passed = report["errors"] == json!([])
        && report["stagesCompleted"]
            == json!(["registered", "injected", "main-observed", "input-restored"])
        && report["observed"]["targetRegistered"] == true
        && report["observed"]["nativeDropAccepted"] == true
        && report["observed"]["metadataFiles"] == 2
        && report["observed"]["mainChipCount"] == 1
        && report["observed"]["mainFileCount"] == 2
        && report["observed"]["launchContextQuery"] == ""
        && report["observed"]["chipNames"] == json!(["file.txt"])
        && report["observed"]["launchContextFiles"]
            == json!([{"relativePath":"r77-main-drop/file.txt","name":"file.txt","isDirectory":false},{"relativePath":"r77-main-drop/folder","name":"folder","isDirectory":true}])
        && report["observed"]["inputBefore"] == json!({"query":QUERY,"files":[]})
        && report["observed"]["inputAfterRestore"] == json!({"query":QUERY,"files":[]})
        && native["targetRegistered"] == false
        && native["actualWorkers"] == 0
        && native["pendingBatches"] == 0;
    if passed {
        report["stagesCompleted"]
            .as_array_mut()
            .unwrap()
            .push(json!("disposed"));
    } else {
        report["errors"]
            .as_array_mut()
            .unwrap()
            .push(json!("main-drop-probe-incomplete"));
    }
    report["passed"] = json!(passed);
    let bytes =
        serde_json::to_vec_pretty(&*report).map_err(|_| "main-drop-probe-report-invalid")?;
    if bytes.len() > 64 * 1024 {
        return Err("main-drop-probe-report-oversized");
    }
    write_report(profile, &bytes)?;
    if passed {
        Ok(())
    } else {
        Err("main-drop-probe-incomplete")
    }
}

// Pin the verified directory so replacing its path cannot redirect a report write.
fn write_report(profile: &Profile, bytes: &[u8]) -> Result<(), &'static str> {
    use std::{
        io::Write,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
    };
    const ERROR: &str = "main-drop-probe-report-write-failed";
    if !private_owner(profile) {
        return Err("main-drop-probe-final-owner-rejected");
    }
    let root = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(&profile.root)
        .map_err(|_| ERROR)?;
    let pinned = root.metadata().map_err(|_| ERROR)?;
    let same_root = || {
        std::fs::symlink_metadata(&profile.root)
            .is_ok_and(|m| m.is_dir() && m.dev() == pinned.dev() && m.ino() == pinned.ino())
    };
    if !same_root() || !private_owner(profile) {
        return Err(ERROR);
    }
    let fd = unsafe {
        libc::openat(
            root.as_raw_fd(),
            b"main-drop-report.json\0".as_ptr().cast(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(ERROR);
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| ERROR)?;
    if !same_root() || !private_owner(profile) {
        return Err(ERROR);
    }
    Ok(())
}

#[cfg(test)]
#[path = "main_drop_probe_tests.rs"]
mod tests;
