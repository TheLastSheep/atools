use super::super::launch::NodeChildrenLaunch;
use super::super::protocol::{read_frame, write_frame};
use crate::sidecar::SidecarError;
use base64::Engine as _;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
use tokio::net::UnixStream;
use tokio::time::timeout;

fn product_node() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../src-tauri/binaries/node-aarch64-apple-darwin")
        .canonicalize()
        .expect("product Node 22.23.3 binary")
}

fn command_env(command: &tokio::process::Command, name: &str) -> String {
    command
        .as_std()
        .get_envs()
        .find(|(key, _)| *key == std::ffi::OsStr::new(name))
        .and_then(|(_, value)| value)
        .expect("managed socket environment value")
        .to_string_lossy()
        .into_owned()
}

fn connect_socket(path: &str) -> UnixStream {
    let socket = std::os::unix::net::UnixStream::connect(path).expect("connect managed socket");
    socket
        .set_nonblocking(true)
        .expect("set client socket nonblocking");
    UnixStream::from_std(socket).expect("convert managed socket client")
}

async fn request(control: &mut UnixStream, id: u64, fields: Value) -> Result<Value, String> {
    let mut request = fields
        .as_object()
        .cloned()
        .ok_or("request must be object")?;
    request.insert("id".into(), json!(id));
    write_frame(control, &Value::Object(request))
        .await
        .map_err(|error| error.to_string())?;
    let response = read_frame(control)
        .await
        .map_err(|error| error.to_string())?
        .ok_or("control owner closed before response")?;
    if response.get("id").and_then(Value::as_u64) != Some(id) {
        return Err("control response id did not match request".into());
    }
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(format!("managed child request rejected: {response}"));
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| "control response omitted result".into())
}

fn spawn_request(file: &str, script: &str, env_pairs: &[&str]) -> Value {
    json!({
        "op":"spawn",
        "file":file,
        "args":[file,"-e",script],
        "envPairs":env_pairs,
        "stdio":["pipe","pipe","pipe"]
    })
}

#[tokio::test]
async fn product_node_child_io_and_owner_close_reap_real_managed_groups() {
    let mut root_command = tokio::process::Command::new("/usr/bin/true");
    let launch = NodeChildrenLaunch::prepare(&mut root_command)
        .expect("prepare managed transport")
        .expect("macOS supports managed socket transport");
    let control_path = command_env(&root_command, "ATOOLS_MANAGED_CHILD_CONTROL_SOCKET");
    let event_path = command_env(&root_command, "ATOOLS_MANAGED_CHILD_EVENT_SOCKET");
    let token = command_env(&root_command, "ATOOLS_MANAGED_CHILD_TOKEN");
    let directory = std::path::Path::new(&control_path)
        .parent()
        .expect("managed socket parent directory")
        .to_path_buf();
    assert!(root_command
        .as_std_mut()
        .status()
        .expect("spawn prepared root")
        .success());
    let owner = launch.start();
    let mut control = connect_socket(&control_path);
    let mut events = connect_socket(&event_path);
    let node = product_node();
    let node = node.to_string_lossy().into_owned();

    let exercise = timeout(Duration::from_secs(12), async {
        write_frame(&mut control, &json!({
            "schemaVersion":1,"role":"control","token":token
        })).await.map_err(|error| error.to_string())?;
        write_frame(&mut events, &json!({
            "schemaVersion":1,"role":"events","token":token
        })).await.map_err(|error| error.to_string())?;
        let ready = read_frame(&mut control)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("control socket closed before ready acknowledgement")?;
        if ready != json!({"schemaVersion":1,"ready":true}) {
            return Err(format!("unexpected control ready frame: {ready}"));
        }

        let child_script = r#"
          if (process.versions.node !== '22.23.3') process.exit(91);
          if (process.env.ATOOLS_TEST_EQUALS !== 'left=right') process.exit(92);
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', value => {
            process.stdout.write(value.toUpperCase());
            process.stderr.write('diag');
          });
        "#;
        let started = request(
            &mut control,
            1,
            spawn_request(&node, child_script, &["ATOOLS_TEST_EQUALS=left=right"]),
        )
        .await?;
        let child_id = started
            .get("childId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or("spawn receipt childId must be an opaque string")?
            .to_owned();
        if started.get("pid").and_then(Value::as_u64).filter(|pid| *pid > 0).is_none() {
            return Err("spawn receipt omitted positive PID".into());
        }

        for (id, stream) in [(2, "stdout"), (3, "stderr")] {
            request(&mut control, id, json!({
                "op":"credit","childId":child_id,"stream":stream,"count":2
            })).await?;
        }
        request(&mut control, 4, json!({
            "op":"write","childId":child_id,"writeId":1,
            "data":base64::engine::general_purpose::STANDARD.encode(b"hello")
        })).await?;
        request(&mut control, 5, json!({"op":"end","childId":child_id,"writeId":2})).await?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut saw_write_ack = false;
        let mut saw_end_ack = false;
        let mut saw_exit = false;
        let mut saw_close = false;
        while !saw_close {
            let event = read_frame(&mut events)
                .await
                .map_err(|error| error.to_string())?
                .ok_or("event channel closed before child close")?;
            if event.get("childId").and_then(Value::as_str) != Some(child_id.as_str()) {
                return Err(format!("event used a noncanonical child handle: {event}"));
            }
            match event.get("event").and_then(Value::as_str) {
                Some("data") => {
                    let data = event.get("data").and_then(Value::as_str).ok_or("data event omitted bytes")?;
                    let bytes = base64::engine::general_purpose::STANDARD.decode(data)
                        .map_err(|error| error.to_string())?;
                    match event.get("stream").and_then(Value::as_str) {
                        Some("stdout") => stdout.extend(bytes),
                        Some("stderr") => stderr.extend(bytes),
                        _ => return Err("data event used an unknown stream".into()),
                    }
                }
                Some("writeAck") => match event.get("writeId").and_then(Value::as_u64) {
                    Some(1) => saw_write_ack = true,
                    Some(2) => saw_end_ack = true,
                    _ => return Err(format!("write acknowledgement had unknown id: {event}")),
                },
                Some("exit") => saw_exit = true,
                Some("end") => {}
                Some("close") => saw_close = true,
                other => return Err(format!("unexpected child event {other:?}: {event}")),
            }
        }
        if stdout != b"HELLO" || stderr != b"diag" || !saw_write_ack || !saw_end_ack || !saw_exit {
            return Err(format!(
                "child stream lifecycle mismatch: stdout={stdout:?}, stderr={stderr:?}, writeAck={saw_write_ack}, endAck={saw_end_ack}, exit={saw_exit}"
            ));
        }

        let idle = r#"process.stdin.resume(); setTimeout(() => process.exit(0), 2500);"#;
        let second = request(&mut control, 6, spawn_request(&node, idle, &[])).await?;
        if second.get("childId").and_then(Value::as_str).is_none() {
            return Err("second child spawn did not return its string handle".into());
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "managed child integration timed out".to_string())
    .and_then(|result| result);

    let cleanup = timeout(Duration::from_secs(4), owner.close())
        .await
        .map_err(|_| "managed child owner close timed out".to_string())
        .and_then(|result| result.map_err(|error: SidecarError| error.to_string()));
    assert!(
        exercise.is_ok(),
        "managed child production integration failed: {exercise:?}"
    );
    assert!(
        cleanup.is_ok(),
        "managed child owner cleanup failed: {cleanup:?}"
    );
    assert!(
        !directory.exists(),
        "managed socket directory leaked after owner close"
    );
}

#[tokio::test]
async fn owner_close_cancels_pending_accept_and_removes_private_socket_directory() {
    let mut root_command = tokio::process::Command::new("/usr/bin/true");
    let launch = NodeChildrenLaunch::prepare(&mut root_command)
        .expect("prepare managed transport")
        .expect("macOS supports managed socket transport");
    let control_path = command_env(&root_command, "ATOOLS_MANAGED_CHILD_CONTROL_SOCKET");
    let directory = PathBuf::from(&control_path)
        .parent()
        .expect("managed socket directory")
        .to_path_buf();
    assert!(root_command
        .as_std_mut()
        .status()
        .expect("spawn prepared root")
        .success());
    let owner = launch.start();
    timeout(Duration::from_secs(1), owner.close())
        .await
        .expect("close cancels pending listener accept")
        .expect("close cleans an unconnected launch");
    assert!(
        !directory.exists(),
        "unconnected private socket directory leaked"
    );
}
