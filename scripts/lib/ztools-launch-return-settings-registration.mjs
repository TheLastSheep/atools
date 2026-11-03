import { basename, join } from "node:path";

export const SETTINGS_REGISTRATION_ALIAS = "ATools R68 Alias";
export const SETTINGS_REGISTRATION_FOCUS_STAGES = Object.freeze([
  "baseline", "first-open", "dropped", "aliased", "first-closed", "alias-search", "reopened", "cleaned", "final-closed",
  "launch-baseline", "launch-pasted", "launch-denied", "launch-direct-return", "launch-typed", "launch-keyboard-return", "launch-disposed",
]);
const KEYS = ["status", "inputSource", "physicalOsDrop", "deadlineMs", "fixturePaths", "initial", "firstChild", "drop", "alias",
  "firstClose", "aliasSearch", "secondChild", "reopen", "cleanup", "finalClose", "acl", "identity", "focus", "mainEvents", "mainCalls"];
const ROW_REQUIRED = ["id", "name", "path", "type", "addedAt"];
const ROW_OPTIONAL = ["alias", "icon", "keywords", "pinyin", "pinyinAbbr"];
const SIMPLE_UUID_V4 = /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

export function settingsRegistrationFixturePaths(root) {
  return { firstApp: join(root, "launcher-apps/AToolsOwnedProbeFirst.app"),
    secondApp: join(root, "launcher-apps/AToolsOwnedProbeSecond.app"),
    file: join(root, "settings-registration/owned-file.txt"), folder: join(root, "settings-registration/owned-folder") };
}

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
export function settingsRegistrationRowsEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
function check(errors, condition, code) { if (!condition) errors.push(`registration-${code}`); }

function validateRows(rows, roles, paths, errors, code) {
  check(errors, Array.isArray(rows) && rows.length === roles.length, `${code}-row-count`);
  if (!Array.isArray(rows)) return;
  const usedPaths = new Set();
  const ids = new Set();
  for (const row of rows) {
    const role = roles.find(value => paths[value] === row?.path);
    check(errors, record(row) && ROW_REQUIRED.every(key => Object.hasOwn(row, key))
      && Object.keys(row).every(key => [...ROW_REQUIRED, ...ROW_OPTIONAL].includes(key)), `${code}-row-shape`);
    check(errors, role !== undefined && !usedPaths.has(row?.path), `${code}-row-role`);
    check(errors, UUID_V4.test(row?.id) && !ids.has(row?.id), `${code}-row-id`);
    check(errors, role !== undefined && row?.name === basename(paths[role]) && row?.type === (
      role.endsWith("App") ? "app" : role === "file" ? "file" : "folder") && count(row?.addedAt), `${code}-row-values`);
    if (record(row)) for (const key of ROW_OPTIONAL) {
      if (!Object.hasOwn(row, key)) continue;
      check(errors, key === "keywords" ? Array.isArray(row[key]) && row[key].length <= 128
        && row[key].every(word => typeof word === "string" && word.length <= 4096)
        : typeof row[key] === "string" && row[key].length <= 32 * 1024, `${code}-row-${key}`);
    }
    usedPaths.add(row?.path);
    ids.add(row?.id);
  }
}

function validateChild(child, revision, errors, code) {
  check(errors, exact(child, ["label", "sessionId", "origin", "bundleRevision", "url", "phase", "ready", "documentVisibility", "documentHasFocus"]), `${code}-shape`);
  if (!record(child)) return;
  check(errors, SIMPLE_UUID_V4.test(child.sessionId) && child.label === `ztools-settings-${child.sessionId}`
    && child.origin === `atools-settings://${child.sessionId}.localhost`, `${code}-identity`);
  check(errors, HASH.test(revision) && child.bundleRevision === revision, `${code}-bundle-revision`);
  const prefix = `${child.origin}/index.html#/localLaunch`;
  const timestamp = typeof child.url === "string" && child.url.startsWith(`${prefix}?_t=`) ? child.url.slice(prefix.length + 4) : null;
  check(errors, child.url === prefix || timestamp !== null && /^[1-9][0-9]{0,15}$/.test(timestamp)
    && Number.isSafeInteger(Number(timestamp)), `${code}-url`);
  check(errors, child.phase === "open" && child.ready === true, `${code}-phase-ready`);
  check(errors, ["hidden", "visible"].includes(child.documentVisibility) && typeof child.documentHasFocus === "boolean",
    `${code}-document-observation`);
}

function withoutAlias(rows) {
  return rows?.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "alias")));
}

function rowsPreserveIdentity(actual, expected, firstApp) {
  const stable = rows => rows?.map(row => row.path === firstApp
    ? Object.fromEntries(Object.entries(row).filter(([key]) => !["pinyin", "pinyinAbbr"].includes(key))) : row);
  return settingsRegistrationRowsEqual(stable(actual), stable(expected));
}

export function settingsRegistrationFinalRowsValid(rows, root) {
  const errors = [];
  validateRows(rows, ["firstApp", "secondApp"], settingsRegistrationFixturePaths(root), errors, "final");
  return errors.length === 0 && rows.every(row => !Object.hasOwn(row, "alias"));
}

/** Closed registration contract; its owner and SQLite snapshot must come from the runner. */
export function validateLaunchReturnSettingsRegistration(value, owner) {
  const errors = [];
  try {
    check(errors, exact(value, KEYS), "shape");
    if (!record(value)) return { valid: false, errors };
    check(errors, SIMPLE_UUID_V4.test(owner.runId) && owner.root === `/private/tmp/atools-renderer-launch-return-${owner.runId}`,
      "owned-root");
    const paths = settingsRegistrationFixturePaths(owner.root);
    check(errors, exact(value.fixturePaths, Object.keys(paths))
      && Object.entries(paths).every(([key, path]) => value.fixturePaths[key] === path), "fixture-paths");
    check(errors, value.status === "passed" && value.inputSource === "rust-injected-drag-event"
      && value.physicalOsDrop === false && value.deadlineMs === 60_000, "source-policy");
    check(errors, exact(value.initial, ["rows", "revision"]) && Array.isArray(value.initial?.rows)
      && value.initial.rows.length === 0 && value.initial.revision === 0, "initial-empty");
    validateChild(value.firstChild, owner.settingsBundleRevision, errors, "first-child");
    validateChild(value.secondChild, owner.settingsBundleRevision, errors, "second-child");
    check(errors, value.firstChild?.sessionId !== value.secondChild?.sessionId
      && value.firstChild?.label !== value.secondChild?.label && value.firstChild?.origin !== value.secondChild?.origin,
    "fresh-second-child");

    check(errors, exact(value.drop, ["rows", "revision", "uiRows", "feedback", "mainRevision", "binding"]), "drop-shape");
    validateRows(value.drop?.rows, ["firstApp", "secondApp", "file", "folder"], paths, errors, "drop");
    check(errors, value.drop?.revision === 4 && value.drop.uiRows === 4 && value.drop.feedback === true
      && value.drop.mainRevision === 4, "drop-observations");
    const binding = value.drop?.binding;
    check(errors, exact(binding, ["sessionId", "childLabel", "bundleRevision", "bindingNonce", "batchNonce", "added", "failed", "resultNoticeEnqueued"])
      && binding.sessionId === value.firstChild?.sessionId && binding.childLabel === value.firstChild?.label
      && binding.bundleRevision === owner.settingsBundleRevision && SIMPLE_UUID_V4.test(binding.bindingNonce)
      && SIMPLE_UUID_V4.test(binding.batchNonce) && binding.bindingNonce !== binding.batchNonce
      && binding.added === 4 && binding.failed === 0 && binding.resultNoticeEnqueued === true, "drop-binding");
    check(errors, value.drop?.rows?.every(row => !Object.hasOwn(row, "alias")), "drop-no-alias");
    check(errors, exact(value.alias, ["value", "rows", "revision"]) && value.alias.value === SETTINGS_REGISTRATION_ALIAS
      && value.alias.revision === 5, "alias-shape-values");
    validateRows(value.alias?.rows, ["firstApp", "secondApp", "file", "folder"], paths, errors, "alias");
    const expectedAliased = value.drop?.rows?.map(row => row.path === paths.firstApp ? { ...row, alias: SETTINGS_REGISTRATION_ALIAS } : row);
    check(errors, rowsPreserveIdentity(value.alias?.rows, expectedAliased, paths.firstApp), "alias-row-continuity");

    const closedKeys = ["sessionCount", "childCount", "layoutCount", "pendingCalls", "pendingWrites", "bindingActive"];
    for (const key of ["firstClose", "finalClose"]) {
      check(errors, exact(value[key], closedKeys) && closedKeys.slice(0, 5).every(field => value[key][field] === 0)
        && value[key].bindingActive === false, `${key}-terminal`);
    }
    check(errors, exact(value.aliasSearch, ["query", "path", "subType", "matched", "launchCallsBefore", "launchCallsAfter"])
      && value.aliasSearch.query === SETTINGS_REGISTRATION_ALIAS && value.aliasSearch.path === paths.firstApp
      && value.aliasSearch.subType === "local-shortcut" && value.aliasSearch.matched === true
      && value.aliasSearch.launchCallsBefore === 0 && value.aliasSearch.launchCallsAfter === 0, "alias-search");
    check(errors, exact(value.reopen, ["aliasPersisted", "documentChanged", "sessionChanged"])
      && Object.values(value.reopen).every(item => item === true), "reopen");
    check(errors, exact(value.cleanup, ["rows", "revision", "aliasCleared", "fileDeleted", "folderDeleted"])
      && value.cleanup.revision === 8 && value.cleanup.aliasCleared === true
      && value.cleanup.fileDeleted === true && value.cleanup.folderDeleted === true, "cleanup-shape-values");
    validateRows(value.cleanup?.rows, ["firstApp", "secondApp"], paths, errors, "cleanup");
    const expectedFinal = withoutAlias(value.drop?.rows?.filter(row => row.type === "app"));
    check(errors, rowsPreserveIdentity(value.cleanup?.rows, expectedFinal, paths.firstApp)
      && value.cleanup?.rows?.every(row => !Object.hasOwn(row, "alias")), "cleanup-row-continuity");
    const sqlite = owner.registrationSqlite;
    check(errors, sqlite?.valid === true && sqlite.revision === 8
      && settingsRegistrationRowsEqual(sqlite.rows, value.cleanup?.rows), "independent-sqlite");
    const aclKeys = ["dragEnter", "dragOver", "dragDrop", "dragLeave", "cleanup"];
    check(errors, exact(value.acl, aclKeys) && aclKeys.slice(0, 4).every(key => value.acl[key] === "denied")
      && value.acl.cleanup === true, "acl");
    const identityKeys = ["wrongMainRejected", "oldSessionRejected", "oldBindingRejected", "nonceBound", "childRoleBound"];
    check(errors, exact(value.identity, identityKeys) && identityKeys.every(key => value.identity[key] === true), "identity");
    check(errors, exact(value.mainEvents, ["initial", "dropped", "aliased", "cleaned"])
      && count(value.mainEvents.initial) && value.mainEvents.dropped === value.mainEvents.initial + 4
      && value.mainEvents.aliased === value.mainEvents.initial + 5
      && value.mainEvents.cleaned === value.mainEvents.initial + 8, "main-event-continuity");
    const callKeys = ["initialOpen", "firstOpen", "secondOpen", "initialLaunch", "afterAliasSearch", "finalLaunch"];
    check(errors, exact(value.mainCalls, callKeys) && callKeys.every((key, index) => value.mainCalls[key] === [0, 1, 2, 0, 0, 0][index]),
      "main-call-counts");
    check(errors, Array.isArray(value.focus) && value.focus.length === SETTINGS_REGISTRATION_FOCUS_STAGES.length, "focus-count");
    for (let index = 0; index < SETTINGS_REGISTRATION_FOCUS_STAGES.length; index += 1) {
      const focus = value.focus?.[index];
      check(errors, exact(focus, ["stage", "visible", "focused", "applicationActive", "mainKey", "focusGainedEvents"])
        && focus.stage === SETTINGS_REGISTRATION_FOCUS_STAGES[index] && focus.visible === false && focus.focused === false
        && focus.applicationActive === false && focus.mainKey === false && focus.focusGainedEvents === 0, `focus-${index}`);
    }
  } catch { errors.push("registration-input-invalid"); }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}
