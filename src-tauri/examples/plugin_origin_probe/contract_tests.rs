//! These tests validate the harness, not browser SOP or real rendering.
use super::*;
use base64::Engine;
use tauri::http::Request;

fn pages() -> Arc<protocol::Pages> {
    protocol::Pages::new(
        "12345678-1234-4234-9234-123456789abc",
        "parent-private-nonce",
        "<script>const config=__ATOOLS_ORIGIN_CONFIG__</script>".into(),
        "<script>const config=__ATOOLS_ORIGIN_CONFIG__</script>".into(),
        b"fixture-library".to_vec(),
    )
    .unwrap()
}
fn get(pages: &protocol::Pages, url: &str, window: &str) -> tauri::http::Response<Vec<u8>> {
    pages.serve(
        Request::builder().uri(url).body(Vec::new()).unwrap(),
        window,
    )
}
#[test]
fn generated_configuration_keeps_parent_nonce_out_of_children_and_has_only_two_peer_indexes() {
    let pages = pages();
    let parent = get(&pages, &pages.parent_url(), "origin-fixture");
    assert!(String::from_utf8_lossy(parent.body()).contains("parent-private-nonce"));
    for (index, frame) in pages.frames.iter().enumerate() {
        let response = get(&pages, frame["url"].as_str().unwrap(), "origin-fixture");
        let text = String::from_utf8(response.body().clone()).unwrap();
        assert!(!text.contains("parent-private-nonce"));
        let json = text
            .strip_prefix("<script>const config=")
            .unwrap()
            .strip_suffix("</script>")
            .unwrap();
        let config: Value = serde_json::from_str(json).unwrap();
        let peers = config["peerIndexes"].as_array().unwrap();
        assert_eq!(peers.len(), 2);
        assert!(!peers.contains(&json!(index)));
        assert!(response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("worker-src 'none'"));
        assert!(!response
            .headers()
            .contains_key("access-control-allow-origin"));
    }
}
#[test]
fn synthetic_protocol_rejects_foreign_windows_hosts_schemes_methods_and_unknown_paths() {
    let pages = pages();
    assert_eq!(
        get(&pages, &pages.parent_url(), "other-window").status(),
        403
    );
    assert_eq!(
        get(
            &pages,
            "atools-origin://unknown.localhost/index.html",
            "origin-fixture"
        )
        .status(),
        403
    );
    assert_eq!(
        get(
            &pages,
            &pages.parent_url().replace("atools-origin:", "https:"),
            "origin-fixture"
        )
        .status(),
        403
    );
    let post = Request::builder()
        .method("POST")
        .uri(pages.parent_url())
        .body(Vec::new())
        .unwrap();
    assert_eq!(pages.serve(post, "origin-fixture").status(), 403);
    assert_eq!(
        get(
            &pages,
            &pages.parent_url().replace("index.html", "other.js"),
            "origin-fixture"
        )
        .status(),
        404
    );
    for _ in 0..140 {
        get(&pages, &pages.parent_url(), "origin-fixture");
    }
    let evidence = pages.request_evidence();
    assert_eq!(evidence["entries"].as_array().unwrap().len(), 128);
    assert_eq!(evidence["truncated"], true);
}
fn image_base64(width: u32) -> String {
    let mut image = image::RgbaImage::from_pixel(width, 48, image::Rgba([18, 52, 86, 255]));
    for x in 8..24 {
        for y in 8..24 {
            image.put_pixel(x, y, image::Rgba([255, 102, 0, 255]));
        }
    }
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
}
fn browser(pages: &protocol::Pages) -> Value {
    let keys = [
        "originsNonOpaqueAndDistinct",
        "originsMatchExpected",
        "parentDomDenied",
        "siblingDomDenied",
        "noChildTauri",
        "nestedCloneWorks",
        "html2canvasRendered",
        "foreignWindowProxyStable",
        "foreignOriginChanged",
        "foreignRejectedByOldIdentity",
        "parentPositiveControlWorks",
    ];
    let checks: serde_json::Map<String, Value> = keys
        .into_iter()
        .map(|key| (key.into(), json!(true)))
        .collect();
    let png = image_base64(128);
    let children: Vec<_> = pages
        .frames
        .iter()
        .map(|frame| {
            json!({"id":frame["id"],"initialEventOrigin":frame["expectedOrigin"],
        "initial":{"canvas":{"pngBase64":png}}})
        })
        .collect();
    json!({"checks":checks,"status":"complete","errors":[],"children":children,"classifications":{"storage":"observed-isolated"}})
}
#[test]
fn independent_decoder_rejects_wrong_dimensions_native_command_entry_and_missing_browser_evidence()
{
    let pages = pages();
    for fault in [
        "none",
        "native",
        "dimensions",
        "missing-check",
        "browser-error",
        "shared-storage",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut report = browser(&pages);
        let entered = if fault == "native" {
            vec!["parent-positive".into(), "a1-wrong-key".into()]
        } else {
            vec!["parent-positive".into()]
        };
        match fault {
            "dimensions" => {
                report["children"][0]["initial"]["canvas"]["pngBase64"] = json!(image_base64(129))
            }
            "missing-check" => {
                report["checks"]
                    .as_object_mut()
                    .unwrap()
                    .remove("nestedCloneWorks");
            }
            "browser-error" => report["errors"] = json!([{"message":"did not finish"}]),
            "shared-storage" => {
                report["classifications"]["storage"] = json!("observed-shared-or-mismatched")
            }
            _ => {}
        }
        let result = validation::validate(
            report,
            &pages.frames,
            &entered,
            &dir.path().join("report.json"),
            "fixed-test-run",
        );
        assert_eq!(
            result["status"],
            if fault == "none" { "pass" } else { "failed" },
            "{fault}"
        );
        assert!(!result.to_string().contains("pngBase64"));
        assert_eq!(result["productionReady"], false);
    }
}
