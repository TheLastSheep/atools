import vm, { type Context } from "node:vm";

/** Parse the compiler's HTML document and execute its inline scripts in DOM order. */
export function executeCompiledPluginBridgeScripts(
  html: string,
  context: Context,
  expectedInlineScripts: number,
): number {
  const sandbox = context as Context & { window?: Record<string, unknown>; Event?: unknown; CustomEvent?: unknown };
  const browserWindow = sandbox.window;
  const history = browserWindow?.history as History | undefined;
  const location = browserWindow?.location as Location | undefined;
  const parser = (browserWindow?.DOMParser ?? (globalThis as typeof globalThis & { DOMParser?: typeof DOMParser }).DOMParser) as typeof DOMParser | undefined;
  if (typeof parser !== "function" || typeof location?.href !== "string" || !history
    || typeof history.pushState !== "function" || typeof history.replaceState !== "function"
    || browserWindow?.Event !== sandbox.Event || browserWindow?.CustomEvent !== sandbox.CustomEvent) {
    throw new Error("Compiled plugin bridge runner requires same-realm iframe browser globals");
  }
  const parsed = new parser().parseFromString(html, "text/html");
  const scripts = Array.from(parsed.querySelectorAll("script"));
  if (scripts.some(script => script.hasAttribute("src"))) {
    throw new Error("Compiled plugin bridge unexpectedly contains an external script");
  }
  const coreScripts = scripts.filter(script => !script.hasAttribute("data-atools-plugin-ai"));
  if (coreScripts.length !== expectedInlineScripts) {
    throw new Error(`Compiled plugin bridge core script count mismatch: ${coreScripts.length}`);
  }
  for (const [index, script] of scripts.entries()) {
    const source = script.textContent ?? "";
    if (!source.trim()) throw new Error(`Compiled plugin bridge inline script ${index} is empty`);
    vm.runInContext(source, context, { filename: `compiled-plugin-bridge-${index}.js` });
  }
  return coreScripts.length;
}
