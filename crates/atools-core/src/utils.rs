//! Utility functions for atools-core.

use regex::Regex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// Returns the current UTC time as an ISO 8601 string (e.g. `2026-05-27T14:30:00Z`).
pub fn now_iso() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    iso_from_unix_secs(dur.as_secs())
}

/// Returns the UTC ISO timestamp for the current time minus a whole number of days.
pub fn iso_days_ago(days: u64) -> String {
    let now = SystemTime::now();
    let timestamp = now
        .checked_sub(Duration::from_secs(days.saturating_mul(86_400)))
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    iso_from_unix_secs(timestamp.as_secs())
}

fn iso_from_unix_secs(secs: u64) -> String {
    // Manual conversion from unix timestamp to calendar date (UTC).
    // This avoids pulling in the chrono crate.
    let days = secs / 86400;
    let day_secs = secs % 86400;
    let hours = day_secs / 3600;
    let minutes = (day_secs % 3600) / 60;
    let seconds = day_secs % 60;

    // Algorithm from https://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d, hours, minutes, seconds
    )
}

/// Generates a new random revision string (UUID v4).
pub fn generate_rev() -> String {
    Uuid::new_v4().to_string()
}

/// Sanitizes a string to be safe for use as a filesystem path component or ID.
///
/// Replaces runs of non-alphanumeric characters with a single hyphen,
/// trims leading/trailing hyphens, and falls back to a generated ID if empty.
pub fn sanitize_id(s: &str) -> String {
    let re = Regex::new(r"[^a-zA-Z0-9]+").unwrap();
    let sanitized = re.replace_all(s, "-").to_string();
    let sanitized = sanitized.trim_matches('-').to_string();
    if sanitized.is_empty() {
        format!("plugin-{}", &Uuid::new_v4().to_string()[..8])
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_now_iso_format() {
        let ts = now_iso();
        assert!(ts.contains('T'));
        assert!(ts.ends_with('Z'));
        assert!(ts.len() == 20); // "YYYY-MM-DDTHH:MM:SSZ"
    }

    #[test]
    fn test_iso_days_ago_format() {
        let ts = iso_days_ago(7);
        assert!(ts.contains('T'));
        assert!(ts.ends_with('Z'));
        assert_eq!(ts.len(), 20);
    }

    #[test]
    fn test_now_iso_reasonable_date() {
        let ts = now_iso();
        // Should be after 2024
        assert!(ts.starts_with("20") && ts.as_str() > "2024");
    }

    #[test]
    fn test_generate_rev_unique() {
        let rev1 = generate_rev();
        let rev2 = generate_rev();
        assert_ne!(rev1, rev2);
        assert_eq!(rev1.len(), 36);
    }

    #[test]
    fn test_sanitize_id_basic() {
        assert_eq!(sanitize_id("Hello World!"), "Hello-World");
        assert_eq!(sanitize_id("plugin@1.0.0"), "plugin-1-0-0");
        assert_eq!(sanitize_id("my-plugin"), "my-plugin");
        assert_eq!(sanitize_id("a.b.c"), "a-b-c");
    }

    #[test]
    fn test_sanitize_id_empty_fallback() {
        let result = sanitize_id("!!!");
        assert!(result.starts_with("plugin-"));
    }
}
