use atools_plugin::legacy_node::LegacyNodeSession;
use serde_json::json;
use std::path::Path;
use std::time::Duration;

const LOGO: &[u8] = include_bytes!("../../../ZTools-plugins/plugins/calculation-paper/logo.png");

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as usize;
        let b = chunk.get(1).copied().unwrap_or(0) as usize;
        let c = chunk.get(2).copied().unwrap_or(0) as usize;
        output.push(TABLE[a >> 2] as char);
        output.push(TABLE[((a & 3) << 4) | (b >> 4)] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((b & 15) << 2) | (c >> 6)] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[c & 63] as char
        } else {
            '='
        });
    }
    output
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(unix)]
#[tokio::test]
async fn bounded_png_path_uses_real_node_rpc_and_closes_file_handles() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("preload.cjs"),
        "throw Error('not executed')",
    )
    .unwrap();
    std::fs::write(
        temp.path().join("fd_probe.cjs"),
        r#"
      const fs = require('node:fs');
      module.exports = { countOpenDescriptors() { return fs.readdirSync('/dev/fd').length; } };
    "#,
    )
    .unwrap();
    let valid = temp.path().join("valid.png");
    std::fs::write(&valid, LOGO).unwrap();
    let session = LegacyNodeSession::start("bounded-png", temp.path(), Path::new("preload.cjs"))
        .await
        .unwrap();
    let probe = session
        .request("require", json!({"specifier":"./fd_probe.cjs"}))
        .await
        .unwrap();
    let count_fn = session
        .request(
            "get",
            json!({"handleId":probe["handleId"],"property":"countOpenDescriptors"}),
        )
        .await
        .unwrap();
    let before_count = session
        .request("call", json!({"handleId":count_fn["handleId"],"args":[]}))
        .await
        .unwrap()["value"]
        .as_u64()
        .unwrap();

    let result = session
        .request("readPngPath", json!({"path":valid}))
        .await
        .unwrap();
    assert_eq!(result["kind"], "typedArray");
    assert_eq!(result["name"], "Uint8Array");
    assert_eq!(result["data"], base64(LOGO));
    let after_valid_count = session
        .request("call", json!({"handleId":count_fn["handleId"],"args":[]}))
        .await
        .unwrap()["value"]
        .as_u64()
        .unwrap();
    assert_eq!(
        after_valid_count, before_count,
        "successful PNG reads must close their descriptor before returning"
    );

    let absent = temp.path().join("secret-missing.png");
    let error = error_text(
        session
            .request("readPngPath", json!({"path":absent}))
            .await
            .unwrap_err(),
    );
    assert!(!error.contains(absent.to_string_lossy().as_ref()));
    assert!(error.contains("PNG file is unavailable"));
    let after_missing_count = session
        .request("call", json!({"handleId":count_fn["handleId"],"args":[]}))
        .await
        .unwrap()["value"]
        .as_u64()
        .unwrap();
    assert_eq!(
        after_missing_count, before_count,
        "failed PNG reads must not leak their descriptor"
    );

    let malformed_png = temp.path().join("malformed.png");
    let mut malformed_bytes = LOGO.to_vec();
    malformed_bytes[0] = 0;
    std::fs::write(&malformed_png, malformed_bytes).unwrap();
    let error = error_text(
        session
            .request("readPngPath", json!({"path":malformed_png}))
            .await
            .unwrap_err(),
    );
    assert!(error.contains("File is not a PNG image"));
    assert!(!error.contains(malformed_png.to_string_lossy().as_ref()));
    let after_decode_rejection_count = session
        .request("call", json!({"handleId":count_fn["handleId"],"args":[]}))
        .await
        .unwrap()["value"]
        .as_u64()
        .unwrap();
    assert_eq!(
        after_decode_rejection_count, before_count,
        "post-open format rejection must close its descriptor before returning"
    );

    let too_large = temp.path().join("oversized.png");
    std::fs::write(&too_large, vec![0u8; 512 * 1024 + 1]).unwrap();
    let error = error_text(
        session
            .request("readPngPath", json!({"path":too_large}))
            .await
            .unwrap_err(),
    );
    assert!(error.contains("PNG file exceeds the supported limit"));
    assert!(!error.contains(too_large.to_string_lossy().as_ref()));

    let symlink = temp.path().join("linked.png");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&valid, &symlink).unwrap();
    #[cfg(unix)]
    {
        let error = error_text(
            session
                .request("readPngPath", json!({"path":symlink}))
                .await
                .unwrap_err(),
        );
        assert!(!error.contains(symlink.to_string_lossy().as_ref()));
    }

    #[cfg(unix)]
    {
        use std::ffi::CString;
        let fifo = temp.path().join("no-writer.fifo");
        let c_path = CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        let status = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(status, 0);
        let timed = tokio::time::timeout(
            Duration::from_secs(2),
            session.request("readPngPath", json!({"path":fifo})),
        )
        .await;
        assert!(
            timed.is_ok(),
            "non-regular FIFO lookup must not block on open"
        );
        let error = error_text(timed.unwrap().unwrap_err());
        assert!(!error.contains(fifo.to_string_lossy().as_ref()));
    }

    let malformed = session
        .request("readPngPath", json!({"path":valid,"extra":true}))
        .await;
    assert!(malformed.is_err());
    session.stop().await.unwrap();
}
