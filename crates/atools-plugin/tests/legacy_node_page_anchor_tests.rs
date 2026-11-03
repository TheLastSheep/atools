use atools_plugin::legacy_node::LegacyNodeSession;
use serde_json::json;
use std::path::Path;

#[tokio::test]
async fn html_anchor_resolves_local_node_modules_without_executing_the_page() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("index.html"),
        r#"<script>throw new Error("must not run")</script>"#,
    )
    .unwrap();
    std::fs::write(
        temp.path().join("helper.cjs"),
        "module.exports = { answer: 42 }",
    )
    .unwrap();
    let session =
        LegacyNodeSession::start("synthetic-page-entry", temp.path(), Path::new("index.html"))
            .await
            .unwrap();
    let helper = session
        .request("require", json!({"specifier":"./helper.cjs"}))
        .await
        .unwrap();
    let answer = session
        .request(
            "get",
            json!({"handleId":helper["handleId"],"property":"answer"}),
        )
        .await
        .unwrap();
    assert_eq!(answer, json!({"kind":"value","value":42}));
    session.stop().await.unwrap();
}
