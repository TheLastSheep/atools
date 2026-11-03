//! Harness contract tests do not stand in for native browser observations.
use super::*;
use tauri::http::Request;

const SLOT: &str = "<script>const config=__ATOOLS_BOOTSTRAP_CONFIG__</script>";
const ENDPOINT_A: &str =
    "http://127.0.0.1:1234/host/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ENDPOINT_B: &str =
    "http://127.0.0.1:1234/host/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
fn pages() -> Arc<protocol::Pages> {
    protocol::Pages::new(
        "12345678-1234-4234-9234-123456789abc",
        "private-parent-nonce",
        SLOT.into(),
        SLOT.into(),
        SLOT.into(),
        SLOT.into(),
        [ENDPOINT_A.into(), ENDPOINT_B.into()],
    )
    .unwrap()
}
fn get(pages: &protocol::Pages, url: &str) -> tauri::http::Response<Vec<u8>> {
    pages.serve(
        Request::builder().uri(url).body(Vec::new()).unwrap(),
        "bootstrap-fixture",
    )
}
#[test]
fn bootstrap_is_capability_free_single_use_and_error_pages_cannot_execute_scripts() {
    let pages = pages();
    let parent_url = pages.parent_url();
    let parent = get(&pages, &parent_url);
    let parent_text = String::from_utf8(parent.body().clone()).unwrap();
    assert!(parent_text.contains("private-parent-nonce"));
    assert!(parent_text.contains(ENDPOINT_A));
    assert_eq!(get(&pages, &parent_url).status(), 410);
    for frame in &pages.frames {
        let url = frame["url"].as_str().unwrap();
        let page = get(&pages, url);
        assert_eq!(page.status(), 200);
        let text = String::from_utf8_lossy(page.body());
        for secret in [
            "private-parent-nonce",
            ENDPOINT_A,
            ENDPOINT_B,
            "synthetic-marker",
            "payloadHtml",
        ] {
            assert!(
                !text.contains(secret),
                "Capability-free bootstrap leaked {secret}"
            );
        }
        assert!(!page.headers().contains_key("access-control-allow-origin"));
        let replay = get(&pages, url);
        assert_eq!(replay.status(), 410);
        assert_eq!(replay.body(), b"Unavailable");
        assert!(replay.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("default-src 'none'; sandbox"));
    }
    let evidence = pages.evidence();
    assert!(evidence["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == "b" && row["status"] == 410 && row["scriptlessError"] == true));
    assert!(!evidence.to_string().contains(ENDPOINT_A));
}
#[test]
fn concurrent_bootstrap_requests_consume_one_ticket_exactly_once() {
    let pages = pages();
    let url = pages.frames[0]["url"].as_str().unwrap().to_string();
    let statuses: Vec<_> = std::thread::scope(|scope| {
        let jobs: Vec<_> = (0..8)
            .map(|_| scope.spawn(|| get(&pages, &url).status().as_u16()))
            .collect();
        jobs.into_iter().map(|job| job.join().unwrap()).collect()
    });
    assert_eq!(statuses.iter().filter(|status| **status == 200).count(), 1);
    assert_eq!(statuses.iter().filter(|status| **status == 410).count(), 7);
}
#[test]
fn raw_html_is_opaque_and_wrong_window_host_scheme_method_path_cannot_consume_ticket() {
    let pages = pages();
    let url = pages.frames[0]["url"].as_str().unwrap();
    let wrong = Request::builder().uri(url).body(Vec::new()).unwrap();
    assert_eq!(pages.serve(wrong, "other-window").status(), 403);
    assert_eq!(
        get(&pages, &url.replace("atools-origin:", "https:")).status(),
        403
    );
    assert_eq!(get(&pages, &format!("{url}?extra=1")).status(), 403);
    let mut wrong_port = tauri::Url::parse(url).unwrap();
    wrong_port.set_port(Some(2345)).unwrap();
    assert_eq!(get(&pages, wrong_port.as_str()).status(), 403);
    let post = Request::builder()
        .method("POST")
        .uri(url)
        .body(Vec::new())
        .unwrap();
    assert_eq!(pages.serve(post, "bootstrap-fixture").status(), 403);
    assert_eq!(get(&pages, url).status(), 200);
    let opaque_url = format!(
        "{}/opaque.html",
        pages.frames[1]["expectedOrigin"].as_str().unwrap()
    );
    let opaque = get(&pages, &opaque_url);
    assert_eq!(opaque.status(), 200);
    assert!(opaque.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .contains("sandbox allow-scripts"));
    for _ in 0..100 {
        get(&pages, "atools-origin://unknown.localhost/file.html");
    }
    let evidence = pages.evidence();
    assert_eq!(evidence["entries"].as_array().unwrap().len(), 96);
    assert_eq!(evidence["truncated"], true);
}
fn browser(pages: &protocol::Pages) -> Value {
    let checks = [
        "bootstrapHandoff",
        "payloadOriginPreserved",
        "syncHttpWorks",
        "asyncPreflightWorks",
        "foreignHttpDenied",
        "opaqueOriginDenied",
        "replayTicketDenied",
        "navigationIdentityInvalidated",
        "revocationAcknowledged",
        "noUnexpectedPayloadDelivery",
    ];
    let checks: serde_json::Map<String, Value> = checks
        .into_iter()
        .map(|key| (key.into(), json!(true)))
        .collect();
    let children:Vec<_>=pages.frames.iter().map(|frame|json!({"id":frame["id"],"origin":frame["expectedOrigin"],
        "noTauri":true,"markerReceived":true,"syncOk":true,"asyncOk":true,"foreignDenied":true,"bindingReplayRejected":true,"bindingRejectionCount":2,
        "bindingRejectionKinds":["docNonce","generation"],"payloadAttemptCount":3,"errorCodes":[]})).collect();
    json!({"status":"complete","checks":checks,"errors":[],"children":children,"deliveryCount":{"a":1,"b":1},
        "opaque":{"eventOrigin":"null","noTauri":true,"parentDomDenied":true,"siblingDomDenied":true,"beforeRevocationDenied":true,"afterRevocationDenied":true},
        "navigation":{"windowProxyUnchanged":true,"oldGenerationInvalidated":true},"revoked":{"ack":true}})
}
#[test]
fn validation_requires_actual_native_entry_replay_and_revocation_evidence() {
    let pages = pages();
    let entries: Vec<_> = ["a", "b"]
        .into_iter()
        .flat_map(|id| {
            ["sync", "async"]
                .into_iter()
                .map(move |phase| json!({"session":id,"id":id,"phase":phase}))
        })
        .collect();
    for fault in [
        "none",
        "extra-entry",
        "missing-revoked",
        "missing-410",
        "executable-error",
        "shared-origin",
        "missing-check",
        "opaque-origin",
        "missing-preflight",
        "missing-origin-rejection",
        "duplicate-binding-kind",
        "child-error",
    ] {
        let mut browser = browser(&pages);
        let mut transport = json!({"entered":entries,"revokedRequestCount":1,"preflightAccepted":2,"originRejected":3,"authenticationRejected":1});
        let mut protocol = json!({"truncated":false,"entries":[{"id":"b","kind":"bootstrap","status":410,"scriptlessError":true}]});
        match fault {
            "extra-entry" => transport["entered"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":"other"})),
            "missing-revoked" => transport["revokedRequestCount"] = json!(0),
            "missing-410" => protocol["entries"] = json!([]),
            "executable-error" => protocol["entries"][0]["scriptlessError"] = json!(false),
            "shared-origin" => {
                browser["children"][0]["origin"] = pages.frames[1]["expectedOrigin"].clone()
            }
            "missing-check" => {
                browser["checks"]
                    .as_object_mut()
                    .unwrap()
                    .remove("bootstrapHandoff");
            }
            "opaque-origin" => {
                browser["opaque"]["eventOrigin"] = json!("atools-origin://unexpected.localhost")
            }
            "missing-preflight" => transport["preflightAccepted"] = json!(0),
            "missing-origin-rejection" => transport["originRejected"] = json!(0),
            "duplicate-binding-kind" => {
                browser["children"][0]["bindingRejectionKinds"] = json!(["docNonce", "docNonce"])
            }
            "child-error" => browser["children"][0]["errorCodes"] = json!(["UNEXPECTED_FAILURE"]),
            _ => {}
        }
        assert_eq!(
            validation::validate(browser, &pages.frames, &transport, &protocol)["status"],
            if fault == "none" { "pass" } else { "failed" },
            "{fault}"
        );
    }
}
