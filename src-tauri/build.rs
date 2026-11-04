fn main() {
    println!("cargo:rerun-if-env-changed=APPLE_TEAM_ID");
    if std::env::var_os("CARGO_FEATURE_COMPRESSED_NODE_RUNTIME").is_some() {
        let team_id = std::env::var("APPLE_TEAM_ID")
            .expect("compressed Node release builds require APPLE_TEAM_ID");
        if team_id.len() != 10
            || !team_id
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
        {
            panic!("APPLE_TEAM_ID must be a 10-character Apple Team ID");
        }
        println!("cargo:rustc-env=ATOOLS_NODE_RUNTIME_EXPECTED_TEAM_ID={team_id}");
    }
    tauri_build::build()
}
