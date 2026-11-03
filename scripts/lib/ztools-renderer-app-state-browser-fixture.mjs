/** A bounded in-page stand-in for the native app-state transaction boundary. */
export function createRendererAppStateBrowserFixture({
  apps,
  commandAliases,
  state,
  emit,
  shortcuts = () => [],
  initialState = {},
}) {
  let current = {
    revision: 0,
    history: initialState.history ?? null,
    pins: initialState.pins ?? null,
  };

  function snapshot(changed = []) {
    return {
      version: 1,
      revision: current.revision,
      values: {
        "command-history": current.history,
        "pinned-commands": current.pins,
      },
      changed: [...changed],
    };
  }

  function readRecords(serialized, key) {
    if (serialized === null) return [];
    if (typeof serialized !== "string" || serialized.length > 128 * 1024) {
      throw new Error(`Fixture found an invalid ${key} setting`);
    }
    const parsed = JSON.parse(serialized);
    if (!Array.isArray(parsed) || parsed.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error(`Fixture found an invalid ${key} array`);
    }
    return parsed;
  }

  function directSubtype(value) {
    if (value?.type === "app") return "app";
    if (value?.type !== "direct") return null;
    return value.subType === "app" || value.subType === "local-shortcut" ? value.subType : null;
  }

  function recordIdentity(value, preferPersistedName = false) {
    const subType = directSubtype(value);
    if (!subType || typeof value.path !== "string") return null;
    const name = preferPersistedName && typeof value.persistedName === "string"
      ? value.persistedName
      : typeof value.name === "string" ? value.name : value.path;
    return { path: value.path, name, subType };
  }

  function identityKey(value) {
    return JSON.stringify([value.path, value.name, value.subType]);
  }

  function matchesDirectRecord(record, target, preferPersistedName = false) {
    const stored = recordIdentity(record, preferPersistedName);
    return Boolean(stored && stored.path === target.path
      && (target.name === undefined || stored.name === target.name)
      && (target.subType === undefined || stored.subType === target.subType));
  }

  function identity(value) {
    if (value?.subType === "local-shortcut") {
      const row = shortcuts().find(row => row.path === value.path && (row.alias || row.name) === value.name);
      if (!row || Object.keys(value).sort().join(",") !== "name,path,subType") {
        throw new Error("Fixture rejected an unregistered local shortcut identity");
      }
      return { path: value.path, name: value.name, subType: "local-shortcut" };
    }
    const app = value && typeof value === "object"
      ? apps.find(entry => entry.path === value.path)
      : null;
    const aliasKey = app ? `direct:app:${app.path.replace(/\\/g, "/")}` : "";
    const matchesConfiguredAlias = app && (commandAliases[aliasKey] || [])
      .some(entry => entry.alias === value.name);
    const keys = value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).sort().join(",")
      : "";
    if (!value || typeof value !== "object" || Array.isArray(value)
      || (keys !== "name,path" && keys !== "name,path,subType")
      || (value.subType !== undefined && value.subType !== "app")
      || typeof value.path !== "string" || typeof value.name !== "string"
      || !app || (app.name !== value.name && !matchesConfiguredAlias)) {
      throw new Error("Fixture rejected an identity outside the catalog app and its configured aliases");
    }
    return { path: value.path, name: value.name, subType: "app" };
  }

  function appRecord(app, additions = {}) {
    return {
      type: "direct",
      subType: app.subType || "app",
      cmdType: "text",
      path: app.path,
      name: app.name,
      ...additions,
    };
  }

  function commit(history, pins, changed) {
    const domains = [...new Set(changed)].sort();
    if (!domains.length) return snapshot([]);
    current.revision += 1;
    if (domains.includes("command-history")) current.history = JSON.stringify(history);
    if (domains.includes("pinned-commands")) current.pins = JSON.stringify(pins);
    const receipt = snapshot(domains);
    state.appStateReceipts.push(receipt);
    emit(receipt);
    return receipt;
  }

  function launch(target) {
    const app = identity(target);
    const history = readRecords(current.history, "command-history");
    const matchingIndexes = [];
    let totalUseCount = 0;
    history.forEach((row, index) => {
      if (!matchesDirectRecord(row, app)) return;
      const useCount = row.useCount === undefined ? 0 : row.useCount;
      if (!Number.isSafeInteger(useCount) || useCount < 0) {
        throw new Error("Fixture found an invalid app history useCount");
      }
      totalUseCount += useCount;
      if (!Number.isSafeInteger(totalUseCount)) {
        throw new Error("Fixture found an overflowing app history useCount");
      }
      matchingIndexes.push(index);
    });
    const useCount = totalUseCount + 1;
    if (!Number.isSafeInteger(useCount)) throw new Error("Fixture found an overflowing app history useCount");
    const previous = matchingIndexes.length ? history[matchingIndexes[0]] : appRecord(app);
    const lastUsed = Date.now();
    previous.path = app.path;
    previous.name = app.name;
    previous.type = "direct";
    previous.subType = app.subType;
    previous.lastUsed = lastUsed;
    previous.useCount = useCount;
    for (const index of matchingIndexes.reverse()) history.splice(index, 1);
    history.push(previous);
    history.sort((left, right) => (Number.isSafeInteger(right.lastUsed) ? right.lastUsed : Number.MIN_SAFE_INTEGER)
      - (Number.isSafeInteger(left.lastUsed) ? left.lastUsed : Number.MIN_SAFE_INTEGER));
    return commit(history, readRecords(current.pins, "pinned-commands"), ["command-history"]);
  }

  function removalIdentity(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !["path", "name"].includes(key))
      || typeof value.path !== "string" || !value.path
      || (value.name !== undefined && typeof value.name !== "string")) {
      throw new Error("Fixture rejected an app-state removal identity");
    }
    return value;
  }

  function mutate(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)
      || typeof request.operation !== "string") throw new Error("Fixture rejected the app-state request");
    const history = readRecords(current.history, "command-history");
    const pins = readRecords(current.pins, "pinned-commands");
    let nextHistory = history;
    let nextPins = pins;
    let changed = [];
    switch (request.operation) {
      case "pin": {
        if (Object.keys(request).sort().join(",") !== "app,operation") throw new Error("Fixture rejected pin fields");
        const app = identity(request.app);
        if (!pins.some(row => matchesDirectRecord(row, app, true))) {
          nextPins = [...pins, appRecord(app)];
          changed = ["pinned-commands"];
        }
        break;
      }
      case "unpin":
      case "remove_history": {
        if (Object.keys(request).some(key => !["operation", "path", "name"].includes(key))) {
          throw new Error("Fixture rejected removal fields");
        }
        const target = removalIdentity({ path: request.path, ...(request.name === undefined ? {} : { name: request.name }) });
        const source = request.operation === "unpin" ? pins : history;
        const remaining = source.filter(row => !matchesDirectRecord(
          row,
          target,
          request.operation === "unpin",
        ));
        if (remaining.length !== source.length) {
          if (request.operation === "unpin") { nextPins = remaining; changed = ["pinned-commands"]; }
          else { nextHistory = remaining; changed = ["command-history"]; }
        }
        break;
      }
      case "reorder_pins": {
        if (Object.keys(request).sort().join(",") !== "apps,operation" || !Array.isArray(request.apps)) {
          throw new Error("Fixture rejected reorder fields");
        }
        const identities = request.apps.map(identity);
        const appIndexes = [];
        const storedIndexes = new Map();
        pins.forEach((row, index) => {
          if (!directSubtype(row)) return;
          const stored = recordIdentity(row, true);
          if (!stored) throw new Error("Fixture found an invalid stored direct pin identity");
          const key = identityKey(stored);
          if (storedIndexes.has(key)) throw new Error("Fixture found duplicate stored direct pins");
          storedIndexes.set(key, index);
          appIndexes.push(index);
        });
        const requestedKeys = identities.map(identityKey);
        const requested = new Set(requestedKeys);
        if (requested.size !== requestedKeys.length || requested.size !== storedIndexes.size
          || requestedKeys.some(key => !storedIndexes.has(key))) {
          throw new Error("Fixture rejected an incomplete pin order");
        }
        nextPins = [...pins];
        identities.forEach((app, index) => {
          nextPins[appIndexes[index]] = pins[storedIndexes.get(identityKey(app))];
        });
        changed = ["pinned-commands"];
        break;
      }
      case "clear_pins":
        if (Object.keys(request).length !== 1) throw new Error("Fixture rejected clear-pins fields");
        nextPins = pins.filter(row => !directSubtype(row));
        if (current.pins === null || nextPins.length !== pins.length) changed = ["pinned-commands"];
        break;
      case "clear_history":
        if (Object.keys(request).length !== 1) throw new Error("Fixture rejected clear-history fields");
        nextHistory = history.filter(row => !directSubtype(row));
        if (current.history === null || nextHistory.length !== history.length) changed = ["command-history"];
        break;
      default:
        throw new Error("Fixture rejected an unknown app-state mutation");
    }
    const receipt = commit(nextHistory, nextPins, changed);
    state.appStateMutations.push({ request: structuredClone(request), receipt });
    return receipt;
  }

  return { snapshot, readRecords, launch, mutate };
}
