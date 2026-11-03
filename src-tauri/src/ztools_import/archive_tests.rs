use super::*;
use std::io::Write;
use tempfile::TempDir;

fn plugin_manifest() -> &'static [u8] {
    br#"{
      "name":"ztools-archive-fixture",
      "title":"Archive Fixture",
      "version":"3.0.1",
      "main":"index.html",
      "preload":"preload.js",
      "features":[{"code":"archive","explain":"Archive","cmds":["archive"]}]
    }"#
}

fn asar_fixture() -> Vec<u8> {
    build_asar(
        &[
            ("plugin.json", plugin_manifest()),
            ("index.html", b"<main>archive</main>"),
            ("preload.js", b"window.fixture = true"),
        ],
        None,
    )
}

fn build_asar(files: &[(&str, &[u8])], link: Option<(&str, &str)>) -> Vec<u8> {
    let mut offset = 0usize;
    let mut entries = serde_json::Map::new();
    let mut content = Vec::new();
    for (name, data) in files {
        entries.insert(
            (*name).to_string(),
            serde_json::json!({ "size": data.len(), "offset": offset.to_string() }),
        );
        offset += data.len();
        content.extend_from_slice(data);
    }
    if let Some((name, target)) = link {
        entries.insert(name.to_string(), serde_json::json!({ "link": target }));
    }
    let json = serde_json::to_vec(&serde_json::json!({ "files": entries })).unwrap();
    let aligned_size = (json.len() + 3) & !3;
    let mut archive = Vec::with_capacity(16 + aligned_size + content.len());
    archive.extend_from_slice(&4u32.to_le_bytes());
    archive.extend_from_slice(&((aligned_size + 8) as u32).to_le_bytes());
    archive.extend_from_slice(&((aligned_size + 4) as u32).to_le_bytes());
    archive.extend_from_slice(&(json.len() as u32).to_le_bytes());
    archive.extend_from_slice(&json);
    archive.resize(16 + aligned_size, 0);
    archive.extend_from_slice(&content);
    archive
}

#[test]
fn scans_and_imports_asar_plugin() {
    let temp = TempDir::new().unwrap();
    let archive_path = temp.path().join("fixture.asar");
    fs::write(&archive_path, asar_fixture()).unwrap();

    let candidates = scan_ztools_plugin_candidates(&archive_path).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].source_type, "asar");
    assert!(candidates[0].errors.is_empty());

    let db = atools_core::Database::in_memory().unwrap();
    let install_root = temp.path().join("installed");
    let report = import_ztools_plugins(
        &db,
        &install_root,
        &[archive_path.to_string_lossy().to_string()],
        true,
    )
    .unwrap();
    assert_eq!(report.imported, vec!["ztools-archive-fixture"]);
    let installed = install_root.join("ztools-archive-fixture");
    assert_eq!(
        fs::read(installed.join("index.html")).unwrap(),
        b"<main>archive</main>"
    );
    assert!(installed.join("plugin.json").is_file());
}

#[test]
fn scans_gzip_and_brotli_zpx_plugins() {
    let temp = TempDir::new().unwrap();
    let asar = asar_fixture();

    let gzip_path = temp.path().join("gzip.zpx");
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(&asar).unwrap();
    fs::write(&gzip_path, gzip.finish().unwrap()).unwrap();

    let brotli_path = temp.path().join("brotli.zpx");
    let mut brotli_bytes = Vec::new();
    {
        let mut encoder = brotli::CompressorWriter::new(&mut brotli_bytes, 4096, 5, 22);
        encoder.write_all(&asar).unwrap();
    }
    fs::write(&brotli_path, brotli_bytes).unwrap();

    for path in [gzip_path, brotli_path] {
        let candidates = scan_ztools_plugin_candidates(&path).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].source_type, "zpx");
        assert_eq!(candidates[0].name, "ztools-archive-fixture");
    }
}

#[test]
fn rejects_asar_symbolic_links() {
    let temp = TempDir::new().unwrap();
    let archive_path = temp.path().join("linked.asar");
    fs::write(
        &archive_path,
        build_asar(
            &[
                ("plugin.json", plugin_manifest()),
                ("index.html", b"ok"),
                ("preload.js", b"ok"),
            ],
            Some(("linked.js", "preload.js")),
        ),
    )
    .unwrap();

    let error = stage_plugin_archive(&archive_path, &temp.path().join("installed")).unwrap_err();
    assert!(error.contains("symbolic links"));
}

#[test]
fn default_roots_include_ztools_3_plugins_directory() {
    assert!(default_ztools_plugin_roots()
        .iter()
        .any(|path| path.ends_with(Path::new(".ztools/plugins"))));
}
