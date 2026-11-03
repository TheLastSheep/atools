//! Compare archive previews with canonical filesystem resolution using inert synthetic bytes.
use super::*;
use serde_json::{json, Value};
use std::{fs, io::Write};

fn asar(files: &[(&str, &[u8])]) -> Vec<u8> {
    fn insert(tree: &mut Value, path: &[&str], node: Value) {
        let files = tree["files"].as_object_mut().unwrap();
        if path.len() == 1 {
            files.insert(path[0].into(), node);
        } else {
            insert(
                files.entry(path[0]).or_insert_with(|| json!({"files":{}})),
                &path[1..],
                node,
            );
        }
    }
    let mut root = json!({"files":{}});
    let mut content = Vec::new();
    for (name, bytes) in files {
        insert(
            &mut root,
            &name.split('/').collect::<Vec<_>>(),
            json!({"size":bytes.len(),"offset":content.len().to_string()}),
        );
        content.extend_from_slice(bytes);
    }
    let header = serde_json::to_vec(&root).unwrap();
    let aligned = (header.len() + 3) & !3;
    let mut bytes = Vec::new();
    for size in [4, aligned + 8, aligned + 4, header.len()] {
        bytes.extend_from_slice(&(size as u32).to_le_bytes());
    }
    bytes.extend_from_slice(&header);
    bytes.resize(16 + aligned, 0);
    bytes.extend_from_slice(&content);
    bytes
}

fn assert_parity(manifest: Value, assets: &[(&str, &[u8])]) -> Vec<ZToolsImportCandidate> {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("directory");
    fs::create_dir(&source).unwrap();
    let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
    let mut files = vec![("plugin.json", manifest_bytes.as_slice())];
    files.extend_from_slice(assets);
    for (name, bytes) in &files {
        let path = source.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    let canonical = atools_plugin::package_resolution::resolve_plugin_package(&source);
    let zip_path = scratch.path().join("package.zip");
    let mut writer = ::zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
    for (name, bytes) in &files {
        writer
            .start_file(*name, ::zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
    let asar_path = scratch.path().join("package.asar");
    fs::write(&asar_path, asar(&files)).unwrap();
    let zip = super::super::zip::candidate(&zip_path);
    let asar = asar_candidate(&asar_path);
    match canonical {
        Err(error) => {
            assert!(zip.is_err(), "ZIP accepted canonical error: {error:#}");
            assert!(asar.is_err(), "ASAR accepted canonical error: {error:#}");
            Vec::new()
        }
        Ok(package) => [zip, asar]
            .into_iter()
            .map(|candidate| {
                let candidate = candidate.unwrap();
                assert_eq!(
                    candidate.entry_readiness.as_deref(),
                    Some(package.readiness.as_str()),
                    "{manifest}"
                );
                assert_eq!(candidate.name, package.manifest.name);
                let main_exists = package
                    .manifest
                    .main
                    .as_deref()
                    .is_some_and(|main| !main.trim().is_empty() && source.join(main).is_file());
                assert_eq!(candidate.main_exists, main_exists, "{manifest}");
                if package.readiness == PackageReadiness::Ready && candidate.platform_supported {
                    assert!(candidate.errors.is_empty(), "{:?}", candidate.errors);
                } else {
                    assert!(!candidate.errors.is_empty());
                }
                candidate
            })
            .collect(),
    }
}

#[test]
fn empty_main_and_explicit_web_runtime_entries_match_canonical() {
    let js_preloads = assert_parity(
        json!({"name":"js-preload","preload":"src/main.js"}),
        &[("src/main.js", b"throw Error('do not execute')")],
    );
    assert!(js_preloads
        .iter()
        .all(|candidate| candidate.entry_readiness.as_deref() == Some("ready")));
    assert_parity(
        json!({"name":"empty-main","main":"","preload":"preload.cjs"}),
        &[("preload.cjs", b"throw Error('must not execute')")],
    );
    for (entry, bytes) in [
        (
            "index.html",
            b"<script src='missing.js'></script>".as_slice(),
        ),
        ("entry.ts", b"const value:number=1".as_slice()),
        ("entry.js", b"throw Error('must not execute')".as_slice()),
    ] {
        assert_parity(
            json!({"name":"web-runtime","runtime":{"kind":"web","entry":entry}}),
            &[(entry, bytes)],
        );
    }
}

#[test]
fn current_platform_policy_is_shared_by_archive_formats() {
    let unsupported = if cfg!(target_os = "macos") {
        "win32"
    } else {
        "darwin"
    };
    let candidates = assert_parity(
        json!({"name":"platform","main":"index.html","platform":[unsupported]}),
        &[("index.html", b"<p>inert</p>")],
    );
    for candidate in candidates {
        assert!(!candidate.platform_supported);
        assert_eq!(candidate.entry_readiness.as_deref(), Some("ready"));
        assert!(!candidate.errors.is_empty());
    }
}

#[test]
fn native_runtime_priority_and_source_preloads_match_canonical() {
    assert_parity(
        json!({"name":"native","main":"index.html","runtime":{"kind":"node","entry":"missing.cjs","transport":"json_rpc_stdio"}}),
        &[("index.html", b"<p>UI exists</p>")],
    );
    assert_parity(
        json!({"name":"native","preload":"preload.ts","runtime":{"kind":"node","entry":"run.cjs","transport":"json_rpc_stdio"}}),
        &[
            ("preload.ts", b"const x:number=1"),
            ("run.cjs", b"throw Error('must not execute')"),
        ],
    );
    assert_parity(
        json!({"name":"source-main","main":"bundle.js"}),
        &[("bundle.js", b"console.log('not HTML')")],
    );
}

#[test]
fn nested_root_relative_assets_base_urls_and_external_warnings_match_canonical() {
    let candidates = assert_parity(json!({"name":"nested","main":"/pages/index.html"}), &[("pages/index.html", b"<base href='/assets/'><script src='main%20file.js'></script><link rel='stylesheet' href='/assets/app.css'><script src='https://example.invalid/external.js'></script>"), ("assets/main file.js", b"// inert"), ("assets/app.css", b"body{}")]);
    for candidate in candidates {
        assert!(candidate
            .warnings
            .iter()
            .any(|warning| warning.contains("not verified locally")));
    }
    assert_parity(
        json!({"name":"traversal","main":"index.html"}),
        &[("index.html", b"<script src='/%2e%2e/outside.js'></script>")],
    );
    assert_parity(
        json!({"name":"network","main":"index.html"}),
        &[(
            "index.html",
            b"<script src='%2f%2fhost/outside.js'></script>",
        )],
    );
}

#[test]
fn bounded_utf8_preload_html_and_manifest_reads_match_canonical() {
    let oversized = vec![b' '; MAX_PRELOAD_BYTES + 1];
    assert_parity(
        json!({"name":"large-preload","preload":"preload.cjs"}),
        &[("preload.cjs", &oversized)],
    );
    assert_parity(
        json!({"name":"bad-preload","preload":"preload.cjs"}),
        &[("preload.cjs", &[255, 254])],
    );
    assert_parity(
        json!({"name":"large-html","main":"index.html"}),
        &[("index.html", &vec![b' '; MAX_HTML_BYTES + 1])],
    );
    assert_parity(
        json!({"name":"large-manifest","description":"x".repeat(MAX_MANIFEST_BYTES)}),
        &[],
    );
    assert_parity(
        json!({"name":"","main":"index.html"}),
        &[("index.html", b"ready")],
    );
}

#[test]
fn missing_preloads_unsafe_logo_and_remote_metadata_match_canonical() {
    assert_parity(
        json!({"name":"missing-preload","main":"index.html","preload":"missing.js"}),
        &[("index.html", b"<p>inert</p>")],
    );
    assert_parity(
        json!({"name":"unsafe-logo","main":"index.html","logo":"../outside.png"}),
        &[("index.html", b"<p>inert</p>")],
    );
    assert_parity(
        json!({"name":"remote","main":"https://example.invalid/"}),
        &[],
    );
}
