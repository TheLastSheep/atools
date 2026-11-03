use super::*;
#[test]
fn actual_main_creation_seam_installs_exactly_one_webview_event_binding() {
    let mut installed = 0;
    bind_created(&"real-main", |main| {
        assert_eq!(*main, "real-main");
        installed += 1;
        Ok(())
    })
    .unwrap();
    assert_eq!(installed, 1);
}
#[test]
fn unknown_document_urls_and_document_routes_cannot_receive_os_paths() {
    for url in ["tauri://localhost/", "https://tauri.localhost/"] {
        assert!(trusted(&url.parse().unwrap()))
    }
    for url in [
        "https://example.com/",
        "tauri://localhost/#/settings",
        "tauri://localhost/?x=1",
        "atools-settings://abc.localhost/index.html",
        "tauri://localhost/plugin/a",
    ] {
        assert!(!trusted(&url.parse().unwrap()))
    }
}
