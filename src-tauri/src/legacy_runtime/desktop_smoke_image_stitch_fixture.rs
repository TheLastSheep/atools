//! Fixed, run-bound PNG inputs for the reviewed original Image Stitch package.
use image::{codecs::png::PngEncoder, ImageEncoder, ImageReader, Limits};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
};

pub(super) const CASE_ID: &str = "local-image-stitch-head";
const PLUGIN_ID: &str = "image-stitch";
const FEATURE: &str = "image-stitch-files";
const TOP_NAME: &str = "atools-image-stitch-top.png";
const BOTTOM_NAME: &str = "atools-image-stitch-bottom.png";
const MAX_PNG_BYTES: u64 = 4096;
const MAX_TOTAL_BYTES: u64 = 8192;
const TOP_PIXELS: [u8; 16] = [
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
];
const BOTTOM_PIXELS: [u8; 16] = [
    0, 255, 255, 255, 255, 0, 255, 255, 255, 255, 0, 255, 0, 0, 0, 255,
];

pub(super) fn profile_matches(profile: &Value) -> bool {
    profile["caseId"] == CASE_ID
        && profile["id"] == PLUGIN_ID
        && profile["version"] == "1.0.0"
        && profile["featureCode"] == FEATURE
        && profile["runtime"] == "web"
        && profile["dataAccess"] == true
        && profile["dialogAccess"] == "open_and_save"
        && profile["pathAccess"] == "none"
        && profile["verifyDataPersistence"] == false
        && profile["sourceKind"] == "local_full_directory"
        && profile["sourceCommit"] == "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d"
        && profile["sourceTree"] == "629b6c70b86f28d8f775ced7202bfc2de9b244d5"
        && profile["directorySha256"]
            == "16538ea9ec960d82f54f94a3de6f7df1a9d65b86ca1e6b5470c6e9698d84cdee"
        && profile["fileCount"] == 5
}

fn expected_png(pixels: &[u8; 16]) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(pixels, 2, 2, image::ExtendedColorType::Rgba8)
        .map_err(|_| "Unable to encode fixed Image Stitch fixture")?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_PNG_BYTES {
        return Err("Fixed Image Stitch PNG exceeds its byte limit".into());
    }
    Ok(bytes)
}

fn create_fixed(downloads: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let path = downloads.join(name);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| "Image Stitch fixture already exists or is unavailable")?;
    file.write_all(bytes)
        .map_err(|_| "Unable to write fixed Image Stitch fixture")?;
    file.sync_all()
        .map_err(|_| "Unable to finish fixed Image Stitch fixture")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Unable to verify fixed Image Stitch fixture")?;
    if !metadata.is_file() || metadata.len() != bytes.len() as u64 || metadata.len() > MAX_PNG_BYTES
    {
        return Err("Fixed Image Stitch fixture file verification failed".into());
    }
    Ok(path)
}

pub(super) fn prepare(profile: &Value, downloads: &Path) -> Result<(), String> {
    if !profile_matches(profile) {
        return Err("Image Stitch fixture profile rejected".into());
    }
    let top = expected_png(&TOP_PIXELS)?;
    let bottom = expected_png(&BOTTOM_PIXELS)?;
    if top.len() as u64 + bottom.len() as u64 > MAX_TOTAL_BYTES {
        return Err("Image Stitch fixture pair exceeds its total byte limit".into());
    }
    create_fixed(downloads, TOP_NAME, &top)?;
    create_fixed(downloads, BOTTOM_NAME, &bottom)?;
    Ok(())
}

fn read_fixed(downloads: &Path, name: &str) -> Result<(PathBuf, Vec<u8>), String> {
    let path = downloads.join(name);
    let before =
        fs::symlink_metadata(&path).map_err(|_| "Image Stitch fixture input is missing")?;
    if !before.is_file()
        || before.file_type().is_symlink()
        || before.len() == 0
        || before.len() > MAX_PNG_BYTES
    {
        return Err("Image Stitch fixture must be a bounded regular PNG".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| "Image Stitch fixture no-follow open failed")?;
    let opened = file
        .metadata()
        .map_err(|_| "Image Stitch fixture metadata unavailable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (before.dev(), before.ino()) != (opened.dev(), opened.ino()) {
            return Err("Image Stitch fixture changed during inspection".into());
        }
    }
    if !opened.is_file() || opened.len() != before.len() || opened.len() > MAX_PNG_BYTES {
        return Err("Image Stitch fixture changed during inspection".into());
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(MAX_PNG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Image Stitch fixture read failed")?;
    if bytes.len() as u64 != opened.len() || bytes.len() as u64 > MAX_PNG_BYTES {
        return Err("Image Stitch fixture byte limit exceeded".into());
    }
    Ok((path, bytes))
}

fn verify_pixels(bytes: &[u8], expected: &[u8; 16]) -> Result<Value, String> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(2);
    limits.max_image_height = Some(2);
    limits.max_alloc = Some(64);
    reader.limits(limits);
    let rgba = reader
        .decode()
        .map_err(|_| "Image Stitch fixture is not a bounded PNG")?
        .to_rgba8();
    if rgba.width() != 2 || rgba.height() != 2 || rgba.as_raw().as_slice() != expected {
        return Err("Image Stitch fixture dimensions or pixel order mismatch".into());
    }
    Ok(json!([
        expected[0..4],
        expected[4..8],
        expected[8..12],
        expected[12..16]
    ]))
}

pub(super) fn evidence(profile: &Value, downloads: &Path, run_id: &str) -> Result<Value, String> {
    if !profile_matches(profile) || uuid::Uuid::parse_str(run_id).is_err() {
        return Err("Image Stitch fixture run identity rejected".into());
    }
    let mut files = Vec::new();
    for (name, pixels) in [(TOP_NAME, &TOP_PIXELS), (BOTTOM_NAME, &BOTTOM_PIXELS)] {
        let (path, bytes) = read_fixed(downloads, name)?;
        let decoded_pixels = verify_pixels(&bytes, pixels)?;
        files.push(json!({"path":path.to_string_lossy(),"fileName":name,"sha256":format!("{:x}",Sha256::digest(&bytes)),
            "bytes":bytes.len(),"width":2,"height":2,"pixels":decoded_pixels}));
    }
    let total_bytes = files
        .iter()
        .map(|file| file["bytes"].as_u64().unwrap_or(u64::MAX))
        .sum::<u64>();
    if total_bytes > MAX_TOTAL_BYTES {
        return Err("Image Stitch fixture pair exceeds its total byte limit".into());
    }
    Ok(
        json!({"caseId":CASE_ID,"pluginId":PLUGIN_ID,"featureCode":FEATURE,"runId":run_id,
        "orderedPaths":[files[0]["path"],files[1]["path"]],"files":files,"totalBytes":total_bytes,
        "pathAccess":"none",
        "source":"fixed native Image Stitch fixture pair; bounded no-follow reads and independent PNG decode"}),
    )
}

#[cfg(test)]
#[path = "desktop_smoke_image_stitch_fixture_tests.rs"]
mod tests;
