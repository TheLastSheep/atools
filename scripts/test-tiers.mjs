export const AGGREGATE_TEST_SCRIPTS = new Set([
  "test:fast",
  "test:rust",
  "test:browser",
  "test:desktop",
  "test:release",
  "test:all",
]);

export const BROWSER_TEST_SCRIPTS = new Set([
  "test:plugin-host-smoke-browser",
  "test:plugin-iframe-context-menu",
  "test:ztools-ui-host-external-plan-browser",
  "test:ztools-ui-host-first-fixture-browser",
  "test:ztools-ui-host-fixture-matrix-browser",
  "test:ztools-ui-host-plugin-panel-browser",
  "test:ztools-ui-host-plugin-panel-matrix-browser",
  "test:ztools-ui-host-screenshot-capture-browser",
]);

export function classifyTestScripts(scripts = {}) {
  const focused = Object.keys(scripts)
    .filter((name) => name.startsWith("test:"))
    .filter((name) => !AGGREGATE_TEST_SCRIPTS.has(name))
    .sort();
  return {
    fast: focused.filter((name) => !BROWSER_TEST_SCRIPTS.has(name)),
    browser: focused.filter((name) => BROWSER_TEST_SCRIPTS.has(name)),
  };
}
