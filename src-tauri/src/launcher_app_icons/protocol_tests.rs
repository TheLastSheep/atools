use super::*;

fn request(method: Method, uri: &str) -> Request<Vec<u8>> {
    Request::builder()
        .method(method)
        .uri(uri)
        .body(Vec::new())
        .unwrap()
}

#[test]
fn parses_only_the_opaque_icon_identity_forms() {
    let id = "0123456789abcdef".repeat(4);
    for uri in [
        format!("atools-app-icon://localhost/{id}.png"),
        format!("http://atools-app-icon.localhost/{id}.png"),
        format!("https://atools-app-icon.localhost/{id}.png"),
    ] {
        assert_eq!(parse_icon_request(&request(Method::GET, &uri)).unwrap(), id);
    }
}

#[test]
fn rejects_methods_authorities_and_noncanonical_paths() {
    let id = "a".repeat(64);
    assert_eq!(
        parse_icon_request(&request(
            Method::HEAD,
            &format!("atools-app-icon://localhost/{id}.png")
        )),
        Err(StatusCode::METHOD_NOT_ALLOWED)
    );
    for uri in [
        format!("atools-app-icon://user@localhost/{id}.png"),
        format!("atools-app-icon://localhost:80/{id}.png"),
        format!("atools-app-icon://remote/{id}.png"),
        format!("http://atools-app-icon.localhost:80/{id}.png"),
        format!("file://localhost/{id}.png"),
        format!("atools-app-icon://localhost/{}.png?x=1", "a".repeat(64)),
        format!("atools-app-icon://localhost/{}.png/extra", "a".repeat(64)),
        format!("atools-app-icon://localhost/{}.png", "A".repeat(64)),
        format!("atools-app-icon://localhost/{}.png", "g".repeat(64)),
    ] {
        assert_eq!(
            parse_icon_request(&request(Method::GET, &uri)),
            Err(StatusCode::BAD_REQUEST),
            "accepted unexpected URI {uri}"
        );
    }
    let non_empty = Request::builder()
        .method(Method::GET)
        .uri(format!("atools-app-icon://localhost/{id}.png"))
        .body(vec![1_u8])
        .unwrap();
    assert_eq!(parse_icon_request(&non_empty), Err(StatusCode::BAD_REQUEST));
}

#[test]
fn allows_only_fixed_local_main_origins() {
    for (raw, expected) in [
        ("tauri://localhost/", "tauri://localhost"),
        ("http://tauri.localhost/", "http://tauri.localhost"),
        ("https://tauri.localhost/", "https://tauri.localhost"),
        ("http://localhost:1420/", "http://localhost:1420"),
    ] {
        assert_eq!(
            trusted_local_origin(&Url::parse(raw).unwrap()).as_deref(),
            Some(expected)
        );
    }
    for raw in [
        "https://example.com/",
        "http://localhost/",
        "http://localhost:1421/",
        "http://tauri.localhost:1420/",
        "http://user@localhost:1420/",
    ] {
        assert_eq!(
            trusted_local_origin(&Url::parse(raw).unwrap()),
            None,
            "{raw}"
        );
    }
}

#[test]
fn origin_and_referer_must_match_the_local_main_origin() {
    let local = Request::builder()
        .header("origin", "http://localhost:1420")
        .body(Vec::new())
        .unwrap();
    assert_eq!(
        authorize_origin_headers("http://localhost:1420", &local).unwrap(),
        Some("http://localhost:1420".to_owned())
    );

    let remote_origin = Request::builder()
        .header("origin", "https://example.com")
        .body(Vec::new())
        .unwrap();
    assert_eq!(
        authorize_origin_headers("http://localhost:1420", &remote_origin),
        Err(StatusCode::FORBIDDEN)
    );

    let remote_referer = Request::builder()
        .header("referer", "https://example.com/frame")
        .body(Vec::new())
        .unwrap();
    assert_eq!(
        authorize_origin_headers("http://localhost:1420", &remote_referer),
        Err(StatusCode::FORBIDDEN)
    );
}

#[test]
fn icon_urls_hash_paths_without_exposing_them() {
    let path = "/Applications/Private Name.app";
    let url = icon_url(path);
    assert!(url.starts_with("atools-app-icon://localhost/"));
    assert!(url.ends_with(".png"));
    assert_eq!(url.len(), "atools-app-icon://localhost/".len() + 64 + 4);
    assert!(!url.contains("Private Name"));
    assert_eq!(url, icon_url(path));
    assert_ne!(url, icon_url("/Applications/Other.app"));
    let raw_path_hash = format!("{:x}", Sha256::digest(path.as_bytes()));
    let opaque_id = url
        .strip_prefix("atools-app-icon://localhost/")
        .unwrap()
        .strip_suffix(".png")
        .unwrap();
    assert_ne!(opaque_id, raw_path_hash);
}
