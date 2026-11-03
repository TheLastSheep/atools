use serde_json::json;

use super::child_delivery_script;

#[test]
fn child_delivery_encodes_script_shaped_unicode_and_quotes_as_json_data() {
    let script_like = "quote ' \" \\ newline\n雪\u{2028}\u{2029}</script>&";
    let script = child_delivery_script(&json!({ "text": script_like })).unwrap();

    assert!(script.contains("\\\""));
    assert!(script.contains("\\n"));
    assert!(script.contains("雪"));
    assert!(script.contains("\\u2028"));
    assert!(script.contains("\\u2029"));
    assert!(script.contains("\\u003c/script\\u003e\\u0026"));
    assert!(!script.contains("</script>"));
}
