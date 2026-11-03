import { relative, sep } from "node:path";

export function createZtoolsRendererBrowserNetworkGuard({
  pageProvider,
  origin,
  distRoot,
  filesUnder,
  network,
  pendingFetch,
  cleanup,
  errorText,
}) {
  function summarizeUrl(raw) {
    try {
      const url = new URL(raw);
      return { origin: url.origin, path: url.pathname, protocol: url.protocol };
    } catch {
      return { origin: "<invalid>", path: "<invalid>", protocol: "<invalid>" };
    }
  }

  async function allowedDistPaths() {
    const files = await filesUnder(distRoot);
    return new Set(files.map(file => `/${relative(distRoot, file).split(sep).join("/")}`));
  }

  async function handlePausedRequest(event, allowedPaths) {
    const request = event.request;
    const summary = summarizeUrl(request.url);
    const isLocal = summary.origin === origin && summary.protocol === "http:";
    const localPathAllowed = summary.path === "/" || summary.path === "/favicon.ico"
      || allowedPaths.has(summary.path);
    const isAllowed = isLocal && localPathAllowed && request.method === "GET";
    network.requests.push({ ...summary, method: request.method, allowed: isAllowed });
    if (isAllowed) {
      await pageProvider().send("Fetch.continueRequest", { requestId: event.requestId }, { timeoutMs: 7000 });
      return;
    }
    network.blocked.push({
      ...summary,
      method: request.method,
      reason: isLocal ? "unlisted-local-resource" : "outside-owned-origin",
    });
    await pageProvider().send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }, { timeoutMs: 7000 });
  }

  function installFetchInterception(allowedPaths) {
    pageProvider().on("Fetch.requestPaused", event => {
      let operation;
      operation = handlePausedRequest(event, allowedPaths)
        .catch(error => cleanup.errors.push(`Fetch request handling: ${errorText(error)}`))
        .finally(() => pendingFetch.delete(operation));
      pendingFetch.add(operation);
    });
  }

  return Object.freeze({ summarizeUrl, allowedDistPaths, installFetchInterception });
}
