//! Synthetic per-document handoff experiment; no production plugin or permission.
#[cfg(test)]
#[path = "plugin_bootstrap_probe/contract_tests.rs"]
mod contract_tests;
#[path = "plugin_bootstrap_probe/protocol.rs"]
mod protocol;
#[path = "plugin_bootstrap_probe/transport.rs"]
mod transport;
#[path = "plugin_bootstrap_probe/validation.rs"]
mod validation;

use atools_lib::plugin_origin_transport::BridgeServer;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{WebviewUrl, WebviewWindowBuilder};

struct Probe {
    nonce: String,
    router: Arc<transport::Router>,
    sender: Mutex<Option<tokio::sync::oneshot::Sender<Value>>>,
}
#[tauri::command]
fn bootstrap_probe_revoke(
    nonce: String,
    id: String,
    state: tauri::State<'_, Probe>,
) -> Result<Value, String> {
    if nonce != state.nonce || id != "a" {
        return Err("Invalid synthetic revocation identity".into());
    }
    Ok(json!({"revoked":state.router.revoke("a")}))
}
#[tauri::command]
fn bootstrap_probe_report(
    nonce: String,
    report: Value,
    state: tauri::State<'_, Probe>,
) -> Result<(), String> {
    if nonce != state.nonce {
        return Err("Invalid synthetic parent report identity".into());
    }
    let text = serde_json::to_string(&report).map_err(|_| "Invalid report")?;
    if text.len() > 256 * 1024
        || text.contains(&state.nonce)
        || state.router.contains_credential(&text)
    {
        return Err("Report exceeds budget or contains a private credential".into());
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
        .filter(|path| path.is_absolute())
        .ok_or_else(|| format!("Missing absolute {flag}"))
}
fn run() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("This experiment requires native macOS WKWebView".into());
    }
    let output = argument("--output")?;
    let root = argument("--fixture-root")?;
    let pages_root = argument("--pages-root")?;
    if output.exists() || root.exists() {
        return Err("Fresh output and private fixture directory required".into());
    }
    std::fs::create_dir(&root).map_err(|_| "Cannot create fixture root")?;
    let run_id = uuid::Uuid::new_v4().to_string();
    let nonce = uuid::Uuid::new_v4().to_string();
    let router = transport::Router::new(&run_id)?;
    let server =
        tauri::async_runtime::block_on(BridgeServer::start_scoped(router.clone(), "host"))?;
    let read = |name: &str| -> Result<String, String> {
        let path = pages_root.join(format!("{name}.html"));
        let metadata =
            std::fs::symlink_metadata(&path).map_err(|_| "Missing synthetic template")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 * 1024 {
            return Err("Invalid synthetic template size/type".into());
        }
        std::fs::read_to_string(path).map_err(|_| "Invalid synthetic UTF-8 template".into())
    };
    let pages = protocol::Pages::new(
        &run_id,
        &nonce,
        read("parent")?,
        read("bootstrap")?,
        read("payload")?,
        read("opaque")?,
        [
            router.endpoint(&server.origin, "a"),
            router.endpoint(&server.origin, "b"),
        ],
    )?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let passed = Arc::new(AtomicBool::new(false));
    let result = passed.clone();
    let protocol_pages = pages.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!(
        "dev.atools.bootstrap-probe.{}",
        uuid::Uuid::new_v4().simple()
    );
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp = None;
    let app = tauri::Builder::default()
        .manage(Probe {
            nonce,
            router: router.clone(),
            sender: Mutex::new(Some(sender)),
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_probe_revoke,
            bootstrap_probe_report
        ])
        .register_uri_scheme_protocol(protocol::SCHEME, move |context, request| {
            protocol_pages.serve(request, context.webview_label())
        })
        .setup(move |app| {
            WebviewWindowBuilder::new(
                app,
                "bootstrap-fixture",
                WebviewUrl::CustomProtocol(pages.parent_url().parse()?),
            )
            .title("ATools isolated page handoff experiment")
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
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                let mut report = validation::validate(
                    browser,
                    &pages.frames,
                    &router.snapshot(),
                    &pages.evidence(),
                );
                report["runId"] = json!(run_id);
                let success = report["status"] == "pass";
                if let Ok(bytes) = serde_json::to_vec_pretty(&report) {
                    use std::io::Write;
                    if let Ok(mut file) = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&output)
                    {
                        if file.write_all(&bytes).is_ok() {
                            result.store(success, Ordering::SeqCst);
                        }
                    }
                }
                drop(server);
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
        Err("Native bootstrap experiment failed; inspect structured report".into())
    }
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
