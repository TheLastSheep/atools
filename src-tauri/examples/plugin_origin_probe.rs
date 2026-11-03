//! Standalone synthetic native experiment; never changes the production host policy.
#[cfg(test)]
#[path = "plugin_origin_probe/contract_tests.rs"]
mod contract_tests;
#[path = "plugin_origin_probe/protocol.rs"]
mod protocol;
#[path = "plugin_origin_probe/validation.rs"]
mod validation;

use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct Probe {
    nonce: String,
    entered: Mutex<Vec<String>>,
    sender: Mutex<Option<tokio::sync::oneshot::Sender<Value>>>,
}
#[tauri::command]
fn poc_benign_counter(case_id: String, state: tauri::State<'_, Probe>) -> usize {
    let mut entered = state.entered.lock();
    if entered.len() < 16 {
        entered.push(
            if [
                "parent-positive",
                "a1-wrong-key",
                "a1-missing-key",
                "a2-wrong-key",
                "a2-missing-key",
                "b1-wrong-key",
                "b1-missing-key",
            ]
            .contains(&case_id.as_str())
            {
                case_id
            } else {
                "other".into()
            },
        );
    }
    entered.len()
}
#[tauri::command]
fn origin_probe_report(
    nonce: String,
    report: Value,
    state: tauri::State<'_, Probe>,
) -> Result<(), String> {
    if nonce != state.nonce {
        return Err("Invalid synthetic parent report identity".into());
    }
    let encoded = serde_json::to_string(&report).map_err(|_| "Invalid report")?;
    if encoded.len() > 1024 * 1024 || encoded.contains(&state.nonce) {
        return Err(
            "Synthetic report exceeds budget or includes its private delivery nonce".into(),
        );
    }
    if let Some(sender) = state.sender.lock().take() {
        let _ = sender.send(report);
    }
    Ok(())
}
fn argument(flag: &str) -> Result<PathBuf, String> {
    let args: Vec<_> = std::env::args().collect();
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| PathBuf::from(&pair[1]))
        .filter(|p| p.is_absolute())
        .ok_or_else(|| format!("Missing absolute {flag}"))
}
fn run() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("This experiment requires native macOS WKWebView".into());
    }
    let output = argument("--output")?;
    let root = argument("--fixture-root")?;
    let pages_root = argument("--pages-root")?;
    let library = argument("--library")?;
    if output.exists() || root.exists() {
        return Err("Fresh output and fixture directory required".into());
    }
    std::fs::create_dir(&root).map_err(|_| "Cannot create synthetic fixture root")?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let run_id = uuid::Uuid::new_v4().to_string();
    let read = |path: PathBuf, limit: u64| -> Result<Vec<u8>, String> {
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| "Synthetic source missing")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
            return Err("Invalid synthetic source budget".into());
        }
        std::fs::read(path).map_err(|_| "Cannot read synthetic source".into())
    };
    let parent = String::from_utf8(read(pages_root.join("parent.html"), 64 * 1024)?)
        .map_err(|_| "Invalid parent UTF-8")?;
    let child = String::from_utf8(read(pages_root.join("child.html"), 64 * 1024)?)
        .map_err(|_| "Invalid child UTF-8")?;
    let pages = protocol::Pages::new(&run_id, &nonce, parent, child, read(library, 512 * 1024)?)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let passed = Arc::new(AtomicBool::new(false));
    let result = passed.clone();
    let protocol_pages = pages.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier =
        format!("dev.atools.origin-probe.{}", uuid::Uuid::new_v4().simple());
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp = None;
    let app = tauri::Builder::default()
        .manage(Probe {
            nonce,
            entered: Mutex::new(Vec::new()),
            sender: Mutex::new(Some(sender)),
        })
        .invoke_handler(tauri::generate_handler![
            poc_benign_counter,
            origin_probe_report
        ])
        .register_uri_scheme_protocol(protocol::SCHEME, move |context, request| {
            protocol_pages.serve(request, context.webview_label())
        })
        .setup(move |app| {
            WebviewWindowBuilder::new(
                app,
                "origin-fixture",
                WebviewUrl::CustomProtocol(pages.parent_url().parse()?),
            )
            .title("ATools isolated origin feasibility")
            .inner_size(800.0, 600.0)
            .incognito(true)
            .data_directory(root.join("webview"))
            .build()?;
            let app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let browser = match tokio::time::timeout(
                    std::time::Duration::from_secs(35),
                    receiver,
                )
                .await
                {
                    Ok(Ok(report)) => report,
                    _ => {
                        json!({"error":"Synthetic browser report did not arrive within 35 seconds"})
                    }
                };
                // A native counter snapshot, rather than absent JS callbacks,
                // proves whether malformed raw WK packets entered a command.
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let entered = app.state::<Probe>().entered.lock().clone();
                let mut report =
                    validation::validate(browser, &pages.frames, &entered, &output, &run_id);
                report["runId"] = json!(run_id);
                report["requests"] = json!(pages.request_evidence());
                if report["requests"]["truncated"] == true {
                    report["status"] = json!("failed");
                    report["errors"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!("Native request observation exceeded its budget"));
                }
                let success = report["status"] == "pass";
                if let Ok(bytes) = serde_json::to_vec_pretty(&report) {
                    use std::io::Write;
                    if let Ok(mut file) = std::fs::OpenOptions::new()
                        .create_new(true)
                        .write(true)
                        .open(&output)
                    {
                        if file.write_all(&bytes).is_ok() {
                            result.store(success, Ordering::SeqCst);
                        }
                    }
                }
                app.exit(if success { 0 } else { 1 });
            });
            Ok(())
        })
        .build(context)
        .map_err(|_| "Cannot build isolated native experiment")?;
    app.run(|_, _| {});
    if passed.load(Ordering::SeqCst) {
        Ok(())
    } else {
        Err("Native origin feasibility did not pass; inspect the structured report".into())
    }
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
