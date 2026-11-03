//! Rust-side evidence for the generated page-only Node acceptance fixture.
use image::ImageReader;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::Cursor, path::Path};

pub(crate) fn inspect_png(path: &Path, task_runs_json: &[u8]) -> Result<Value, String> {
    let output_text = path.to_string_lossy();
    let contains = |haystack: &[u8], needle: &[u8]| {
        !needle.is_empty()
            && haystack
                .windows(needle.len())
                .any(|window| window == needle)
    };
    let private_paths_absent_from_task_runs = !contains(task_runs_json, output_text.as_bytes());
    if !private_paths_absent_from_task_runs {
        return Err("Node page private path appeared in durable TaskRun data".into());
    }
    if std::fs::symlink_metadata(path).is_err() {
        return Ok(json!({"exists":false,"privatePathsAbsentFromTaskRuns":true}));
    }
    if !std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    {
        return Err("Node page output must be a regular file".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "Node page output read failed")?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Node page PNG exceeds the 8 MiB fixture limit".into());
    }
    let reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| "Node page output format rejected")?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(8 * 1024 * 1024);
    let mut reader = reader;
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| "Node page output is not a bounded decodable image")?
        .to_rgba8();
    if image.width() != 4 || image.height() != 6 {
        return Err("Node page output dimensions mismatch".into());
    }
    let pixel = |x, y| image.get_pixel(x, y).0;
    let pixels = json!({"redAt1x1":pixel(1,1),"whiteAt1x2":pixel(1,2),"blueAt1x3":pixel(1,3)});
    if pixels["redAt1x1"] != json!([255, 0, 0, 255])
        || pixels["whiteAt1x2"] != json!([255, 255, 255, 255])
        || pixels["blueAt1x3"] != json!([0, 0, 255, 255])
    {
        return Err("Node page output pixel evidence mismatch".into());
    }
    Ok(
        json!({"exists":true,"byteCount":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),
        "width":image.width(),"height":image.height(),"pixels":pixels,"privatePathsAbsentFromTaskRuns":true,
        "decoder":"Rust image crate; bounded PNG decode"}),
    )
}
