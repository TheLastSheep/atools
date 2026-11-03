use super::*;
use atools_core::task_run::{TaskRunInitiatorType, TaskRunStatus};
use serde_json::json;
use std::io::Write;
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::sync::oneshot;

fn check(ok: bool, message: &'static str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}
async fn receive<T>(rx: oneshot::Receiver<T>, label: &'static str) -> Result<T, String> {
    tokio::time::timeout(std::time::Duration::from_secs(15), rx)
        .await
        .map_err(|_| label.to_string())?
        .map_err(|_| label.to_string())
}
fn synthetic_intent(app: &AppHandle, paths: Vec<PathBuf>) -> Result<String, String> {
    super::super::on_native_drop(app, "main", paths, 10.0, 20.0, 1.0);
    let runtime = super::super::manager(app)?;
    let id = {
        let store = runtime.store.lock();
        store
            .selections
            .values()
            .find(|selection| selection.window == "main")
            .map(|selection| selection.id.clone())
    };
    id.ok_or_else(|| "Synthetic native intent was not queued".into())
}
fn write_pattern_file(path: &Path, size: usize, byte: u8) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "Max payload fixture file create failed")?;
    let block = [byte; 32 * 1024];
    let mut remaining = size;
    while remaining > 0 {
        let count = remaining.min(block.len());
        file.write_all(&block[..count])
            .map_err(|_| "Max payload fixture file write failed")?;
        remaining -= count;
    }
    file.sync_all()
        .map_err(|_| "Max payload fixture file sync failed".to_string())
}
fn verify_production_limits(root: &Path) -> Result<Value, String> {
    use super::super::{
        read,
        types::{MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES},
    };
    let dir = root.join("limit-fixtures");
    std::fs::create_dir(&dir).map_err(|_| "Limit fixture directory failed")?;
    let count_paths = (0..=MAX_FILES)
        .map(|i| dir.join(format!("count-{i}.bin")))
        .collect::<Vec<_>>();
    check(
        read::validate_count(&count_paths).err().as_deref() == Some("FILE_DROP_COUNT"),
        "File count cap changed",
    )?;
    let single = dir.join("single.bin");
    std::fs::File::create(&single)
        .and_then(|file| file.set_len(MAX_FILE_BYTES as u64 + 1))
        .map_err(|_| "Single-file limit fixture failed")?;
    check(
        read::read_paths(vec![single.clone()], || Ok(()))
            .err()
            .as_deref()
            == Some("FILE_DROP_FILE_LIMIT"),
        "Per-file cap changed",
    )?;
    let first = dir.join("aggregate-a.bin");
    let second = dir.join("aggregate-b.bin");
    let third = dir.join("aggregate-c.bin");
    for path in [&first, &second] {
        std::fs::File::create(path)
            .and_then(|file| file.set_len(MAX_FILE_BYTES as u64))
            .map_err(|_| "Aggregate limit fixture failed")?;
    }
    std::fs::write(&third, b"x").map_err(|_| "Aggregate limit fixture failed")?;
    check(
        read::read_paths(
            vec![first.clone(), second.clone(), third.clone()],
            || Ok(()),
        )
        .err()
        .as_deref()
            == Some("FILE_DROP_LIMIT"),
        "Aggregate cap changed",
    )?;
    for path in count_paths
        .into_iter()
        .chain([single, first, second, third])
    {
        let _ = std::fs::remove_file(path);
    }
    std::fs::remove_dir(dir).map_err(|_| "Limit fixture cleanup failed")?;
    Ok(
        json!({"maxFiles":MAX_FILES,"maxFileBytes":MAX_FILE_BYTES,"maxTotalBytes":MAX_TOTAL_BYTES,
        "countOverflowRejected":true,"singleFileOverflowRejected":true,"aggregateOverflowRejected":true}),
    )
}
fn read_expected_task(
    app: &AppHandle,
    run_id: &str,
    request_id: &str,
    tool: &str,
) -> Result<atools_core::task_run::TaskRun, String> {
    let db = &app.state::<AppState>().db;
    let run = db
        .get_task_run(run_id)
        .map_err(|_| "TaskRun lookup failed")?
        .ok_or("TaskRun missing")?;
    check(
        run.capability_id == tool
            && run.initiator.kind == TaskRunInitiatorType::Human
            && run.initiator.client_id.as_deref() == Some("atools-ui")
            && run.input == json!({"operation":"read","requestId":request_id}),
        "TaskRun audit identity changed",
    )?;
    Ok(run)
}
fn assert_audit_private(
    app: &AppHandle,
    root: &Path,
    names: &[&str],
    bodies: &[&[u8]],
) -> Result<(), String> {
    let db = &app.state::<AppState>().db;
    let task_runs = db
        .list_task_runs(32)
        .map_err(|_| "TaskRun audit query failed")?;
    let audits = db
        .list_audit_entries(32)
        .map_err(|_| "Audit query failed")?;
    let serialized = format!(
        "{}{}",
        serde_json::to_string(&task_runs).unwrap_or_default(),
        serde_json::to_string(&audits).unwrap_or_default()
    );
    check(
        !serialized.contains(root.to_string_lossy().as_ref()),
        "Audit persisted a fixture path",
    )?;
    check(
        !serialized.contains("ATFD")
            && !serialized.contains("leaseId")
            && !serialized.contains("expiresAt"),
        "Audit persisted binary header metadata",
    )?;
    for name in names {
        check(!serialized.contains(name), "Audit persisted a file name")?;
    }
    for body in bodies {
        let text = String::from_utf8_lossy(body);
        if !text.trim().is_empty() {
            check(
                !serialized.contains(text.as_ref()),
                "Audit persisted file content",
            )?;
        }
    }
    check(
        task_runs.iter().all(|run| {
            run.input.as_object().is_some_and(|o| {
                o.len() == 2 && o.contains_key("operation") && o.contains_key("requestId")
            })
        }),
        "Unexpected TaskRun input fields",
    )
}

pub(super) async fn run(
    app: &AppHandle,
    window: &WebviewWindow,
    plugin: &Plugin,
    root: &Path,
    ready: oneshot::Receiver<()>,
    prepared_rx: oneshot::Receiver<Value>,
    delivered_rx: oneshot::Receiver<Value>,
    cancel_prepared_rx: oneshot::Receiver<Value>,
    cancelled_rx: oneshot::Receiver<Value>,
    max_payload_case: bool,
    max_prepared_rx: oneshot::Receiver<Value>,
    max_delivered_rx: oneshot::Receiver<Value>,
) -> Result<Value, String> {
    let db = app.state::<AppState>().db.clone();
    receive(ready, "Fixture page did not load").await?;
    let limits = verify_production_limits(root)?;
    let files_dir = root.join("fixture-files");
    std::fs::create_dir(&files_dir).map_err(|_| "Fixture files directory failed")?;
    let bodies: [&[u8]; 2] = [
        "first line\n你好 🌊".as_bytes(),
        "second\nfile ✓".as_bytes(),
    ];
    let names = ["first.txt", "second.txt"];
    let paths = names
        .iter()
        .zip(bodies.iter())
        .map(|(name, body)| {
            let path = files_dir.join(name);
            std::fs::write(&path, body)
                .map(|_| path)
                .map_err(|_| "Fixture file creation failed")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let intent = synthetic_intent(app, paths)?;
    let instance = uuid::Uuid::new_v4().to_string();
    let plugin_id = plugin.id.clone();
    let init = json!({"intentId":intent,"instanceId":instance,"pluginId":plugin_id});
    window
        .eval(&format!("window.fixturePrepare({init})"))
        .map_err(|_| "Prepare invocation setup failed")?;
    let pending = receive(prepared_rx, "Prepare invocation missing").await?;
    let request_id = pending["requestId"]
        .as_str()
        .ok_or("Prepare did not return a private request")?
        .to_owned();
    let run_id = pending["runId"]
        .as_str()
        .ok_or("Prepare did not return its TaskRun")?
        .to_owned();
    let tool = super::super::registry::tool_name(&plugin.id);
    check(
        pending["error"] == false
            && pending["permissionRequired"] == true
            && pending["tool"] == tool,
        "Prepare did not use the audited permission gate",
    )?;
    let run = read_expected_task(app, &run_id, &request_id, &tool)?;
    check(
        run.status == TaskRunStatus::AwaitingPermission,
        "Prepare did not leave an approval-pending TaskRun",
    )?;
    let pending_permission = crate::permission_requests::find_for_run(app, &run_id)
        .ok_or("Permission queue did not retain the exact run")?;
    check(
        pending_permission.client_id == "atools-ui"
            && pending_permission.tool_name == tool
            && pending_permission.arguments == run.input
            && pending_permission.scopes == vec![atools_core::agent::PermissionScope::FileRead],
        "Permission queue identity or scope changed",
    )?;
    check(
        run.output["permission_required"] == true && run.output["arguments"] == run.input,
        "Permission queue input changed",
    )?;
    let resumed = crate::agent_tools::resume_tool_with_audit(
        app,
        &db,
        "atools-ui",
        &tool,
        run.input.clone(),
        true,
        Some(&run_id),
    )
    .await;
    check(
        !resumed.is_error && resumed.structured_content["runId"] == run_id,
        "Exact Once approval did not resume its original TaskRun",
    )?;
    check(
        !db.is_agent_tool_granted("atools-ui", &tool)
            .map_err(|_| "Grant state lookup failed")?,
        "Once approval persisted a saved grant",
    )?;
    crate::permission_requests::remove_for_run(app, &run_id);
    let terminal = read_expected_task(app, &run_id, &request_id, &tool)?;
    check(
        terminal.status == TaskRunStatus::Succeeded
            && terminal.output["requestId"] == request_id
            && terminal.output["readCompleted"] == true
            && terminal.output["fileCount"] == 2
            && terminal.output["totalBytes"] == bodies.iter().map(|v| v.len()).sum::<usize>(),
        "Successful audited read summary changed",
    )?;
    let expected = json!([
        {"name":names[0],"bytes":bodies[0]}, {"name":names[1],"bytes":bodies[1]}
    ]);
    let deliver = json!({"requestId":request_id,"pluginId":plugin.id,"instanceId":instance,
        "wrongInstanceId":uuid::Uuid::new_v4().to_string(),"expected":expected});
    window
        .eval(&format!("window.fixtureDeliver({deliver})"))
        .map_err(|_| "Delivery invocation setup failed")?;
    let received = receive(delivered_rx, "Binary delivery result missing").await?;
    check(
        received["wrongOwnerRejected"] == true
            && received["arrayBuffer"] == true
            && received["headerValid"] == true
            && received["exactBytes"] == true
            && received["secondTakeRejected"] == true,
        "Raw binary delivery contract failed",
    )?;
    let total_bytes = bodies.iter().map(|v| v.len()).sum::<usize>();
    check(
        received["fileCount"] == 2
            && received["totalBytes"] == total_bytes
            && total_bytes <= 8 * 1024 * 1024,
        "Delivered payload exceeded a declared bound",
    )?;
    let names_str = [names[0], names[1]];
    assert_audit_private(app, root, &names_str, &bodies)?;

    let cancel_file = files_dir.join("cancelled.txt");
    std::fs::write(&cancel_file, b"must not be delivered")
        .map_err(|_| "Cancellation fixture file failed")?;
    let cancel_intent = synthetic_intent(app, vec![cancel_file])?;
    let cancel_init = json!({"intentId":cancel_intent,"instanceId":instance,"pluginId":plugin.id});
    window
        .eval(&format!("window.fixtureCancelledPrepare({cancel_init})"))
        .map_err(|_| "Cancellation prepare setup failed")?;
    let pending_cancel = receive(cancel_prepared_rx, "Cancellation prepare result missing").await?;
    let cancel_request = pending_cancel["requestId"]
        .as_str()
        .ok_or("Cancellation request missing")?
        .to_owned();
    let cancel_run = pending_cancel["runId"]
        .as_str()
        .ok_or("Cancellation TaskRun missing")?
        .to_owned();
    let cancel_task = read_expected_task(app, &cancel_run, &cancel_request, &tool)?;
    check(
        pending_cancel["permissionRequired"] == true
            && cancel_task.status == TaskRunStatus::AwaitingPermission,
        "Cancellation case did not await approval",
    )?;
    let close = json!({"pluginId":plugin.id,"instanceId":instance,"requestId":cancel_request});
    window
        .eval(&format!("window.fixtureCloseAndTryDelivery({close})"))
        .map_err(|_| "Cancellation close setup failed")?;
    let cancelled = receive(cancelled_rx, "Cancellation result missing").await?;
    check(
        cancelled["closed"] == true && cancelled["deliveryRejected"] == true,
        "Closed request delivered bytes",
    )?;
    let cancelled_task = read_expected_task(app, &cancel_run, &cancel_request, &tool)?;
    check(
        cancelled_task.status == TaskRunStatus::Cancelled,
        "Close did not cancel the pending audited run",
    )?;
    let replay = crate::agent_tools::resume_tool_with_audit(
        app,
        &db,
        "atools-ui",
        &tool,
        cancelled_task.input,
        true,
        Some(&cancel_run),
    )
    .await;
    check(replay.is_error, "Closed TaskRun could be resumed")?;
    assert_audit_private(app, root, &[names[0], names[1], "cancelled.txt"], &bodies)?;
    let max_payload = if max_payload_case {
        Some(
            run_max_payload_case(
                app,
                window,
                plugin,
                root,
                &db,
                &tool,
                &instance,
                max_prepared_rx,
                max_delivered_rx,
            )
            .await?,
        )
    } else {
        None
    };
    Ok(
        json!({"passed":true,"syntheticNativeIntent":true,"osDropPerformed":false,
        "permissionOnceResumedExactRun":true,"rawArrayBuffer":true,
        "wrongOwnerRejected":true,"oneShotDelivery":true,"closeCancelledPendingRun":true,
        "auditRedacted":true,"limits":limits,"maxPayloadCase":max_payload}),
    )
}

async fn run_max_payload_case(
    app: &AppHandle,
    window: &WebviewWindow,
    plugin: &Plugin,
    root: &Path,
    db: &Arc<Database>,
    tool: &str,
    instance: &str,
    prepared_rx: oneshot::Receiver<Value>,
    delivered_rx: oneshot::Receiver<Value>,
) -> Result<Value, String> {
    use super::super::types::{MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES};
    check(
        MAX_FILE_BYTES == 4 * 1024 * 1024 && MAX_TOTAL_BYTES == 8 * 1024 * 1024 && MAX_FILES >= 2,
        "Production max payload limits differ from fixture case",
    )?;
    let dir = root.join("max-payload-files");
    std::fs::create_dir(&dir).map_err(|_| "Max payload fixture directory failed")?;
    let names = ["max-pattern-a.bin", "max-pattern-b.bin"];
    let patterns = [0x35_u8, 0xc7_u8];
    let paths = names
        .iter()
        .zip(patterns.iter())
        .map(|(name, byte)| {
            let path = dir.join(name);
            write_pattern_file(&path, MAX_FILE_BYTES, *byte).map(|_| path)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let intent = synthetic_intent(app, paths)?;
    let init = json!({"intentId":intent,"instanceId":instance,"pluginId":plugin.id});
    window
        .eval(&format!("window.fixtureMaxPrepare({init})"))
        .map_err(|_| "Max payload prepare invocation setup failed")?;
    let pending = receive(prepared_rx, "Max payload prepare result missing").await?;
    let request_id = pending["requestId"]
        .as_str()
        .ok_or("Max payload request missing")?
        .to_owned();
    let run_id = pending["runId"]
        .as_str()
        .ok_or("Max payload TaskRun missing")?
        .to_owned();
    check(
        pending["error"] == false
            && pending["permissionRequired"] == true
            && pending["tool"] == tool,
        "Max payload prepare did not use the audited permission gate",
    )?;
    let run = read_expected_task(app, &run_id, &request_id, tool)?;
    check(
        run.status == TaskRunStatus::AwaitingPermission,
        "Max payload TaskRun did not await approval",
    )?;
    let permission = crate::permission_requests::find_for_run(app, &run_id)
        .ok_or("Max payload permission queue did not retain the exact run")?;
    check(
        permission.client_id == "atools-ui"
            && permission.tool_name == tool
            && permission.arguments == run.input
            && permission.scopes == vec![atools_core::agent::PermissionScope::FileRead],
        "Max payload permission identity or scope changed",
    )?;
    let resumed = crate::agent_tools::resume_tool_with_audit(
        app,
        db,
        "atools-ui",
        tool,
        run.input.clone(),
        true,
        Some(&run_id),
    )
    .await;
    check(
        !resumed.is_error && resumed.structured_content["runId"] == run_id,
        "Max payload Once approval did not resume its TaskRun",
    )?;
    check(
        !db.is_agent_tool_granted("atools-ui", tool)
            .map_err(|_| "Max payload grant lookup failed")?,
        "Max payload Once approval persisted a saved grant",
    )?;
    crate::permission_requests::remove_for_run(app, &run_id);
    let terminal = read_expected_task(app, &run_id, &request_id, tool)?;
    check(
        terminal.status == TaskRunStatus::Succeeded
            && terminal.output["readCompleted"] == true
            && terminal.output["fileCount"] == 2
            && terminal.output["totalBytes"] == MAX_TOTAL_BYTES,
        "Max payload TaskRun summary changed",
    )?;
    let expected = names
        .iter()
        .zip(patterns.iter())
        .enumerate()
        .map(|(index, (name, byte))| {
            json!({
                "name":name,"size":MAX_FILE_BYTES,"byte":byte,"offset":index * MAX_FILE_BYTES
            })
        })
        .collect::<Vec<_>>();
    let metadata = json!({"pluginId":plugin.id,"instanceId":instance,"requestId":request_id,"expected":expected});
    window
        .eval(&format!("window.fixtureMaxDeliver({metadata})"))
        .map_err(|_| "Max payload delivery invocation setup failed")?;
    let received = receive(delivered_rx, "Max payload binary result missing").await?;
    check(
        received["arrayBuffer"] == true
            && received["headerValid"] == true
            && received["exactPattern"] == true
            && received["fileCount"] == 2
            && received["totalBytes"] == MAX_TOTAL_BYTES
            && received["elapsedMs"].is_number(),
        "Max payload binary delivery or byte pattern failed",
    )?;
    assert_audit_private(app, root, &names, &[])?;
    Ok(
        json!({"requested":true,"arrayBuffer":true,"exactPattern":true,
        "fileCount":2,"byteCount":MAX_TOTAL_BYTES,"elapsedMs":received["elapsedMs"]}),
    )
}
