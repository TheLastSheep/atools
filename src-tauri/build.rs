use std::path::PathBuf;
use std::process::Command;

fn build_macos_vision_sidecar() {
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("macos") {
        return;
    }
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"));
    let target = std::env::var("TARGET").expect("TARGET must be set");
    let source = manifest_dir.join("native/vision-helper/main.swift");
    let binaries = manifest_dir.join("binaries");
    std::fs::create_dir_all(&binaries).expect("Failed to create sidecar output directory");
    let output = binaries.join(format!("pasteboard-vision-{target}"));
    let status = Command::new("xcrun")
        .env("MACOSX_DEPLOYMENT_TARGET", "10.15")
        .args([
            "swiftc",
            "-O",
            "-framework",
            "Foundation",
            "-framework",
            "ImageIO",
            "-framework",
            "Vision",
        ])
        .arg(&source)
        .arg("-o")
        .arg(&output)
        .status()
        .expect("Failed to launch xcrun swiftc for PasteboardPro Vision OCR");
    assert!(
        status.success(),
        "Failed to build PasteboardPro Vision OCR sidecar"
    );
}

fn main() {
    println!("cargo:rerun-if-changed=native/vision-helper/main.swift");
    println!("cargo:rerun-if-env-changed=TARGET");
    build_macos_vision_sidecar();
    tauri_build::build()
}
