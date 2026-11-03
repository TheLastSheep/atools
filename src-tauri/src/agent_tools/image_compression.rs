use super::*;
pub fn compress_images(arguments: Value) -> Result<Value, String> {
    let paths = arguments
        .get("paths")
        .and_then(Value::as_array)
        .ok_or_else(|| "Missing paths array".to_string())?;
    let output_dir = arguments
        .get("output_dir")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let max_width = arguments
        .get("max_width")
        .and_then(Value::as_u64)
        .unwrap_or(1600);
    let max_bytes = arguments
        .get("max_bytes")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0);
    let output_format = CompressionImageFormat::from_arguments(&arguments)?;

    let mut outputs = Vec::new();
    for path in paths.iter().filter_map(Value::as_str) {
        match compress_image_item(
            path,
            output_dir.as_deref(),
            max_width,
            max_bytes,
            output_format,
        ) {
            Ok(item) => outputs.push(item),
            Err(error) => outputs.push(json!({
                "input": path,
                "status": "failed",
                "error": error
            })),
        }
    }

    Ok(json!({ "items": outputs }))
}

pub(super) fn compress_image_item(
    path: &str,
    output_dir: Option<&Path>,
    max_width: u64,
    max_bytes: Option<u64>,
    output_format: CompressionImageFormat,
) -> Result<Value, String> {
    let input = PathBuf::from(path);
    let original_size = fs::metadata(&input)
        .map_err(|e| format!("Failed to read input metadata for {}: {}", path, e))?
        .len();
    let file_name = input
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid file path: {}", path))?;
    let target_dir = output_dir.map(Path::to_path_buf).unwrap_or_else(|| {
        input
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf()
    });
    if !target_dir.exists() {
        return Err(format!(
            "Output directory does not exist: {}",
            target_dir.to_string_lossy()
        ));
    }
    let output = compressed_output_path(&input, &target_dir, file_name, output_format)?;
    match output_format {
        CompressionImageFormat::Original => {
            fs::copy(&input, &output).map_err(|e| {
                format!(
                    "Failed to copy {} to {}: {}",
                    input.to_string_lossy(),
                    output.to_string_lossy(),
                    e
                )
            })?;
            if cfg!(target_os = "macos") {
                let sips_output = Command::new("sips")
                    .arg("--resampleWidth")
                    .arg(max_width.to_string())
                    .arg(&output)
                    .output()
                    .map_err(|e| {
                        format!("Failed to run sips for {}: {}", output.to_string_lossy(), e)
                    })?;
                if !sips_output.status.success() {
                    let stderr = String::from_utf8_lossy(&sips_output.stderr)
                        .trim()
                        .to_string();
                    return Err(format!(
                        "sips failed for {}{}",
                        output.to_string_lossy(),
                        if stderr.is_empty() {
                            format!(" with status {}", sips_output.status)
                        } else {
                            format!(": {}", stderr)
                        }
                    ));
                }
            }
        }
        CompressionImageFormat::Webp => write_webp_output(&input, &output, max_width)?,
    }
    let (output, output_size, target_reason) =
        tune_image_to_target(output, max_bytes, output_format.allows_quality_tuning())?;
    let target_met = max_bytes.map(|target| output_size <= target);
    let status = if target_met == Some(false) {
        "target_unmet"
    } else if cfg!(target_os = "macos") || output_format.is_encoded() {
        "compressed"
    } else {
        "copied"
    };
    Ok(json!({
        "input": input.to_string_lossy(),
        "output": output.to_string_lossy(),
        "format": output_format.as_str(),
        "status": status,
        "original_size": original_size,
        "output_size": output_size,
        "target_size": max_bytes,
        "target_met": target_met,
        "target_reason": target_reason,
        "compression_ratio": compression_ratio(original_size, output_size)
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CompressionImageFormat {
    Original,
    Webp,
}

impl CompressionImageFormat {
    fn from_arguments(arguments: &Value) -> Result<Self, String> {
        match arguments
            .get("format")
            .and_then(Value::as_str)
            .unwrap_or("original")
            .to_ascii_lowercase()
            .as_str()
        {
            "original" => Ok(Self::Original),
            "webp" => Ok(Self::Webp),
            other => Err(format!(
                "Unsupported compress_images format: {}. Supported formats: original, webp",
                other
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::Webp => "webp",
        }
    }

    fn allows_quality_tuning(self) -> bool {
        matches!(self, Self::Original)
    }

    fn is_encoded(self) -> bool {
        matches!(self, Self::Webp)
    }
}

pub(super) fn compressed_output_path(
    input: &Path,
    target_dir: &Path,
    file_name: &str,
    output_format: CompressionImageFormat,
) -> Result<PathBuf, String> {
    match output_format {
        CompressionImageFormat::Original => {
            Ok(target_dir.join(format!("compressed-{}", file_name)))
        }
        CompressionImageFormat::Webp => {
            let stem = input
                .file_stem()
                .and_then(|name| name.to_str())
                .ok_or_else(|| format!("Invalid file path: {}", input.to_string_lossy()))?;
            Ok(target_dir.join(format!("compressed-{}.webp", stem)))
        }
    }
}

pub(super) fn write_webp_output(input: &Path, output: &Path, max_width: u64) -> Result<(), String> {
    let mut image = image::ImageReader::open(input)
        .map_err(|error| {
            format!(
                "Failed to open image {}: {}",
                input.to_string_lossy(),
                error
            )
        })?
        .decode()
        .map_err(|error| {
            format!(
                "Failed to decode image {}: {}",
                input.to_string_lossy(),
                error
            )
        })?;
    let max_width = max_width.min(u32::MAX as u64) as u32;
    if max_width > 0 && image.width() > max_width {
        let scaled_height = ((image.height() as f64 * max_width as f64) / image.width() as f64)
            .round()
            .max(1.0) as u32;
        image = image.resize(
            max_width,
            scaled_height,
            image::imageops::FilterType::Lanczos3,
        );
    }
    let rgba = image.to_rgba8();
    let mut file = fs::File::create(output)
        .map_err(|error| format!("Failed to create {}: {}", output.to_string_lossy(), error))?;
    image::codecs::webp::WebPEncoder::new_lossless(&mut file)
        .write_image(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| {
            format!(
                "Failed to encode WebP output {}: {}",
                output.to_string_lossy(),
                error
            )
        })
}

pub(super) fn tune_image_to_target(
    output: PathBuf,
    max_bytes: Option<u64>,
    allow_quality_tuning: bool,
) -> Result<(PathBuf, u64, Option<String>), String> {
    let mut current_output = output;
    let mut current_size = fs::metadata(&current_output)
        .map_err(|e| {
            format!(
                "Failed to read output metadata for {}: {}",
                current_output.to_string_lossy(),
                e
            )
        })?
        .len();
    let Some(target) = max_bytes else {
        return Ok((current_output, current_size, None));
    };
    if current_size <= target {
        return Ok((current_output, current_size, None));
    }

    #[cfg(target_os = "macos")]
    {
        if allow_quality_tuning {
            if let Some((optimized_output, optimized_size)) =
                best_sips_quality_candidate(&current_output, target)?
            {
                if optimized_size < current_size {
                    let _ = fs::remove_file(&current_output);
                    current_output = optimized_output;
                    current_size = optimized_size;
                }
            }
        }
    }

    let reason = if current_size <= target {
        None
    } else {
        Some(format!(
            "Could not reach max_bytes target {}; smallest output is {} bytes",
            target, current_size
        ))
    };
    Ok((current_output, current_size, reason))
}

#[cfg(target_os = "macos")]
pub(super) fn best_sips_quality_candidate(
    source: &Path,
    target: u64,
) -> Result<Option<(PathBuf, u64)>, String> {
    let mut best: Option<(PathBuf, u64)> = None;
    for quality in [85, 75, 65, 55, 45, 35, 25, 15] {
        let candidate = quality_candidate_path(source, quality);
        let sips_output = Command::new("sips")
            .arg("-s")
            .arg("format")
            .arg("jpeg")
            .arg("-s")
            .arg("formatOptions")
            .arg(quality.to_string())
            .arg(source)
            .arg("--out")
            .arg(&candidate)
            .output()
            .map_err(|e| {
                format!(
                    "Failed to run sips quality pass for {}: {}",
                    source.to_string_lossy(),
                    e
                )
            })?;
        if !sips_output.status.success() {
            let _ = fs::remove_file(&candidate);
            continue;
        }
        let candidate_size = fs::metadata(&candidate)
            .map_err(|e| {
                format!(
                    "Failed to read output metadata for {}: {}",
                    candidate.to_string_lossy(),
                    e
                )
            })?
            .len();
        if best
            .as_ref()
            .map(|(_, best_size)| candidate_size < *best_size)
            .unwrap_or(true)
        {
            if let Some((old_candidate, _)) = best.replace((candidate.clone(), candidate_size)) {
                let _ = fs::remove_file(old_candidate);
            }
        } else {
            let _ = fs::remove_file(&candidate);
        }
        if candidate_size <= target {
            break;
        }
    }
    Ok(best)
}

#[cfg(target_os = "macos")]
pub(super) fn quality_candidate_path(source: &Path, quality: u64) -> PathBuf {
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let parent = source.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{}-q{}.jpg", stem, quality))
}

pub(super) fn compression_ratio(original_size: u64, output_size: u64) -> f64 {
    if original_size == 0 {
        return 0.0;
    }
    ((output_size as f64 / original_size as f64) * 10_000.0).round() / 10_000.0
}
