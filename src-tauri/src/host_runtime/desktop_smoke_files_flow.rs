//! Private named-pasteboard file URLs through the real HTTP/capability/TaskRun path.
use super::clipboard::NamedClipboard;
use serde_json::{json, Value};
use std::path::Path;

pub(super) struct Fixture {
    pub expected: Value,
    pub forbidden: Vec<String>,
    pub checks: Value,
}
fn check(value: bool, message: &str) -> Result<(), String> {
    if value {
        Ok(())
    } else {
        Err(message.into())
    }
}
async fn post(endpoint: &str, payload: Value) -> Result<(u16, Value), String> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|_| "Files fixture client failed")?
        .post(endpoint)
        .header("Origin", "null")
        .json(&payload)
        .send()
        .await
        .map_err(|_| "Files fixture HTTP failed")?;
    let status = response.status().as_u16();
    Ok((
        status,
        response
            .json()
            .await
            .map_err(|_| "Files fixture response failed")?,
    ))
}
pub(super) async fn run(
    native: &NamedClipboard,
    parent: &Path,
    endpoint: &str,
    db: &atools_core::Database,
) -> Result<Fixture, String> {
    let root = parent.join(format!("copied-files-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).map_err(|_| "Files fixture directory failed")?;
    let file = root.join("  文 件\n🧰.txt");
    let directory = root.join("folder 空格\n");
    let private_contents = format!("PRIVATE_FILE_CONTENTS_{}", uuid::Uuid::new_v4());
    std::fs::write(&file, &private_contents).map_err(|_| "Files fixture creation failed")?;
    std::fs::create_dir(&directory).map_err(|_| "Files fixture creation failed")?;
    let paths: Vec<String> = [&file, &directory]
        .into_iter()
        .map(|p| {
            p.to_str()
                .ok_or("Files fixture path encoding failed")
                .map(str::to_string)
        })
        .collect::<Result<_, _>>()?;
    super::copied_files::write_named(&native.0, &paths)?;
    let expected = json!([
        {"name":"  文 件\n🧰.txt","path":paths[0],"isFile":true,"isDirectory":false},
        {"name":"folder 空格\n","path":paths[1],"isFile":false,"isDirectory":true}
    ]);
    let (status, response) = post(endpoint, json!({"format":"files"})).await?;
    check(
        status == 200 && response["ok"] == true && response["result"] == expected,
        "Named URL read/stat did not preserve exact file metadata",
    )?;
    check(
        !serde_json::to_string(&response)
            .unwrap()
            .contains(&private_contents),
        "File contents escaped metadata response",
    )?;
    let before_invalid = db
        .list_task_runs(1000)
        .map_err(|_| "Files fixture TaskRun query failed")?
        .len();
    for payload in [
        json!({"format":"Files"}),
        json!({"format":"text"}),
        json!({"format":true}),
        json!({"format":"files","text":"forbidden"}),
        json!({"format":"files","extra":true}),
        json!({"method":"readFiles"}),
        json!(["files"]),
    ] {
        check(
            post(endpoint, payload).await?.1["ok"] == false,
            "Unknown file payload was accepted",
        )?;
    }
    check(
        db.list_task_runs(1000)
            .map_err(|_| "Files fixture TaskRun query failed")?
            .len()
            == before_invalid,
        "Malformed file payload entered TaskRun history",
    )?;
    let mut invalid = paths.clone();
    invalid.push(root.join("missing-private-path").to_str().unwrap().into());
    super::copied_files::write_named(&native.0, &invalid)?;
    let response = post(endpoint, json!({"format":"files"})).await?.1;
    check(
        response["ok"] == false && response.get("result").is_none(),
        "Missing file returned a partial successful array",
    )?;
    let raw = serde_json::to_string(&response).unwrap();
    check(
        !invalid.iter().any(|p| raw.contains(p)) && !raw.contains("missing-private-path"),
        "Metadata failure exposed a file path",
    )?;
    super::copied_files::write_named(
        &native.0,
        &vec![paths[0].clone(); super::copied_files::MAX_FILES + 1],
    )?;
    let response = post(endpoint, json!({"format":"files"})).await?.1;
    check(
        response["ok"] == false && response.get("result").is_none(),
        "Oversized native list was truncated into success",
    )?;
    // Restore only this isolated named board for the real frontend synchronous calls.
    super::copied_files::write_named(&native.0, &paths)?;
    let mut forbidden = paths;
    forbidden.extend(invalid);
    forbidden.push(private_contents);
    Ok(Fixture {
        expected,
        forbidden,
        checks: json!({
            "nativeNamedUrlsAndMetadata":true,"spacesUnicodeAndNewlinesPreserved":true,
            "noFileContentsReturned":true,"unknownPayloadsRejectedBeforeTaskRun":true,
            "missingFileAtomicFailureWithoutPath":true,"nativeCountOverflowAtomicFailure":true
        }),
    })
}
pub(super) async fn reject_write(endpoint: &str) -> Result<(), String> {
    check(
        post(endpoint, json!({"format":"files"})).await?.1["ok"] == false,
        "Write authorization allowed a file read",
    )
}
pub(super) async fn reject_closed(endpoint: &str) -> Result<(), String> {
    check(
        post(endpoint, json!({"format":"files"})).await?.0 == 401,
        "Closed file-read credentials remained usable",
    )
}
