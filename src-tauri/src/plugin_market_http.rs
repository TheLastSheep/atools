//! Bounded HTTP metadata reads for plugin market catalogs and resolvers.

use reqwest::{header::LOCATION, redirect::Policy, Url};
use serde_json::Value;
use std::time::Duration;

const MAX_URL_BYTES: usize = 2048;
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const TOTAL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REDIRECTS: usize = 2;

/// Fetch JSON metadata without allowing an unbounded body or cross-host redirects.
///
/// Errors use small internal prefixes so existing command wrappers can retain their
/// user-facing distinction between transport, status, and JSON parsing failures.
pub(crate) async fn fetch_json_metadata(url: &Url) -> Result<Value, String> {
    fetch_json_metadata_with_policy(url, TOTAL_TIMEOUT).await
}

async fn fetch_json_metadata_with_policy(url: &Url, timeout: Duration) -> Result<Value, String> {
    validate_metadata_url(url)?;
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("request failed: {error}"))?;

    tokio::time::timeout(timeout, async {
        let mut current = url.clone();
        let mut redirects = 0;
        loop {
            let response = client
                .get(current.clone())
                .send()
                .await
                .map_err(|error| format!("request failed: {error}"))?;

            if response.status().is_redirection() {
                if redirects >= MAX_REDIRECTS {
                    return Err("redirect limit exceeded".to_string());
                }
                let location = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| "redirect has no valid Location".to_string())?;
                let next = current
                    .join(location)
                    .map_err(|error| format!("invalid redirect URL: {error}"))?;
                validate_metadata_url(&next)?;
                if !is_allowed_redirect(&current, &next) {
                    return Err(
                        "redirect must stay on the same host without HTTPS downgrade".to_string(),
                    );
                }
                current = next;
                redirects += 1;
                continue;
            }

            let status = response.status();
            if !status.is_success() {
                return Err(format!("http status {status}"));
            }
            let declared_length = response.content_length();
            if declared_length.is_some_and(|length| length > MAX_BODY_BYTES as u64) {
                return Err(format!("response body exceeds {MAX_BODY_BYTES} bytes"));
            }
            let mut body = Vec::with_capacity(
                declared_length
                    .and_then(|length| usize::try_from(length).ok())
                    .unwrap_or(0)
                    .min(MAX_BODY_BYTES),
            );
            let mut response = response;
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| format!("request failed: {error}"))?
            {
                if body.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
                    return Err(format!("response body exceeds {MAX_BODY_BYTES} bytes"));
                }
                body.extend_from_slice(&chunk);
            }
            return serde_json::from_slice(&body).map_err(|error| format!("invalid json: {error}"));
        }
    })
    .await
    .map_err(|_| format!("request timed out after {} ms", timeout.as_millis()))?
}

fn validate_metadata_url(url: &Url) -> Result<(), String> {
    if url.as_str().len() > MAX_URL_BYTES {
        return Err(format!("metadata URL exceeds {MAX_URL_BYTES} bytes"));
    }
    if !matches!(url.scheme(), "http" | "https") {
        return Err("metadata URL must use http or https".to_string());
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("metadata URL must have a host and must not contain userinfo".to_string());
    }
    Ok(())
}

fn is_allowed_redirect(previous: &Url, next: &Url) -> bool {
    let same_host = previous
        .host_str()
        .zip(next.host_str())
        .is_some_and(|(left, right)| left.eq_ignore_ascii_case(right));
    if !same_host || (previous.scheme() == "https" && next.scheme() == "http") {
        return false;
    }

    if previous.scheme() == next.scheme() {
        return previous.port_or_known_default() == next.port_or_known_default();
    }

    // Permit the conventional HTTP-to-HTTPS upgrade, plus same-port upgrades.
    previous.scheme() == "http"
        && next.scheme() == "https"
        && (previous.port_or_known_default() == next.port_or_known_default()
            || (previous.port_or_known_default() == Some(80)
                && next.port_or_known_default() == Some(443)))
}

#[cfg(test)]
#[path = "plugin_market_http_tests.rs"]
mod tests;
