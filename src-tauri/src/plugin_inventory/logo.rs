use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Component, Path},
};

use atools_core::Plugin;

use super::PluginSourceKind;

const MAX_LOGO_PATH_BYTES: usize = 512;
const MAX_PNG_BYTES: u64 = 256 * 1024;
const MAX_DIMENSION: u32 = 512;
const MAX_PIXELS: u64 = 512 * 512;
const PNG_HEADER_BYTES: usize = 33;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

pub(super) fn resolve_inventory_logo(
    plugin: &Plugin,
    canonical_plugin_root: Option<&Path>,
    source_kind: PluginSourceKind,
    imported_root: Option<&Path>,
    builtin_root: Option<&Path>,
) -> Option<String> {
    let trusted_root = match source_kind {
        PluginSourceKind::Builtin => builtin_root?,
        PluginSourceKind::Imported => imported_root?,
        PluginSourceKind::External => return None,
    };
    let plugin_root = canonical_plugin_root?;
    if plugin_root == trusted_root
        || !plugin_root.starts_with(trusted_root)
        || !plugin_root.is_dir()
    {
        return None;
    }

    let relative = validate_relative_logo_path(plugin.manifest.logo.as_deref()?)?;
    let candidate = plugin_root.join(relative);
    let logo_path = candidate.canonicalize().ok()?;
    if logo_path == plugin_root
        || !logo_path.starts_with(plugin_root)
        || !logo_path.starts_with(trusted_root)
        || !logo_path.extension()?.to_str()?.eq_ignore_ascii_case("png")
    {
        return None;
    }

    let path_metadata = fs::metadata(&logo_path).ok()?;
    if !path_metadata.is_file() || path_metadata.len() > MAX_PNG_BYTES {
        return None;
    }

    let mut file = open_logo_file(&logo_path)?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_PNG_BYTES {
        return None;
    }
    let mut header = [0; PNG_HEADER_BYTES];
    file.read_exact(&mut header).ok()?;
    if !valid_png_header(&header) {
        return None;
    }
    logo_path.to_str().map(str::to_owned)
}

fn open_logo_file(path: &Path) -> Option<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    options.open(path).ok()
}

fn validate_relative_logo_path(raw: &str) -> Option<&Path> {
    if raw.is_empty()
        || raw.len() > MAX_LOGO_PATH_BYTES
        || raw.chars().any(char::is_control)
        || raw.contains('\\')
        || raw.contains(':')
        || raw.starts_with('/')
        || raw
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    let path = Path::new(raw);
    if path.is_absolute()
        || !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return None;
    }
    Some(path)
}

fn valid_png_header(header: &[u8; PNG_HEADER_BYTES]) -> bool {
    if &header[..8] != PNG_SIGNATURE
        || u32::from_be_bytes(header[8..12].try_into().expect("fixed PNG header")) != 13
        || &header[12..16] != b"IHDR"
    {
        return false;
    }

    let width = u32::from_be_bytes(header[16..20].try_into().expect("fixed PNG header"));
    let height = u32::from_be_bytes(header[20..24].try_into().expect("fixed PNG header"));
    let bit_depth = header[24];
    let color_type = header[25];
    let compression = header[26];
    let filter = header[27];
    let interlace = header[28];
    let stored_crc = u32::from_be_bytes(header[29..33].try_into().expect("fixed PNG header"));

    width > 0
        && height > 0
        && width <= MAX_DIMENSION
        && height <= MAX_DIMENSION
        && u64::from(width) * u64::from(height) <= MAX_PIXELS
        && valid_bit_depth(color_type, bit_depth)
        && compression == 0
        && filter == 0
        && interlace <= 1
        && png_crc32(&header[12..29]) == stored_crc
}

fn valid_bit_depth(color_type: u8, bit_depth: u8) -> bool {
    match color_type {
        0 => matches!(bit_depth, 1 | 2 | 4 | 8 | 16),
        2 => matches!(bit_depth, 8 | 16),
        3 => matches!(bit_depth, 1 | 2 | 4 | 8),
        4 | 6 => matches!(bit_depth, 8 | 16),
        _ => false,
    }
}

fn png_crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn plugin(path: &Path, logo: Option<&str>, enabled: bool) -> Plugin {
        Plugin {
            id: "fixture".into(),
            name: "Fixture".into(),
            version: "1.0.0".into(),
            path: path.to_string_lossy().into_owned(),
            enabled,
            manifest: serde_json::from_value(json!({
                "name": "fixture",
                "logo": logo,
                "features": []
            }))
            .unwrap(),
            created_at: "2026-10-19T00:00:00Z".into(),
            updated_at: "2026-10-19T00:00:00Z".into(),
        }
    }

    fn crc_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = Vec::new();
        chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(data);
        let crc = png_crc32(&chunk[4..]);
        chunk.extend_from_slice(&crc.to_be_bytes());
        chunk
    }

    fn png_header(width: u32, height: u32) -> [u8; PNG_HEADER_BYTES] {
        let mut header = [0; PNG_HEADER_BYTES];
        header[..8].copy_from_slice(PNG_SIGNATURE);
        header[8..12].copy_from_slice(&13_u32.to_be_bytes());
        header[12..16].copy_from_slice(b"IHDR");
        header[16..20].copy_from_slice(&width.to_be_bytes());
        header[20..24].copy_from_slice(&height.to_be_bytes());
        header[24] = 8;
        header[25] = 6;
        let crc = png_crc32(&header[12..29]);
        header[29..33].copy_from_slice(&crc.to_be_bytes());
        header
    }

    fn valid_one_pixel_png() -> Vec<u8> {
        let mut png = PNG_SIGNATURE.to_vec();
        png.extend(crc_chunk(b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
        // zlib stream containing one unfiltered opaque RGBA pixel.
        png.extend(crc_chunk(
            b"IDAT",
            &[
                0x78, 0x01, 0x01, 0x05, 0, 0xfa, 0xff, 0, 0, 0, 0, 0xff, 0x01, 0x04, 0x01, 0x00,
            ],
        ));
        png.extend(crc_chunk(b"IEND", &[]));
        png
    }

    fn resolve(
        plugin: &Plugin,
        plugin_root: &Path,
        source_kind: PluginSourceKind,
        imported_root: &Path,
        builtin_root: Option<&Path>,
    ) -> Option<String> {
        resolve_inventory_logo(
            plugin,
            Some(plugin_root),
            source_kind,
            Some(imported_root),
            builtin_root,
        )
    }

    #[test]
    fn resolves_real_png_for_disabled_imported_and_builtin_records() {
        let temp = tempfile::tempdir().unwrap();
        let imported_root = temp.path().join("data/plugins");
        let builtin_root = temp.path().join("resources/plugins/builtin");
        let imported = imported_root.join("reader");
        let builtin = builtin_root.join("timer");
        fs::create_dir_all(&imported).unwrap();
        fs::create_dir_all(&builtin).unwrap();
        let png = valid_one_pixel_png();
        fs::write(imported.join("logo.PNG"), &png).unwrap();
        fs::write(builtin.join("logo.png"), &png).unwrap();

        let imported_plugin = plugin(&imported, Some("logo.PNG"), false);
        let builtin_plugin = plugin(&builtin, Some("logo.png"), false);
        let imported_path = imported.canonicalize().unwrap();
        let builtin_path = builtin.canonicalize().unwrap();
        let imported_canonical_root = imported_root.canonicalize().unwrap();
        let builtin_canonical_root = builtin_root.canonicalize().unwrap();

        assert_eq!(
            resolve(
                &imported_plugin,
                &imported_path,
                PluginSourceKind::Imported,
                &imported_canonical_root,
                Some(&builtin_canonical_root),
            ),
            Some(
                imported
                    .join("logo.PNG")
                    .canonicalize()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .into()
            )
        );
        assert_eq!(
            resolve(
                &builtin_plugin,
                &builtin_path,
                PluginSourceKind::Builtin,
                &imported_canonical_root,
                Some(&builtin_canonical_root),
            ),
            Some(
                builtin
                    .join("logo.png")
                    .canonicalize()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .into()
            )
        );
    }

    #[test]
    fn rejects_external_plugins_even_when_their_logo_is_valid() {
        let temp = tempfile::tempdir().unwrap();
        let imported = temp.path().join("plugins");
        let outside = temp.path().join("other/plugin");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("logo.png"), valid_one_pixel_png()).unwrap();
        let item = plugin(&outside, Some("logo.png"), true);
        assert_eq!(
            resolve_inventory_logo(
                &item,
                outside.canonicalize().ok().as_deref(),
                PluginSourceKind::External,
                imported.canonicalize().ok().as_deref(),
                None,
            ),
            None
        );
    }

    #[test]
    fn rejects_remote_absolute_traversal_control_and_unbounded_logo_names() {
        let too_long = "x".repeat(MAX_LOGO_PATH_BYTES + 1);
        for invalid in [
            "https://example.test/logo.png",
            "data:image/png;base64,AA==",
            "asset://localhost/logo.png",
            "/tmp/logo.png",
            "//server/share/logo.png",
            r"C:\\icons\\logo.png",
            r"..\\outside.png",
            "../outside.png",
            "./logo.png",
            "icons//logo.png",
            "logo.png\n",
            "",
            too_long.as_str(),
        ] {
            assert!(
                validate_relative_logo_path(invalid).is_none(),
                "accepted {invalid:?}"
            );
        }
        assert_eq!(
            validate_relative_logo_path("icons/logo.png"),
            Some(Path::new("icons/logo.png"))
        );
    }

    #[test]
    fn accepts_valid_ihdr_boundary_and_rejects_bad_signature_crc_and_dimensions() {
        let boundary = png_header(512, 512);
        assert!(valid_png_header(&boundary));
        for header in [png_header(0, 1), png_header(513, 1), png_header(512, 513)] {
            assert!(!valid_png_header(&header));
        }
        let mut bad_signature = png_header(1, 1);
        bad_signature[0] = 0;
        assert!(!valid_png_header(&bad_signature));
        let mut bad_crc = png_header(1, 1);
        bad_crc[32] ^= 1;
        assert!(!valid_png_header(&bad_crc));
        let mut bad_type = png_header(1, 1);
        bad_type[12] = b'X';
        assert!(!valid_png_header(&bad_type));
        let mut invalid_depth = png_header(1, 1);
        invalid_depth[24] = 3;
        let crc = png_crc32(&invalid_depth[12..29]);
        invalid_depth[29..33].copy_from_slice(&crc.to_be_bytes());
        assert!(!valid_png_header(&invalid_depth));
    }

    #[test]
    fn rejects_oversized_non_png_and_short_files() {
        let temp = tempfile::tempdir().unwrap();
        let imported = temp.path().join("plugins");
        let plugin_root = imported.join("reader");
        fs::create_dir_all(&plugin_root).unwrap();
        let root = imported.canonicalize().unwrap();
        let plugin_path = plugin_root.canonicalize().unwrap();
        let item = plugin(&plugin_root, Some("logo.png"), true);

        let mut oversized = valid_one_pixel_png();
        oversized.resize(MAX_PNG_BYTES as usize + 1, 0);
        fs::write(plugin_root.join("logo.png"), oversized).unwrap();
        assert_eq!(
            resolve(&item, &plugin_path, PluginSourceKind::Imported, &root, None),
            None
        );

        fs::write(plugin_root.join("logo.png"), b"<svg></svg>").unwrap();
        assert_eq!(
            resolve(&item, &plugin_path, PluginSourceKind::Imported, &root, None),
            None
        );

        fs::write(plugin_root.join("logo.png"), &PNG_SIGNATURE[..4]).unwrap();
        assert_eq!(
            resolve(&item, &plugin_path, PluginSourceKind::Imported, &root, None),
            None
        );
        fs::write(plugin_root.join("logo.svg"), valid_one_pixel_png()).unwrap();
        let wrong_extension = plugin(&plugin_root, Some("logo.svg"), true);
        assert_eq!(
            resolve(
                &wrong_extension,
                &plugin_path,
                PluginSourceKind::Imported,
                &root,
                None
            ),
            None
        );

        fs::write(plugin_root.join("logo.png"), valid_one_pixel_png()).unwrap();
        assert!(
            resolve(&item, &plugin_path, PluginSourceKind::Imported, &root, None).is_some(),
            "valid full 1x1 PNG fixture should resolve"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_logo_symlink_escape_from_plugin_root() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let imported = temp.path().join("plugins");
        let plugin_root = imported.join("reader");
        let outside = temp.path().join("outside.png");
        fs::create_dir_all(&plugin_root).unwrap();
        fs::write(&outside, valid_one_pixel_png()).unwrap();
        symlink(&outside, plugin_root.join("logo.png")).unwrap();
        let item = plugin(&plugin_root, Some("logo.png"), true);
        assert_eq!(
            resolve(
                &item,
                &plugin_root.canonicalize().unwrap(),
                PluginSourceKind::Imported,
                &imported.canonicalize().unwrap(),
                None,
            ),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_fifo_without_a_writer_instead_of_waiting_on_open() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};

        let temp = tempfile::tempdir().unwrap();
        let imported = temp.path().join("plugins");
        let plugin_root = imported.join("reader");
        fs::create_dir_all(&plugin_root).unwrap();
        let fifo = plugin_root.join("logo.png");
        let fifo_c = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);

        let item = plugin(&plugin_root, Some("logo.png"), true);
        assert_eq!(
            resolve(
                &item,
                &plugin_root.canonicalize().unwrap(),
                PluginSourceKind::Imported,
                &imported.canonicalize().unwrap(),
                None,
            ),
            None
        );
    }
}
