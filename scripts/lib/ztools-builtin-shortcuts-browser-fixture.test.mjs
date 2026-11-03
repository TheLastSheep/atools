import assert from "node:assert/strict";
import test from "node:test";
import { createBuiltinShortcutsBrowserFixture } from "./ztools-builtin-shortcuts-browser-fixture.mjs";

const context = { sessionId: "session", publish: async () => {} };
const patch = (fixture, changes, revision = fixture.read().revision) => fixture.handle({ sessionId: "session", operation: "patchGeneral",
  payload: { revision, changes: { builtinAppShortcutsEnabled: changes } } }, context);

test("synthetic General overlay preserves opaque and unsupported stored keys while projecting only search/esc", async () => {
  const fixture = createBuiltinShortcutsBrowserFixture();
  assert.deepEqual(fixture.read().value.builtinAppShortcutsEnabled, { search: true, esc: true });
  const before = fixture.snapshot().raw;
  assert.equal((await patch(fixture, { search: false })).ok, true);
  assert.deepEqual(fixture.snapshot().raw, { ...before, search: false });
  assert.equal(fixture.snapshot().mutations, 1);
  assert.equal(fixture.snapshot().notifications, 1);
  assert.equal((await patch(fixture, { killPlugin: false })).ok, false);
  assert.equal(fixture.snapshot().mutations, 1);
});

test("synthetic stale CAS and failed write leave values unchanged and permit a fresh-read retry", async () => {
  const fixture = createBuiltinShortcutsBrowserFixture();
  fixture.failNext("SETTINGS_REVISION_CONFLICT");
  assert.equal((await patch(fixture, { esc: false })).code, "SETTINGS_REVISION_CONFLICT");
  assert.equal(fixture.snapshot().raw.esc, true);
  assert.equal((await patch(fixture, { esc: false })).ok, true);
  fixture.failNext("GENERAL_SETTINGS_PATCH_FAILED");
  assert.equal((await patch(fixture, { esc: true })).ok, false);
  assert.equal(fixture.snapshot().raw.esc, false);
});

test("synthetic nonobject reads defaults and refuses mutation without rewriting the raw value", async () => {
  const fixture = createBuiltinShortcutsBrowserFixture();
  fixture.replaceRaw("legacy-bad-value");
  assert.deepEqual(fixture.read().value.builtinAppShortcutsEnabled, { search: true, esc: true });
  assert.equal((await patch(fixture, { search: false })).ok, false);
  assert.equal(fixture.snapshot().raw, "legacy-bad-value");
});
