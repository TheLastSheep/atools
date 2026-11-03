import assert from "node:assert/strict";
import test from "node:test";
import { makeLaunchReturnSettingsRegistrationFixture } from "./ztools-launch-return-settings-fixtures.mjs";
import { validateLaunchReturnSettingsRegistration } from "./ztools-launch-return-settings-registration.mjs";

const runId = "0123456789ab4def8123456789abcdef";
const root = `/private/tmp/atools-renderer-launch-return-${runId}`;
function fixture() {
  const { registration, ...owner } = makeLaunchReturnSettingsRegistrationFixture(root);
  return { value: registration, owner: { ...owner, root, runId } };
}
function validate(value) { return validateLaunchReturnSettingsRegistration(value.value, value.owner); }

test("accepts a complete Settings child registration contract with independently supplied SQLite rows", () => {
  const sample = fixture();
  assert.deepEqual(validate(sample), { valid: true, errors: [] });
  sample.value.secondChild.url += "?_t=9007199254740991";
  sample.value.firstChild.documentHasFocus = true;
  assert.equal(validate(sample).valid, true, "child DOM observations retain actual values under the hidden parent policy");
  sample.value.alias.rows[0].pinyin = "atoolsr68alias";
  sample.value.alias.rows[0].pinyinAbbr = "ar68a";
  assert.equal(validate(sample).valid, true, "Core recomputes display metadata when the alias changes");
});

test("fails closed for every missing or unknown registration object field", () => {
  const scopes = [[], ["fixturePaths"], ["initial"], ["firstChild"], ["secondChild"], ["drop"], ["drop", "binding"],
    ["alias"], ["firstClose"], ["finalClose"], ["aliasSearch"], ["reopen"], ["cleanup"], ["acl"], ["identity"], ["mainEvents"], ["mainCalls"]];
  for (const scope of scopes) {
    const sample = fixture();
    const object = scope.reduce((current, key) => current[key], sample.value);
    for (const key of Object.keys(object)) {
      const mutated = fixture();
      delete scope.reduce((current, field) => current[field], mutated.value)[key];
      assert.equal(validate(mutated).valid, false, `missing ${[...scope, key].join(".")}`);
    }
    object.invented = true;
    assert.equal(validate(sample).valid, false, `extra ${scope.join(".")}`);
  }
});

test("rejects invented sources, child roles, nonce reuse, stale revisions, rows, ACL and focus evidence", () => {
  const mutations = [
    sample => { sample.value.inputSource = "physical-os-drop"; },
    sample => { sample.value.physicalOsDrop = true; },
    sample => { sample.value.status = "not_run"; },
    sample => { sample.value.deadlineMs = 120000; },
    sample => { sample.value.initial.rows = sample.value.drop.rows; },
    sample => { sample.value.fixturePaths.file = "/private/tmp/unowned"; },
    sample => { sample.owner.root += "/other"; },
    sample => { sample.owner.runId = "1".repeat(32); },
    sample => { sample.value.firstChild.label = "main"; },
    sample => { sample.value.firstChild.phase = "Open"; },
    sample => { sample.value.firstChild.documentVisibility = "prerender"; },
    sample => { sample.value.secondChild = { ...sample.value.firstChild }; },
    sample => { sample.value.secondChild.url += "?_t=01"; },
    sample => { sample.value.secondChild.url += "?_t=9007199254740992"; },
    sample => { sample.value.secondChild.bundleRevision = "b".repeat(64); },
    sample => { sample.value.drop.binding.batchNonce = sample.value.drop.binding.bindingNonce; },
    sample => { sample.value.drop.binding.bindingNonce = "1".repeat(32); },
    sample => { sample.value.drop.binding.childLabel = sample.value.secondChild.label; },
    sample => { sample.value.drop.binding.added = 3; },
    sample => { sample.value.drop.binding.resultNoticeEnqueued = false; },
    sample => { sample.value.drop.feedback = false; },
    sample => { sample.value.drop.rows[0].path = sample.value.drop.rows[1].path; },
    sample => { sample.value.drop.rows[1].id = sample.value.drop.rows[0].id; },
    sample => { sample.value.alias.rows[0].addedAt += 1; },
    sample => { sample.value.aliasSearch.launchCallsAfter = 1; },
    sample => { sample.value.firstClose.bindingActive = true; },
    sample => { sample.value.finalClose.pendingWrites = 1; },
    sample => { sample.value.cleanup.rows[0].alias = ""; },
    sample => { sample.value.cleanup.rows[0].id = "00000000-0000-4000-8000-000000000009"; },
    sample => { sample.value.cleanup.revision = 9; },
    sample => { sample.owner.registrationSqlite.rows[0].name = "fake.app"; },
    sample => { sample.owner.registrationSqlite.valid = false; },
    sample => { sample.value.acl.dragOver = "allowed"; },
    sample => { sample.value.identity.nonceBound = false; },
    sample => { sample.value.identity.childRoleBound = false; },
    sample => { sample.value.identity.oldBindingRejected = false; },
    sample => { sample.value.focus[0].focused = true; },
    sample => { sample.value.focus[9].stage = "invented"; },
    sample => { sample.value.focus.push(sample.value.focus[0]); },
    sample => { sample.value.mainEvents.cleaned = 7; },
    sample => { sample.value.mainCalls.finalLaunch = 1; },
  ];
  for (const mutate of mutations) {
    const sample = fixture(); mutate(sample);
    assert.equal(validate(sample).valid, false, mutate.toString());
  }
});

test("registration validator never throws for malformed evidence", () => {
  for (const value of [null, [], {}, { status: "passed" }]) {
    assert.doesNotThrow(() => validateLaunchReturnSettingsRegistration(value, null));
    assert.equal(validateLaunchReturnSettingsRegistration(value, null).valid, false);
  }
});
