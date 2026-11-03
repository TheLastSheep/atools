use super::request_identity;
use tauri::http::Request;

const ID: &str = "00000000000040008000000000000001";

fn request(uri: &str) -> Request<Vec<u8>> {
    Request::builder().uri(uri).body(Vec::new()).unwrap()
}

#[test]
fn accepts_only_canonical_local_settings_origins_and_asset_paths() {
    let parsed = request_identity(&request(&format!(
        "atools-settings://{ID}.localhost/assets/app.js"
    )))
    .unwrap();
    assert_eq!(parsed.0, format!("atools-settings://{ID}.localhost"));
    assert_eq!(parsed.1, "assets/app.js");

    for uri in [
        "https://example.test/assets/app.js",
        "atools-settings://outside.localhost/assets/app.js",
        "atools-settings://00000000000040008000000000000001.localhost:443/assets/app.js",
        "atools-settings://00000000000040008000000000000001.localhost/assets/%2e%2e/secret",
        "atools-settings://00000000000040008000000000000001.localhost/assets//app.js",
        "atools-settings://00000000000040008000000000000001.localhost/assets/app.js?mode=1",
    ] {
        assert!(request_identity(&request(uri)).is_none(), "accepted {uri}");
    }
}
