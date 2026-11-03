use super::*;
use serde_json::json;

// Recorded metadata shape from the official latest endpoint. This test performs no I/O.
fn recorded_available() -> Value {
    json!({
        "available": true,
        "plugin": {
            "name": "regex-editor",
            "title": "正则可视编辑器",
            "version": "1.0.0",
            "logo": "https://ztools.zosen.link/images/logo/regex-editor-1.0.0.png",
            "updatedAt": 1780469251000_u64,
            "sourceType": "open_source",
            "sourceLabel": "开源插件"
        }
    })
}

#[test]
fn recorded_available_metadata_maps_without_local_version_or_artifact_inference() {
    let lookup = normalize_target_lookup("regex-editor", recorded_available()).unwrap();
    assert_eq!(lookup.status, OfficialPluginTargetStatus::Available);
    assert_eq!(lookup.plugin_id, "regex-editor");
    assert_eq!(lookup.source_url, OFFICIAL_SOURCE);
    assert_eq!(lookup.source_kind, PluginMarketCatalogSourceKind::Ztools);
    let plugin = lookup.plugin.unwrap();
    assert_eq!(plugin.id, "regex-editor");
    assert_eq!(plugin.name, "正则可视编辑器");
    assert_eq!(plugin.version, "1.0.0");
    assert_eq!(plugin.updated_at.as_deref(), Some("1780469251000"));
    assert_eq!(
        plugin.logo.as_deref(),
        Some("https://ztools.zosen.link/images/logo/regex-editor-1.0.0.png")
    );
    assert_eq!(
        plugin.download_resolver_url.as_deref(),
        Some("https://z-tools.top/api/market/plugins/download?name=regex-editor")
    );
    assert_eq!(plugin.trust_policy, "official_ztools_confirm");
    assert_eq!(plugin.description, "");
    assert!(plugin.download_url.is_none());
    assert!(plugin.checksum.is_none());
    assert!(plugin.signature.is_none());
    assert!(plugin.public_key.is_none());
    assert!(plugin.author.is_none());
    assert!(plugin.publisher.is_none());
    assert!(plugin.publisher_url.is_none());
    assert!(plugin.rating.is_none());
    assert!(plugin.rating_count.is_none());
    assert!(plugin.downloads.is_none());
    assert!(plugin.package_size.is_none());
    assert!(plugin.homepage.is_none());
    assert!(plugin.category.is_none());
}

#[test]
fn known_absence_reasons_are_distinct_and_never_produce_install_metadata() {
    for (reason, status) in [
        ("not_found", OfficialPluginTargetStatus::NotFound),
        (
            "unsupported_platform",
            OfficialPluginTargetStatus::UnsupportedPlatform,
        ),
    ] {
        let lookup =
            normalize_target_lookup("Absent-ID", json!({"available":false,"reason":reason}))
                .unwrap();
        assert_eq!(lookup.plugin_id, "Absent-ID");
        assert_eq!(lookup.status, status);
        assert!(lookup.plugin.is_none());
    }
}

#[test]
fn malformed_and_error_envelopes_are_errors_instead_of_not_found() {
    for raw in [
        json!(null),
        json!([]),
        json!({}),
        json!({"error":"temporarily unavailable"}),
        json!({"data":recorded_available()}),
        json!({"available":"false","reason":"not_found"}),
        json!({"available":0,"reason":"not_found"}),
        json!({"available":false}),
        json!({"available":false,"reason":null}),
        json!({"available":false,"reason":123}),
        json!({"available":false,"reason":"maintenance"}),
        json!({"available":false,"reason":"not_found "}),
        json!({"available":false,"reason":"not_found","error":"upstream failed"}),
        json!({"available":false,"reason":"not_found","success":false}),
        json!({"available":true}),
        json!({"available":true,"plugin":null}),
        json!({"available":true,"plugin":{}}),
        json!({"available":true,"plugin":[]}),
    ] {
        assert!(
            normalize_target_lookup("regex-editor", raw.clone()).is_err(),
            "accepted {raw}"
        );
    }
}

#[test]
fn contradictory_envelopes_are_errors() {
    let mut available = recorded_available();
    available["reason"] = json!("not_found");
    assert!(normalize_target_lookup("regex-editor", available).is_err());
    let mut unavailable = recorded_available();
    unavailable["available"] = json!(false);
    unavailable["reason"] = json!("not_found");
    assert!(normalize_target_lookup("regex-editor", unavailable).is_err());
}

#[test]
fn additive_metadata_is_allowed_but_explicit_failure_signals_are_errors() {
    let mut additive = recorded_available();
    additive["timestamp"] = json!("2026-10-15T00:00:00Z");
    additive["metadata"] = json!({"revision":2});
    additive["success"] = json!(true);
    additive["errorCode"] = json!(0);
    additive["resultCode"] = json!("0");
    assert!(normalize_target_lookup("regex-editor", additive).is_ok());
    for (field, value) in [
        ("success", json!(false)),
        ("errorCode", json!(1)),
        ("resultCode", json!("-1")),
        ("error_code", json!(503)),
        ("result_code", json!("UPSTREAM_FAILED")),
        ("error", json!("temporary failure")),
        ("errors", json!(["temporary failure"])),
        ("code", json!(500)),
        ("code", json!("403")),
        ("code", json!("FAILED")),
    ] {
        let mut raw = recorded_available();
        raw[field] = value.clone();
        assert!(
            normalize_target_lookup("regex-editor", raw).is_err(),
            "accepted {field}={value}"
        );
    }
}

#[test]
fn returned_identity_must_match_exact_original_bytes() {
    for name in [
        "Regex-editor",
        "regex-editor-legacy",
        " regex-editor",
        "正则可视编辑器",
        "",
    ] {
        let mut raw = recorded_available();
        raw["plugin"]["name"] = json!(name);
        assert!(
            normalize_target_lookup("regex-editor", raw).is_err(),
            "accepted {name}"
        );
    }
    let composed = "Éditor";
    let decomposed = "E\u{301}ditor";
    let mut raw = recorded_available();
    raw["plugin"]["name"] = json!(decomposed);
    assert!(normalize_target_lookup(composed, raw.clone()).is_err());
    assert_eq!(
        normalize_target_lookup(decomposed, raw)
            .unwrap()
            .plugin
            .unwrap()
            .id,
        decomposed
    );
}

#[test]
fn missing_malformed_or_unbounded_versions_are_errors() {
    for version in [
        json!(null),
        json!(0),
        json!(""),
        json!("  "),
        json!("1\n.0"),
        json!("v".repeat(129)),
        json!("版".repeat(43)),
    ] {
        let mut raw = recorded_available();
        raw["plugin"]["version"] = version.clone();
        assert!(
            normalize_target_lookup("regex-editor", raw).is_err(),
            "accepted {version}"
        );
    }
    let mut raw = recorded_available();
    raw["plugin"].as_object_mut().unwrap().remove("version");
    assert!(normalize_target_lookup("regex-editor", raw).is_err());
    let mut boundary = recorded_available();
    boundary["plugin"]["version"] = json!("v".repeat(128));
    assert_eq!(
        normalize_target_lookup("regex-editor", boundary)
            .unwrap()
            .plugin
            .unwrap()
            .version
            .len(),
        128
    );
}

#[test]
fn validates_ids_by_utf8_bytes_without_case_or_unicode_normalization() {
    assert_eq!(validate_plugin_id("  MiXeD-正则  ").unwrap(), "MiXeD-正则");
    assert_eq!(
        validate_plugin_id("E\u{301}ditor").unwrap(),
        "E\u{301}ditor"
    );
    assert_eq!(validate_plugin_id(&"a".repeat(256)).unwrap().len(), 256);
    for id in [
        "".to_string(),
        "  ".to_string(),
        "a".repeat(257),
        "中".repeat(86),
        "id\0".to_string(),
        "\nid".to_string(),
        "id\u{7f}".to_string(),
        "id\u{85}".to_string(),
    ] {
        assert!(validate_plugin_id(&id).is_err(), "accepted {id:?}");
    }
}

#[test]
fn request_urls_encode_ids_without_host_path_or_query_injection() {
    let id = "MiXeD-正则&platform=win32?#/+%";
    let url = latest_url(id, "darwin").unwrap();
    assert_eq!(url.scheme(), "https");
    assert_eq!(url.host_str(), Some("z-tools.top"));
    assert_eq!(url.path(), "/api/market/plugins/latest");
    assert_eq!(url.fragment(), None);
    assert_eq!(
        url.query_pairs().collect::<Vec<_>>(),
        vec![
            ("name".into(), id.into()),
            ("platform".into(), "darwin".into())
        ]
    );
    assert!(url
        .as_str()
        .contains("%E6%AD%A3%E5%88%99%26platform%3Dwin32%3F%23%2F%2B%25"));
    let resolver = Url::parse(&download_resolver_url(id).unwrap()).unwrap();
    assert_eq!(resolver.host_str(), Some("z-tools.top"));
    assert_eq!(resolver.path(), "/api/market/plugins/download");
    assert_eq!(
        resolver.query_pairs().collect::<Vec<_>>(),
        vec![("name".into(), id.into())]
    );
    for platform in ["darwin", "win32", "linux"] {
        assert_eq!(
            latest_url("Exact-ID", platform)
                .unwrap()
                .query_pairs()
                .last()
                .unwrap()
                .1,
            platform
        );
    }
}

#[test]
fn optional_display_metadata_has_safe_fallbacks_and_strict_field_types() {
    let mut raw = recorded_available();
    raw["plugin"]["title"] = json!(" ");
    raw["plugin"]["description"] = json!(" official description ");
    raw["plugin"]["logo"] = json!("javascript:alert(1)");
    raw["plugin"]["updatedAt"] = json!("2026-10-15T00:00:00Z");
    let plugin = normalize_target_lookup("regex-editor", raw)
        .unwrap()
        .plugin
        .unwrap();
    assert_eq!(plugin.name, "regex-editor");
    assert_eq!(plugin.description, "official description");
    assert!(plugin.logo.is_none());
    assert_eq!(plugin.updated_at.as_deref(), Some("2026-10-15T00:00:00Z"));
    for (key, value) in [
        ("title", json!(12)),
        ("logo", json!({})),
        ("description", json!([])),
        ("updatedAt", json!(false)),
    ] {
        let mut raw = recorded_available();
        raw["plugin"][key] = value;
        assert!(normalize_target_lookup("regex-editor", raw).is_err());
    }
}

#[test]
fn response_contract_uses_snake_case_and_status_literals() {
    let lookup = normalize_target_lookup(
        "id",
        json!({"available":false,"reason":"unsupported_platform"}),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(lookup).unwrap(),
        json!({
            "plugin_id":"id", "source_url":"https://z-tools.top/api/market", "source_kind":"ztools", "status":"unsupported_platform", "plugin":null
        })
    );
}
