//! A bearer session selects its origin policy; request headers never select it.
use std::fmt;

const COMMON_CORS_HEADERS: &str = "Access-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nAccess-Control-Allow-Private-Network: true\r\nVary: Origin\r\n";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum OriginPolicy {
    /// A revoked or missing session never becomes an opaque authorization.
    Deny,
    /// Existing opaque plugin frames and explicitly supported native clients.
    #[default]
    Opaque,
    Exact(ControlledOrigin),
}

/// Its private field prevents constructing an unchecked Exact policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlledOrigin(String);

/// Only a successful session-policy match can produce response CORS headers.
#[derive(Clone, Copy, Default)]
pub(super) struct VerifiedCorsOrigin<'a>(Option<&'a str>);

impl OriginPolicy {
    /// The caller must obtain this origin from its generated document owner,
    /// never from plugin payloads. A missing or revoked owner must return Deny.
    #[allow(dead_code)]
    pub fn exact(origin: &str) -> Result<Self, String> {
        let invalid = || "Invalid controlled plugin origin".to_string();
        if origin.len() > 128 {
            return Err(invalid());
        }
        let url = url::Url::parse(origin).map_err(|_| invalid())?;
        let scheme = url.scheme();
        let allowed = match scheme {
            "atools-plugin" | "atools-page" => true,
            #[cfg(any(test, feature = "legacy-node-smoke"))]
            "atools-origin" => true,
            _ => false,
        };
        let host = url.host_str().ok_or_else(invalid)?;
        if !allowed
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || !url.path().is_empty()
            || url.query().is_some()
            || url.fragment().is_some()
            || origin != format!("{scheme}://{host}")
            || !controlled_host(host)
        {
            return Err(invalid());
        }
        Ok(Self::Exact(ControlledOrigin(origin.to_owned())))
    }

    pub(super) fn authorize(&self, request_origin: Option<&str>) -> Option<VerifiedCorsOrigin<'_>> {
        match self {
            Self::Opaque if request_origin.is_none() || request_origin == Some("null") => {
                Some(VerifiedCorsOrigin(Some("null")))
            }
            Self::Exact(origin) if request_origin == Some(origin.0.as_str()) => {
                Some(VerifiedCorsOrigin(Some(&origin.0)))
            }
            _ => None,
        }
    }
}

fn controlled_host(host: &str) -> bool {
    let Some(instance) = host.strip_suffix(".localhost") else {
        return false;
    };
    let (label, id) = match instance.rsplit_once('-') {
        Some(("", _)) => return false,
        Some(parts) => parts,
        None => ("", instance),
    };
    if !label.is_empty()
        && (label.len() > 24
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || label.starts_with('-')
            || label.ends_with('-'))
    {
        return false;
    }
    // A host is per generated instance, not an arbitrary plugin/domain name.
    if id.len() != 32
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return false;
    }
    uuid::Uuid::parse_str(id).is_ok_and(|id| !id.is_nil())
}

impl fmt::Display for VerifiedCorsOrigin<'_> {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            Some(origin) => write!(
                output,
                "Access-Control-Allow-Origin: {origin}\r\n{COMMON_CORS_HEADERS}"
            ),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
#[path = "plugin_loopback_origin_tests.rs"]
mod tests;
