use atools_core::config::AppConfig;
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, serde::Serialize)]
pub struct CrashLogEntry {
    pub timestamp: String,
    pub message: String,
    pub location: Option<String>,
    pub raw: String,
}

pub fn crash_log_path(config: &AppConfig) -> PathBuf {
    config.base_dir().join("crashes.log")
}

pub fn install_panic_hook(path: PathBuf) {
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let payload = panic_payload(panic_info);
        let location = panic_info
            .location()
            .map(|loc| format!("{}:{}", loc.file(), loc.line()));
        let entry = format_panic_log_entry(
            &atools_core::utils::now_iso(),
            &payload,
            location.as_deref(),
        );
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = file.write_all(entry.as_bytes());
        }
        previous_hook(panic_info);
    }));
}

pub fn format_panic_log_entry(timestamp: &str, payload: &str, location: Option<&str>) -> String {
    format!(
        "[{timestamp}] panic: {payload} at {}\n",
        location.unwrap_or("unknown")
    )
}

pub fn list_crash_logs(config: &AppConfig, limit: usize) -> std::io::Result<Vec<CrashLogEntry>> {
    let content = export_crash_log(config)?;
    let mut entries = content
        .lines()
        .filter_map(parse_crash_log_entry)
        .collect::<Vec<_>>();
    entries.reverse();
    entries.truncate(limit);
    Ok(entries)
}

pub fn export_crash_log(config: &AppConfig) -> std::io::Result<String> {
    let path = crash_log_path(config);
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(path)
}

pub fn clear_crash_log(config: &AppConfig) -> std::io::Result<usize> {
    let count = export_crash_log(config)?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    let path = crash_log_path(config);
    if path.exists() {
        std::fs::write(path, "")?;
    }
    Ok(count)
}

fn parse_crash_log_entry(line: &str) -> Option<CrashLogEntry> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix('[')?;
    let (timestamp, rest) = rest.split_once("] panic: ")?;
    let (message, location) = rest
        .rsplit_once(" at ")
        .map(|(message, location)| (message.to_string(), Some(location.to_string())))
        .unwrap_or_else(|| (rest.to_string(), None));
    Some(CrashLogEntry {
        timestamp: timestamp.to_string(),
        message,
        location,
        raw: trimmed.to_string(),
    })
}

fn panic_payload(info: &std::panic::PanicHookInfo<'_>) -> String {
    if let Some(value) = info.payload().downcast_ref::<&str>() {
        return (*value).to_string();
    }
    if let Some(value) = info.payload().downcast_ref::<String>() {
        return value.clone();
    }
    "non-string panic payload".to_string()
}
