//! Bind runtime Settings metadata to this binary's actual compiled artifact.
use std::sync::OnceLock;

const EXPECTED: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../packages/ztools-settings/dist/build-provenance.json"
));
static REVISION: OnceLock<Result<String, String>> = OnceLock::new();

pub(super) fn compiled_revision() -> Result<String, String> {
    REVISION
        .get_or_init(|| {
            if EXPECTED.is_empty() {
                Err("Compiled Settings provenance is empty".to_owned())
            } else {
                Ok(super::sha256_hex(EXPECTED))
            }
        })
        .clone()
}

pub(super) fn verify(bytes: &[u8], expected: &str) -> super::BundleResult<String> {
    if bytes.is_empty() || !super::is_sha256_hex(expected) {
        return Err("Settings provenance binding is invalid");
    }
    let actual = super::sha256_hex(bytes);
    if actual != expected {
        return Err("Settings provenance differs from compiled artifact");
    }
    Ok(actual)
}

#[cfg(test)]
#[path = "bundle_binding_tests.rs"]
mod tests;
