import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { captureZToolsUiHostScreenshots } from "./capture-ztools-ui-host-screenshots.mjs";
import { assertCheckedChecklistRow } from "./chrome-cdp-smoke-utils.mjs";

const checklistUrl = new URL("../docs/macos-smoke-checklist.md", import.meta.url);

const expectedChecklistRow = "Browser screenshot capture 应实际采集 report 的 20 个 `screenshot_viewports` PNG 像素 artifact，并校验每个 artifact 的 PNG header、视口尺寸、字节数、页面标题 `ATools 3.0`、插件名、`宿主探针 5/5`、console 0 warn/error、无 framework overlay、无横向溢出；这些 screenshot artifacts 才能作为后续自动化输入，而不是只记录 viewport plan。";

async function main() {
  const manifest = await captureZToolsUiHostScreenshots();
  assert.equal(manifest.status, "ready");
  assert.equal(manifest.expected_count, 20);
  assert.equal(manifest.captured_count, 20);
  assert.equal(manifest.console_issues.length, 0);
  assert.equal(manifest.captures.length, 20);

  for (const capture of manifest.captures) {
    assert.equal(capture.status, "ready", `${capture.plugin_id} ${capture.viewport.name} should be ready`);
    assert.equal(capture.title, "ATools 3.0");
    assert.equal(capture.host_probe_value, "5/5");
    assert.equal(capture.png_width, capture.viewport.width);
    assert.equal(capture.png_height, capture.viewport.height);
    assert.equal(capture.png_signature, true);
    assert.ok(capture.bytes > 4096, `${capture.path} should contain non-trivial PNG bytes`);
    assert.equal(capture.vite_overlay_count, 0);
    assert.equal(capture.document_overflows, false);
    assert.equal(capture.body_overflows, false);
  }

  const checklist = await readFile(checklistUrl, "utf8");
  assertCheckedChecklistRow(checklist, expectedChecklistRow);
}

await main();
