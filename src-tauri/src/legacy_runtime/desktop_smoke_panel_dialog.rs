//! Dedicated real-picker acceptance evidence. Never installed by ordinary panel/performance fixtures.
#[path = "desktop_smoke_panel_dialog_privacy.rs"]
mod privacy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
use tauri::{AppHandle, Manager};

pub(crate) struct DialogFixture {
    root: PathBuf,
    checkpoint: PathBuf,
    started: Instant,
    stage: Mutex<String>,
    selections: Mutex<Vec<Value>>,
    checkpoints: Mutex<Vec<Value>>,
    stopped: AtomicBool,
}
pub(crate) fn enabled() -> bool {
    std::env::var("ATOOLS_PANEL_DIALOG_ACCEPTANCE").as_deref() == Ok("true")
}
#[cfg(unix)]
fn private_owned(directory: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let value = std::fs::symlink_metadata(directory)
        .map_err(|_| "Private fixture directory unavailable")?;
    if !value.is_dir()
        || value.file_type().is_symlink()
        || value.uid() != unsafe { libc::geteuid() }
        || value.mode() & 0o077 != 0
    {
        return Err("Private fixture directory ownership or mode rejected".into());
    }
    Ok(())
}
#[cfg(not(unix))]
fn private_owned(_: &Path) -> Result<(), String> {
    Err("Real dialog acceptance requires the reviewed macOS fixture".into())
}
impl DialogFixture {
    pub(crate) fn prepare(root: &Path) -> Result<Option<Self>, String> {
        if !enabled() {
            return Ok(None);
        }
        let home = PathBuf::from(std::env::var("HOME").map_err(|_| "Private HOME required")?);
        let home = home
            .canonicalize()
            .map_err(|_| "Private HOME unavailable")?;
        let root = root
            .canonicalize()
            .map_err(|_| "Private fixture root unavailable")?;
        let parent = root.parent().ok_or("Private fixture parent missing")?;
        private_owned(parent)?;
        private_owned(&home)?;
        private_owned(&root)?;
        if home.parent() != Some(parent)
            || !parent.starts_with("/private/tmp")
            || !parent.file_name().is_some_and(|name| {
                name.to_string_lossy()
                    .starts_with("atools-fixture-environment-")
            })
        {
            return Err("Real dialog fixture must share its isolated private HOME parent".into());
        }
        let checkpoint = PathBuf::from(
            std::env::var("ATOOLS_PANEL_DIALOG_CHECKPOINT")
                .map_err(|_| "Checkpoint path required")?,
        );
        if !checkpoint.is_absolute()
            || !checkpoint.parent().is_some_and(Path::is_dir)
            || std::fs::symlink_metadata(&checkpoint)
                .is_ok_and(|m| !m.is_file() || m.file_type().is_symlink())
        {
            return Err("Checkpoint must be an owned regular output path".into());
        }
        let exports = root.join("export-output");
        std::fs::create_dir(&exports).map_err(|_| "Private export directory creation failed")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&exports, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "Private export mode failed")?;
        }
        let fixture = Self {
            root,
            checkpoint,
            started: Instant::now(),
            stage: Mutex::new("ready".into()),
            selections: Mutex::new(Vec::new()),
            checkpoints: Mutex::new(Vec::new()),
            stopped: AtomicBool::new(false),
        };
        fixture.write_checkpoint(json!({"nativeDialogs":0}))?;
        Ok(Some(fixture))
    }
    fn tree(&self) -> PathBuf {
        self.root.join("tree-data")
    }
    fn save(&self) -> PathBuf {
        self.root.join("export-output/tree-data@1x.png")
    }
    fn write_checkpoint(&self, runtime: Value) -> Result<(), String> {
        let stage = self.stage.lock().clone();
        let value = json!({"schemaVersion":1,"control":if stage.starts_with("awaiting-"){"awaiting_root_native_picker_control"}else{"not_waiting_for_native_control"},"stage":stage,
            "treeDirectory":self.tree(),"savePath":self.save(),"elapsedMs":self.started.elapsed().as_secs_f64()*1000.0,
            "runtime":runtime,"selectionEvidence":self.selections.lock().clone(),
            "boundary":"The operator controls genuine OS panels and chooses or cancels; paths are private synthetic fixture targets"});
        let temporary = self
            .checkpoint
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Checkpoint creation failed")?;
        file.write_all(
            &serde_json::to_vec_pretty(&value).map_err(|_| "Checkpoint encoding failed")?,
        )
        .map_err(|_| "Checkpoint write failed")?;
        std::fs::rename(temporary, &self.checkpoint)
            .map_err(|_| "Checkpoint replacement failed".to_string())
    }
}

/// The actual native result is rejected before the original plugin can process it, never replaced.
pub(crate) fn validate_selection(
    app: &AppHandle,
    plugin_id: &str,
    method: &str,
    paths: &[String],
) -> Result<(), String> {
    let Some(fixture) = app.try_state::<DialogFixture>() else {
        return Ok(());
    };
    if plugin_id != "file-tree" || paths.len() > 1 {
        return Err("Private dialog fixture selection rejected".into());
    }
    let accepted = if paths.is_empty() {
        true
    } else {
        let path = Path::new(&paths[0]);
        match method {
            "showOpenDialog" => path.canonicalize().is_ok_and(|p| p == fixture.tree()),
            "showSaveDialog" => {
                path == fixture.save()
                    && std::fs::symlink_metadata(path)
                        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                    && path.parent().and_then(|p| p.canonicalize().ok())
                        == fixture.save().parent().map(Path::to_path_buf)
            }
            _ => false,
        }
    };
    fixture.selections.lock().push(json!({"method":method,"canceled":paths.is_empty(),"count":paths.len(),"acceptedPrivateTarget":accepted,
        "elapsedMs":fixture.started.elapsed().as_secs_f64()*1000.0,"source":"actual native return before private result delivery to original plugin"}));
    if !accepted {
        return Err(
            "Private dialog fixture selection rejected before original file processing".into(),
        );
    }
    Ok(())
}
pub(crate) fn monitor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut previous = Value::Null;
        loop {
            let Some(fixture) = app.try_state::<DialogFixture>() else {
                break;
            };
            if fixture.stopped.load(Ordering::Acquire) {
                break;
            }
            let runtime = crate::plugin_dialog_runtime::runtime_state(&app).await;
            let value = json!({"stage":fixture.stage.lock().clone(),"runtime":runtime,"selectionCount":fixture.selections.lock().len()});
            if value != previous {
                let _ = fixture.write_checkpoint(runtime.clone());
                previous = value;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    });
}
#[tauri::command]
pub(crate) fn native_panel_dialog_fixture(app: AppHandle) -> Result<Value, String> {
    let fixture = app
        .try_state::<DialogFixture>()
        .ok_or("Dedicated dialog fixture is not enabled")?;
    use crate::plugin_dialog_runtime::registry::{tool_name, Access};
    Ok(
        json!({"treeDirectory":fixture.tree(),"savePath":fixture.save(),"privateHomeGuard":true,
        "capabilities":{"data":crate::plugin_data_runtime::registry::tool_name("file-tree"),
            "node":crate::legacy_runtime::registry::tool_name("file-tree"),"dialogOpen":tool_name("file-tree",Access::Open),
            "dialogSave":tool_name("file-tree",Access::Save)},"scope":"genuine original file-tree 1.0.5 UI and OS pickers, private synthetic targets only"}),
    )
}
#[tauri::command]
pub(crate) async fn native_panel_dialog_checkpoint(
    app: AppHandle,
    stage: String,
) -> Result<(), String> {
    if ![
        "authorizing",
        "awaiting-open-cancel",
        "awaiting-open-select",
        "awaiting-save-cancel",
        "awaiting-save-select",
        "complete",
        "failed",
    ]
    .contains(&stage.as_str())
    {
        return Err("Unknown dialog acceptance stage".into());
    }
    let fixture = app
        .try_state::<DialogFixture>()
        .ok_or("Dedicated dialog fixture unavailable")?;
    *fixture.stage.lock() = stage.clone();
    let runtime = crate::plugin_dialog_runtime::runtime_state(&app).await;
    fixture.checkpoints.lock().push(json!({"stage":stage,"runtime":runtime,"elapsedMs":fixture.started.elapsed().as_secs_f64()*1000.0}));
    fixture.write_checkpoint(runtime)
}
fn png_evidence(fixture: &DialogFixture) -> Result<Value, String> {
    let entries = std::fs::read_dir(fixture.root.join("export-output"))
        .map_err(|_| "Export directory evidence unavailable")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Export entries unavailable")?;
    if entries.is_empty() {
        return Ok(json!({"fileCount":0,"source":"actual private output directory read only"}));
    }
    if entries.len() != 1 || entries[0].path() != fixture.save() {
        return Err("Unexpected private export entries".into());
    }
    let meta =
        std::fs::symlink_metadata(fixture.save()).map_err(|_| "Export metadata unavailable")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 8 * 1024 * 1024 {
        return Err("Export file type or byte budget rejected".into());
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(fixture.save())
        .map_err(|_| "Export read failed")?
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Bounded export read failed")?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Export byte budget exceeded".into());
    }
    let signature = bytes.starts_with(b"\x89PNG\r\n\x1a\n");
    if !signature {
        return Err("Original export did not write PNG signature".into());
    }
    let mut reader =
        image::ImageReader::with_format(std::io::Cursor::new(&bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| "Original PNG export failed bounded independent decoding")?;
    Ok(
        json!({"fileCount":1,"actualBytes":bytes.len(),"pngSignature":signature,"width":decoded.width(),"height":decoded.height(),
        "sha256":format!("{:x}",Sha256::digest(&bytes)),"independentDecode":true,"boundedBytes":true,"source":"actual private PNG read and independent Rust image decoder"}),
    )
}
#[tauri::command]
pub(crate) async fn native_panel_dialog_evidence(app: AppHandle) -> Result<Value, String> {
    let fixture = app
        .try_state::<DialogFixture>()
        .ok_or("Dedicated dialog fixture unavailable")?;
    let state = app.state::<crate::state::AppState>();
    let runs = state
        .db
        .list_task_runs(1000)
        .map_err(|_| "TaskRun evidence unavailable")?;
    let dialog_runs:Vec<_>=runs.iter().filter(|run| run.capability_id.starts_with("atools.host.dialog.") && run.input["operation"]=="request")
        .map(|run|json!({"id":run.id,"capability":run.capability_id,"method":run.input["method"],"status":run.status.as_str(),
            "canceled":run.output["canceled"],"count":run.output["count"],"terminal":run.status.is_terminal()})).collect();
    let serialized =
        serde_json::to_string(&runs).map_err(|_| "TaskRun evidence encoding failed")?;
    let private_markers_absent = !serialized.contains(&fixture.root.to_string_lossy().to_string());
    let installation_metadata_verified = state.db.get_plugin("file-tree").is_ok_and(|plugin| {
        plugin.path
            == fixture
                .root
                .join("plugins/file-tree")
                .to_string_lossy()
                .as_ref()
            && plugin.manifest.preload.as_deref() == Some("preload.js")
    });
    let privacy_scan = privacy::inspect(
        &runs,
        &fixture.root.to_string_lossy(),
        &fixture.tree().to_string_lossy(),
        &fixture.save().to_string_lossy(),
        1000,
        installation_metadata_verified,
    );
    let selection_privacy_verified = privacy_scan["selectionPrivacyVerified"] == true;
    let selections = fixture.selections.lock().clone();
    let checkpoints = fixture.checkpoints.lock().clone();
    let runtime = crate::plugin_dialog_runtime::runtime_state(&app).await;
    // The native TaskRun can finish just before the original synchronous file write.
    // Partial/invalid output remains unverified and can never satisfy the final PNG gate.
    let png = png_evidence(&fixture).unwrap_or_else(
        |error| json!({"fileCount":null,"independentDecode":false,"evidenceError":error}),
    );
    Ok(
        json!({"readOnlyEvidence":true,"privateHomeGuard":true,"selectionEvidence":selections,
        "checkpoints":checkpoints,"dialogRequests":dialog_runs,"privateMarkersAbsent":private_markers_absent,"privacyScan":privacy_scan,
        "selectionPrivacyVerified":selection_privacy_verified,
        "runtime":runtime,"png":png,
        "source":"actual SQLite TaskRuns, native returned selections validated before original processing, and private export directory"}),
    )
}
pub(crate) fn finish(app: &AppHandle) {
    if let Some(fixture) = app.try_state::<DialogFixture>() {
        fixture.stopped.store(true, Ordering::Release);
    }
}
