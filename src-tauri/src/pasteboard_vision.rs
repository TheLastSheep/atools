use serde::Deserialize;
use std::path::Path;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

const MAX_REQUEST_BYTES: usize = 8 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_STDERR_BYTES: usize = 8 * 1024;
const OCR_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VisionResponse {
    request_id: String,
    ok: bool,
    text: Option<String>,
    error: Option<String>,
}

pub async fn recognize_image(app: &AppHandle, image_path: &Path) -> Result<String, String> {
    let image_path = image_path
        .to_str()
        .ok_or_else(|| "PasteboardPro OCR image path is not valid UTF-8".to_string())?;
    if !image_path.starts_with('/') {
        return Err("PasteboardPro OCR image path must be absolute".to_string());
    }
    let request_id = atools_core::utils::generate_rev();
    let request = serde_json::to_vec(&serde_json::json!({
        "requestId": request_id,
        "imagePath": image_path,
    }))
    .map_err(|error| format!("Failed to encode PasteboardPro OCR request: {error}"))?;
    if request.len() > MAX_REQUEST_BYTES {
        return Err("PasteboardPro OCR request exceeds 8 KiB".to_string());
    }

    let (mut events, mut child) = app
        .shell()
        .sidecar("pasteboard-vision")
        .map_err(|error| format!("PasteboardPro Vision helper is unavailable: {error}"))?
        .spawn()
        .map_err(|error| format!("Failed to start PasteboardPro Vision helper: {error}"))?;
    let mut request_line = request;
    request_line.push(b'\n');
    if let Err(error) = child.write(&request_line) {
        let _ = child.kill();
        return Err(format!("Failed to send PasteboardPro OCR request: {error}"));
    }

    let result = tokio::time::timeout(OCR_TIMEOUT, async {
        let mut stdout_lines = Vec::new();
        let mut stdout_bytes = 0usize;
        let mut stderr = Vec::new();
        let mut exit_code = None;
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    stdout_bytes = stdout_bytes.saturating_add(line.len());
                    if stdout_bytes > MAX_RESPONSE_BYTES {
                        return Err("PasteboardPro OCR response exceeds 1 MiB".to_string());
                    }
                    stdout_lines.push(line);
                }
                CommandEvent::Stderr(chunk) => {
                    let remaining = MAX_STDERR_BYTES.saturating_sub(stderr.len());
                    stderr.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
                }
                CommandEvent::Error(error) => return Err(error),
                CommandEvent::Terminated(payload) => exit_code = payload.code,
                _ => {}
            }
        }
        if stdout_lines.len() != 1 {
            let message = String::from_utf8_lossy(&stderr).trim().to_string();
            return Err(if message.is_empty() {
                format!(
                    "PasteboardPro Vision helper returned {} response lines (exit {:?})",
                    stdout_lines.len(),
                    exit_code
                )
            } else {
                message
            });
        }
        parse_vision_response(&stdout_lines[0], &request_id)
    })
    .await;

    match result {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(error)) => {
            let _ = child.kill();
            Err(error)
        }
        Err(_) => {
            let _ = child.kill();
            Err("PasteboardPro Vision OCR timed out after 15 seconds".to_string())
        }
    }
}

fn parse_vision_response(bytes: &[u8], request_id: &str) -> Result<String, String> {
    let response = serde_json::from_slice::<VisionResponse>(bytes)
        .map_err(|error| format!("PasteboardPro Vision helper returned invalid JSON: {error}"))?;
    if response.request_id != request_id {
        return Err("PasteboardPro Vision helper response id does not match".to_string());
    }
    if !response.ok {
        return Err(response
            .error
            .filter(|error| !error.trim().is_empty())
            .unwrap_or_else(|| "PasteboardPro Vision OCR failed".to_string()));
    }
    response
        .text
        .map(|text| text.trim().to_string())
        .ok_or_else(|| "PasteboardPro Vision helper response is missing text".to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_vision_response;

    #[test]
    fn parses_redacted_vision_response_envelope() {
        assert_eq!(
            parse_vision_response(
                br#"{"requestId":"request-1","ok":true,"text":" hello ","error":null}"#,
                "request-1",
            )
            .unwrap(),
            "hello"
        );
    }

    #[test]
    fn rejects_mismatched_vision_response() {
        assert!(parse_vision_response(
            br#"{"requestId":"request-2","ok":true,"text":"hello","error":null}"#,
            "request-1",
        )
        .unwrap_err()
        .contains("does not match"));
    }
}
