//! Bind captured immutable Main bytes before granting the original-renderer role.
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const EXPECTED: &str = include_str!("main-assets.json");
const PROVENANCE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../packages/ztools-renderer/dist/build-provenance.json"
));

pub(super) fn verify(assets: &super::super::assets::RendererAssets) -> Result<(), String> {
    verify_files(assets.captured_files(), PROVENANCE)
}
fn verify_files(files: &BTreeMap<String, Box<[u8]>>, provenance: &[u8]) -> Result<(), String> {
    let expected: serde_json::Value =
        serde_json::from_str(EXPECTED).map_err(|_| "updater-main-binding-invalid")?;
    if expected["provenanceSha256"] != format!("{:x}", Sha256::digest(provenance)) {
        return Err("updater-main-provenance-changed".into());
    }
    let declared = expected["files"]
        .as_object()
        .ok_or("updater-main-binding-invalid")?;
    if files.len() != declared.len() {
        return Err("updater-main-resource-set-changed".into());
    }
    for (name, bytes) in files {
        let row = declared
            .get(name)
            .ok_or("updater-main-resource-set-changed")?;
        if row["bytes"].as_u64() != Some(bytes.len() as u64)
            || row["sha256"] != format!("{:x}", Sha256::digest(bytes))
        {
            return Err("updater-main-resource-bytes-changed".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_captured_formal_assets_match_but_replacement_and_extra_fail() {
        let dist = std::fs::canonicalize(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../packages/ztools-renderer/dist"
        ))
        .unwrap();
        let assets = super::super::super::assets::RendererAssets::load(&dist).unwrap();
        verify(&assets).unwrap();
        let mut files = assets.captured_files().clone();
        files.insert(
            "/index.html".into(),
            b"replacement".to_vec().into_boxed_slice(),
        );
        assert!(verify_files(&files, PROVENANCE).is_err());
        let mut files = assets.captured_files().clone();
        files.insert("/assets/extra.js".into(), b"x".to_vec().into_boxed_slice());
        assert!(verify_files(&files, PROVENANCE).is_err());
        assert!(verify_files(assets.captured_files(), b"changed provenance").is_err());
    }
}
