use std::path::Path;

#[test]
fn test_load_all_builtin_plugins() {
    let builtin_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("resources")
        .join("plugins")
        .join("builtin");

    if !builtin_dir.exists() {
        println!("Builtin dir does not exist, skipping");
        return;
    }

    let entries = std::fs::read_dir(&builtin_dir).unwrap();
    let mut total = 0;
    let mut loaded = 0;
    let mut failed = Vec::new();

    for entry in entries {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.is_dir() {
            total += 1;
            match atools_plugin::loader::load_plugin_from_disk(&path) {
                Ok(plugin) => {
                    loaded += 1;
                    assert!(!plugin.manifest.name.is_empty());
                }
                Err(e) => {
                    failed.push((
                        path.file_name().unwrap().to_string_lossy().to_string(),
                        e.to_string(),
                    ));
                }
            }
        }
    }

    println!(
        "Total scanned: {}, Loaded successfully: {}, Failed: {}",
        total,
        loaded,
        failed.len()
    );
    if !failed.is_empty() {
        for (name, err) in &failed {
            eprintln!("Failed plugin: {} -> {}", name, err);
        }
    }
    assert_eq!(
        failed.len(),
        0,
        "All builtin plugins must load without error"
    );
}

#[test]
fn test_assess_ztools_plugins_repository() {
    use atools_plugin::loader::{assess_ztools_plugin_compatibility, ZToolsCompatibilityTier};

    let ztools_plugins_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("ZTools-plugins")
        .join("plugins");

    if !ztools_plugins_dir.exists() {
        println!("ZTools-plugins/plugins dir does not exist, skipping");
        return;
    }

    let mut tier1 = 0usize;
    let mut tier2 = 0usize;
    let mut tier3 = 0usize;
    let mut failed = Vec::new();

    for entry in std::fs::read_dir(&ztools_plugins_dir).unwrap() {
        let path = entry.unwrap().path();
        if !path.is_dir() {
            continue;
        }
        // Only assess directories that actually contain a plugin.json candidate
        if !atools_plugin::package_resolution::has_manifest_candidate(&path) {
            continue;
        }
        match assess_ztools_plugin_compatibility(&path) {
            Ok(report) => match report.tier {
                ZToolsCompatibilityTier::Tier1DirectWebView => tier1 += 1,
                ZToolsCompatibilityTier::Tier2QuickJsOrNodeSidecar => tier2 += 1,
                ZToolsCompatibilityTier::Tier3RequiresBuildOrNativeAddon => tier3 += 1,
            },
            Err(err) => {
                failed.push((
                    path.file_name().unwrap().to_string_lossy().to_string(),
                    err.to_string(),
                ));
            }
        }
    }

    println!(
        "ZTools-plugins compatibility audit: Tier1={}, Tier2={}, Tier3={}, Failed={}",
        tier1,
        tier2,
        tier3,
        failed.len()
    );
    for (name, err) in &failed {
        eprintln!("Failed ZTools plugin manifest: {} -> {}", name, err);
    }
    assert_eq!(
        failed.len(),
        0,
        "All ZTools-plugins manifests must parse cleanly with compatibility tier classification"
    );
    assert!(tier1 + tier2 + tier3 >= 160);
}
