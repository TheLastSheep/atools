import assert from "node:assert/strict";

export const LOCAL_FILE_PATH = "/fixture/local/ATools-local-file.txt";
export const LOCAL_FOLDER_PATH = "/fixture/local/ATools-local-folder";
export const LOCAL_MISSING_PATH = "/fixture/local/ATools-local-missing.txt";
export const LOCAL_COLLISION_A = "/fixture/local/a/ATools-duplicate.txt";
export const LOCAL_COLLISION_B = "/fixture/local/b/ATools-duplicate.txt";
const OPERATIONS = new Set(["readLocalShortcuts", "addLocalShortcut", "addLocalShortcutByPath",
  "deleteLocalShortcut", "updateLocalShortcutAlias", "openLocalShortcut", "deleteMissingLocalShortcuts"]);

/** In-memory stand-in for native configuration/metadata, never real filesystem or SQLite evidence. */
export function createLocalLaunchBrowserNativeFixture() {
  let items = [], revision = 0, fileChoices = 0, cancelled = false;
  const calls = [], missing = new Set();
  const clone = value => JSON.parse(JSON.stringify(value));
  return {
    handles: operation => OPERATIONS.has(operation),
    markMissing(path) { missing.add(path); },
    async installCollisionPair(publish) {
      for (const [index, path] of [LOCAL_COLLISION_A, LOCAL_COLLISION_B].entries()) {
        items.push({ id: `local-collision-${index}`, name: "ATools-duplicate.txt", path, type: "file", addedAt: 1793299201000 + index });
      }
      await publish(clone(items), ++revision);
    },
    async renameCollision(publish) {
      items.find(row => row.path === LOCAL_COLLISION_B).alias = "ATools renamed duplicate";
      await publish(clone(items), ++revision);
    },
    snapshot: () => ({ items: clone(items), revision, calls: clone(calls), backend: "synthetic-in-memory" }),
    async handle({ operation, payload }, { publish }) {
      assert.ok(OPERATIONS.has(operation));
      const before = JSON.stringify(items);
      calls.push({ operation, payload: clone(payload) });
      if (operation === "readLocalShortcuts") return clone(items);
      let reply = { success: true };
      if (operation === "addLocalShortcut" && payload.type === "file" && !cancelled) {
        cancelled = true;
        return { success: false, error: "用户取消选择" };
      }
      if (operation === "addLocalShortcut" || operation === "addLocalShortcutByPath") {
        const path = operation === "addLocalShortcutByPath" ? payload.path
          : payload.type === "folder" ? LOCAL_FOLDER_PATH : fileChoices++ === 0 ? LOCAL_FILE_PATH : LOCAL_MISSING_PATH;
        assert.ok([LOCAL_FILE_PATH, LOCAL_FOLDER_PATH, LOCAL_MISSING_PATH].includes(path));
        if (items.some(row => row.path === path)) return { success: false, error: "该项目已存在" };
        const name = path.slice(path.lastIndexOf("/") + 1);
        items.push({ id: `local-${revision + 1}`, name, path, type: path === LOCAL_FOLDER_PATH ? "folder" : "file",
          addedAt: 1793299200000 + revision, pinyin: name.toLowerCase(), pinyinAbbr: "atl" });
      } else if (operation === "updateLocalShortcutAlias") {
        const row = items.find(row => row.id === payload.id);
        assert.ok(row);
        if (payload.alias) row.alias = payload.alias;
        else delete row.alias;
        row.pinyin = (row.alias || row.name).toLowerCase();
      } else if (operation === "deleteLocalShortcut") {
        items = items.filter(row => row.id !== payload.id);
      } else if (operation === "deleteMissingLocalShortcuts") {
        items = items.filter(row => !missing.has(row.path));
      } else if (operation === "openLocalShortcut") {
        assert.ok(items.some(row => row.path === payload.path) && !missing.has(payload.path));
      }
      if (JSON.stringify(items) !== before) await publish(clone(items), ++revision);
      return reply;
    },
  };
}

function installMainLocalLaunchState() {
  window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__ = { items: [], revision: 0, reveals: [], launches: [] };
}

export function decorateMainLocalLaunchBootstrap(source) {
  function replace(before, after) {
    assert.equal(source.split(before).length, 2, `Expected one local-launch fixture seam: ${before.slice(0, 60)}`);
    source = source.replace(before, after);
  }
  replace("  const appStateFixture = createAppStateFixture({", `  const appStateFixture = createAppStateFixture({
    shortcuts: () => window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__.items,`);
  replace("        state.settingsBatchSummary = {", `        settings["ztools-renderer:local-shortcuts"] = JSON.stringify(window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__.items);
        state.settingsBatchSummary = {`);
  replace("entries.length <= fixtureNames.size", "entries.length <= fixtureNames.size + window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__.items.length");
  replace("entry.path === options.appPath && fixtureNames.has(entry.name)", `(entry.path === options.appPath && fixtureNames.has(entry.name)
            || window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__.items.some(row => row.path === entry.path && (row.alias || row.name) === entry.name))`);
  replace('      case "launch_renderer_app": {', `      case "reveal_renderer_target": {
        const target = args?.target, local = window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__;
        const allowed = target?.subType === "local-shortcut"
          ? local.items.some(row => row.path === target.path && (row.alias || row.name) === target.name)
          : isAllowedAppIdentity(target);
        if (!allowed) throw new Error("Fixture rejected unregistered reveal target");
        local.reveals.push(JSON.parse(JSON.stringify(target)));
        record(command, args, "fixture-reveal-intent-only");
        return { ok: true };
      }
      case "launch_renderer_app": {
        if (args?.target?.subType === "local-shortcut") {
          const local = window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__;
          if (!local.items.some(row => row.path === args.target.path && (row.alias || row.name) === args.target.name)) {
            throw new Error("Fixture rejected unregistered shortcut launch");
          }
          local.launches.push(JSON.parse(JSON.stringify(args.target)));
          state.appLaunchIntents.push({ target: args.target, taskRunPersisted: false, processOpened: false });
          record(command, args, "fixture-shortcut-launch-intent-only");
          const receipt = appStateFixture.launch(args.target);
          deliver("atools://renderer-app-launched", null);
          return receipt;
        }`);
  replace('  Object.defineProperty(window, "__ATOOLS_ZTOOLS_RENDERER_FIXTURE__", {', `  window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__.accept = (items, revision) => {
    const local = window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__;
    local.items = JSON.parse(JSON.stringify(items)); local.revision = revision;
    return deliver("atools://renderer-local-shortcuts", { version: 1, revision });
  };
  Object.defineProperty(window, "__ATOOLS_ZTOOLS_RENDERER_FIXTURE__", {`);
  return `(${installMainLocalLaunchState.toString()})();\n${source}`;
}
