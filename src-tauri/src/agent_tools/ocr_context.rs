use super::*;
pub async fn ocr_image(arguments: Value) -> Result<Value, String> {
    let path = arguments
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing path".to_string())?;
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let mime = image_mime_for_path(Path::new(path));
    let payload = json!({ "image": format!("data:{};base64,{}", mime, encoded) });
    let endpoint = arguments
        .get("endpoint")
        .and_then(Value::as_str)
        .unwrap_or("http://127.0.0.1:8765/ocr");
    let client = reqwest::Client::new();
    let response: Value = client
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Local OCR service is unavailable at {}. Start the OCR service that accepts POST /ocr JSON with an image data URI, then retry. Network error: {}",
                endpoint, e
            )
        })?
        .json()
        .await
        .map_err(|e| format!("Local OCR service returned invalid JSON from {}: {}", endpoint, e))?;
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(json!({ "text": response.get("text").cloned().unwrap_or(Value::String(String::new())) }))
    } else {
        Err(response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("OCR failed")
            .to_string())
    }
}

pub(super) fn visit_files(
    root: &Path,
    base_root: &Path,
    query_lower: &str,
    options: &FindLocalFilesOptions,
    depth: usize,
    report: &mut FindLocalFilesReport,
) -> Result<(), String> {
    let limit = options.limit.max(1);
    if report.items.len() >= limit {
        return Ok(());
    }
    if options
        .max_depth
        .map(|max_depth| depth > max_depth)
        .unwrap_or(false)
    {
        return Ok(());
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            report.skipped_permission_errors += 1;
            return Ok(());
        }
        Err(error) => return Err(format!("Failed to read {:?}: {}", root, error)),
    };
    for entry in entries {
        if report.items.len() >= limit {
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                if error.kind() == ErrorKind::PermissionDenied {
                    report.skipped_permission_errors += 1;
                }
                continue;
            }
        };
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                if error.kind() == ErrorKind::PermissionDenied {
                    report.skipped_permission_errors += 1;
                }
                continue;
            }
        };
        if file_type.is_dir() && options.ignore_dirs.iter().any(|name| name == &file_name) {
            continue;
        }
        let relative_path = slash_path(path.strip_prefix(base_root).unwrap_or(path.as_path()));
        if matches_ignore_patterns(
            &file_name,
            &relative_path,
            file_type.is_dir(),
            &options.ignore_patterns,
        ) {
            continue;
        }
        if query_lower.is_empty() || file_name.to_lowercase().contains(query_lower) {
            report.items.push(FileMatch {
                path: path.to_string_lossy().to_string(),
                name: file_name,
                is_dir: file_type.is_dir(),
            });
        }
        if file_type.is_dir() {
            visit_files(&path, base_root, query_lower, options, depth + 1, report)?;
        }
    }
    Ok(())
}

pub(super) fn slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub(super) fn matches_ignore_patterns(
    file_name: &str,
    relative_path: &str,
    is_dir: bool,
    patterns: &[String],
) -> bool {
    patterns.iter().any(|pattern| {
        let pattern = pattern.trim().trim_start_matches("./");
        if pattern.is_empty() {
            return false;
        }
        if let Some(prefix) = pattern.strip_suffix("/**") {
            let prefix = prefix.trim_end_matches('/');
            return !prefix.is_empty()
                && (relative_path == prefix || relative_path.starts_with(&format!("{prefix}/")));
        }
        wildcard_match(pattern, file_name)
            || wildcard_match(pattern, relative_path)
            || (is_dir && wildcard_match(pattern.trim_end_matches('/'), relative_path))
    })
}

pub(super) fn wildcard_match(pattern: &str, text: &str) -> bool {
    let pattern = pattern.as_bytes();
    let text = text.as_bytes();
    let (mut pattern_index, mut text_index) = (0, 0);
    let mut star_index = None;
    let mut star_text_index = 0;

    while text_index < text.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == b'?' || pattern[pattern_index] == text[text_index])
        {
            pattern_index += 1;
            text_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
            star_index = Some(pattern_index);
            star_text_index = text_index;
            pattern_index += 1;
        } else if let Some(star) = star_index {
            pattern_index = star + 1;
            star_text_index += 1;
            text_index = star_text_index;
        } else {
            return false;
        }
    }

    while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        pattern_index += 1;
    }

    pattern_index == pattern.len()
}

pub(super) fn default_ignored_dirs() -> Vec<String> {
    [".git", "node_modules", "target", ".next", ".svelte-kit"]
        .into_iter()
        .map(ToString::to_string)
        .collect()
}

#[derive(Debug)]
pub(super) struct ContextValue {
    pub(super) value: Value,
    pub(super) reason: Value,
}

pub(super) fn read_browser_url() -> ContextValue {
    match crate::commands::read_current_browser_url() {
        Ok(Some(url)) if !url.is_empty() => ContextValue {
            value: Value::String(url),
            reason: Value::Null,
        },
        Ok(_) => ContextValue {
            value: Value::Null,
            reason: Value::String(
                "No current browser URL is available from the frontmost supported browser."
                    .to_string(),
            ),
        },
        Err(error) => ContextValue {
            value: Value::Null,
            reason: Value::String(format!("Unable to read the current browser URL: {}", error)),
        },
    }
}

pub(super) fn read_foreground_app() -> ContextValue {
    if cfg!(target_os = "macos") {
        match run_osascript(&[
            "-e",
            "tell application \"System Events\" to get name of first application process whose frontmost is true",
        ]) {
            Ok(value) if !value.is_empty() => ContextValue {
                value: Value::String(value),
                reason: Value::Null,
            },
            Ok(_) => ContextValue {
                value: Value::Null,
                reason: Value::String(
                    "macOS returned an empty foreground application name.".to_string(),
                ),
            },
            Err(error) => ContextValue {
                value: Value::Null,
                reason: Value::String(format!(
                    "Unable to read the foreground app with osascript: {}",
                    error
                )),
            },
        }
    } else {
        ContextValue {
            value: Value::Null,
            reason: Value::String(format!(
                "Foreground application detection is not implemented for {}.",
                std::env::consts::OS
            )),
        }
    }
}

pub(super) fn read_finder_path() -> ContextValue {
    match crate::commands::read_current_folder_path() {
        Ok(Some(path)) if !path.is_empty() => ContextValue {
            value: Value::String(path),
            reason: Value::Null,
        },
        Ok(_) => ContextValue {
            value: Value::Null,
            reason: Value::String(
                "No current Finder path is available from the command-layer folder bridge."
                    .to_string(),
            ),
        },
        Err(error) => ContextValue {
            value: Value::Null,
            reason: Value::String(format!("Unable to read the current Finder path: {}", error)),
        },
    }
}

pub(super) fn run_osascript(args: &[&str]) -> Result<String, String> {
    let output = Command::new("osascript")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("osascript exited with {}", output.status)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(all(test, target_os = "macos"))]
mod context_tests {
    use super::*;

    #[test]
    fn finder_context_matches_command_layer_folder_bridge() {
        let expected = crate::commands::read_current_folder_path();
        let actual = read_finder_path();

        match expected {
            Ok(Some(path)) => {
                assert_eq!(actual.value, Value::String(path));
                assert!(actual.reason.is_null());
            }
            Ok(None) => {
                assert!(actual.value.is_null());
                let reason = actual.reason.as_str().unwrap();
                assert!(reason.len() > 10);
                assert!(!reason.contains("not implemented"));
            }
            Err(error) => {
                assert!(actual.value.is_null());
                let reason = actual.reason.as_str().unwrap();
                assert!(reason.contains("Unable to read the current Finder path"));
                assert!(reason.contains(&error));
            }
        }
    }
}

pub(super) fn image_mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("tif") | Some("tiff") => "image/tiff",
        Some("heic") => "image/heic",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    }
}
