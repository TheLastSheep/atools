export function createRendererRecommendationBrowserFixture(active, version) {
  const key = "atools-private-recommendation-fixture";
  const pluginName = "atools-recommendation-fixture";
  const path = `/fixture/plugins/recommendation-v${version}`;
  const names = ["推荐夹具 A", "推荐夹具 B"];
  const clone = value => JSON.parse(JSON.stringify(value));
  let failNext = false;
  const attempts = [];
  if (active && version === 1) window.localStorage.removeItem(key);
  const raw = () => active ? window.localStorage.getItem(key) : null;
  const current = () => JSON.parse(raw() ?? "null");
  return {
    plugins() {
      return active ? [{
        id: pluginName, name: pluginName, version: "1.0.0", path, enabled: true, source_kind: "imported",
        manifest: { title: "推荐验收夹具", features: names.map((name, index) => ({
          code: `recommendation-${index}`, explain: name,
          cmds: [{ type: "over", label: name, minLength: 1 }],
        })) },
      }] : [];
    },
    raw,
    save(args) {
      if (!active || !args || Object.keys(args).sort().join(",") !== "expected,value"
        || !(args.expected === null || typeof args.expected === "string")) throw new Error("Invalid fixed recommendation fixture request");
      const before = raw();
      const entry = { expected: clone(args.expected), value: clone(args.value), failed: false, committed: false };
      attempts.push(entry);
      if (failNext) { failNext = false; entry.failed = true; throw new Error("RECOMMENDATION_PINS_SAVE_FAILED"); }
      if (before !== args.expected) throw new Error("RECOMMENDATION_PINS_CONFLICT");
      const operation = args.value;
      const rows = current() ?? [];
      const fields = operation && Object.keys(operation).sort().join(",");
      if (operation?.kind === "append" && fields === "kind,pin" && rows.length < 2) rows.push(operation.pin);
      else if (["remove", "moveToFront"].includes(operation?.kind) && fields === "index,kind"
        && Number.isInteger(operation.index) && operation.index >= 0 && operation.index < rows.length) {
        const [row] = rows.splice(operation.index, 1);
        if (operation.kind === "moveToFront") rows.unshift(row);
      } else if (!(operation?.kind === "noop" && fields === "kind")) throw new Error("Invalid fixed recommendation fixture mutation");
      const next = operation.kind === "noop" || (operation.kind === "moveToFront" && operation.index === 0)
        ? before : JSON.stringify(rows);
      const changed = next !== before;
      if (next !== null) window.localStorage.setItem(key, next);
      entry.committed = true;
      return { version: 1, changed, raw: next };
    },
    failNextWrite() { if (!active) throw new Error("Recommendation fixture is inactive"); failNext = true; },
    snapshot() { return { active, version, pluginName, path, names, value: current(), attempts: clone(attempts), backend: "private-fixture-localStorage" }; },
  };
}
