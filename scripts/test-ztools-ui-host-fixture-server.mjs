import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

let mod;
try {
  mod = await import("./serve-ztools-ui-host-fixtures.mjs");
} catch {
  assert.fail("serve-ztools-ui-host-fixtures.mjs should export the fixture CORS server");
}

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(packageJson.scripts["test:ztools-ui-host-fixture-server"], "node scripts/test-ztools-ui-host-fixture-server.mjs");
assert.equal(packageJson.scripts["serve:ztools-ui-host-fixtures"], "node scripts/serve-ztools-ui-host-fixtures.mjs");

const root = await mkdtemp(join(tmpdir(), "atools-ztools-fixture-server-"));

async function writeFixture(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

try {
  await writeFixture(join(root, "index.html"), "<!doctype html><title>index fixture</title>");
  await writeFixture(join(root, "fixture.html"), "<!doctype html><title>fixture</title>");
  await writeFixture(join(root, "scripts", "app.js"), "window.fixtureScript = true;");
  await writeFixture(join(root, "json", "map_input.json"), "{\"ok\":true}");
  await writeFixture(join(root, "fonts", "fixture.woff2"), "fixture-font");
  const server = await mod.createZToolsUiHostFixtureServer({ root, host: "127.0.0.1", port: 0 });
  try {
    const baseUrl = `http://${server.host}:${server.port}`;
    const index = await fetch(`${baseUrl}/`, { headers: { Origin: "null" } });
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") || "", /text\/html/);
    assert.match(await index.text(), /index fixture/);

    const response = await fetch(`${baseUrl}/fixture.html`, { headers: { Origin: "null" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.match(response.headers.get("content-type") || "", /text\/html/);
    assert.match(await response.text(), /fixture/);

    const script = await fetch(`${baseUrl}/scripts/app.js`, { headers: { Origin: "null" } });
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") || "", /text\/javascript/);
    assert.match(await script.text(), /fixtureScript/);

    const json = await fetch(`${baseUrl}/json/map_input.json`, { headers: { Origin: "null" } });
    assert.equal(json.status, 200);
    assert.match(json.headers.get("content-type") || "", /application\/json/);
    assert.deepEqual(await json.json(), { ok: true });

    const font = await fetch(`${baseUrl}/fonts/fixture.woff2`, { headers: { Origin: "null" } });
    assert.equal(font.status, 200);
    assert.match(font.headers.get("content-type") || "", /font\/woff2/);
    assert.equal(await font.text(), "fixture-font");

    const head = await fetch(`${baseUrl}/scripts/app.js`, { method: "HEAD", headers: { Origin: "null" } });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type") || "", /text\/javascript/);
    assert.equal(await head.text(), "");

    const options = await fetch(`${baseUrl}/json/map_input.json`, {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("access-control-allow-origin"), "*");
    assert.match(options.headers.get("access-control-allow-methods") || "", /OPTIONS/);
    assert.match(options.headers.get("access-control-allow-headers") || "", /content-type/);

    const traversal = await fetch(`${baseUrl}/%2e%2e%2fpackage.json`, { headers: { Origin: "null" } });
    assert.equal(traversal.status, 403);
    assert.equal(await traversal.text(), "Forbidden");

    const malformedPath = await fetch(`${baseUrl}/%E0%A4%A`, {
      headers: { Origin: "null" },
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(malformedPath.status, 400);
    assert.equal(await malformedPath.text(), "Bad Request");
  } finally {
    await server.close();
  }

  const report = JSON.parse(await readFile(new URL("../output/ztools-plugin-ui-host-smoke-report.json", import.meta.url), "utf8"));
  assert.equal(report.real_entry_plugin_panel_matrix.browser_url, "http://127.0.0.1:1434/plugin-panel-matrix.html");
  assert.ok(
    report.ui_host_smoke_plans.every((plan) => plan.real_entry_plugin_panel.fixture_url.startsWith("http://127.0.0.1:1434/")),
    "real entry PluginPanel fixture URLs should use the fixture server base URL",
  );

  const checklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");
  assertCheckedChecklistRow(
    checklist,
    "Browser smoke 应使用 `pnpm serve:ztools-ui-host-fixtures -- --root output/ztools-ui-host-real-entry-fixtures --host 127.0.0.1 --port 1434` serve fixture 目录；该服务应支持 CORS headers、`OPTIONS` preflight、字体/script/json MIME，并保护 path traversal。",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

function assertCheckedChecklistRow(checklist, row) {
  assert.match(
    checklist,
    new RegExp(`^- \\[x\\] ${escapeRegExp(row)}`, "m"),
    `Expected checked macOS smoke checklist row containing: ${row}`,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
