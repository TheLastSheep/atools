import type { NodeModuleSessionConfig, NodeModuleTransport } from "./nodeModuleProtocol";
import { createNodeModulePayloadBudget } from "./nodeModulePayloadBudget";

/** This factory is also serialized into an opaque plugin iframe; keep it self-contained. */
export function createNodeModuleTransport(
  config: NodeModuleSessionConfig,
  createPayloadBudget = createNodeModulePayloadBudget,
): NodeModuleTransport {
  const payloadBudget = createPayloadBudget();
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !/^\/node\/[a-f0-9]{64}$/.test(endpoint.pathname)) {
    throw new Error("ERR_ATOOLS_NODE_ENDPOINT: expected a dedicated loopback session endpoint");
  }

  function unwrap(body: unknown): unknown {
    const response = body as { ok?: boolean; result?: unknown; error?: { message?: string; code?: string } };
    if (response?.ok === true) return response.result;
    const error = new Error(response?.error?.message || "Invalid Node module bridge response") as Error & { code?: string };
    error.name = "NodeModuleBridgeError";
    error.code = response?.error?.code || "ERR_ATOOLS_NODE_RESPONSE";
    throw error;
  }

  function serializeRequest(method: string, params: Record<string, unknown>): string {
    payloadBudget.assertJsonRequest(method, params);
    const body = JSON.stringify({ method, params });
    if (new TextEncoder().encode(body).byteLength > payloadBudget.maxRequestBytes) {
      const error = new Error("Node module payload exceeds the 1 MiB request budget") as Error & { code: string };
      error.name = "NodeModuleBridgeError";
      error.code = "ERR_ATOOLS_NODE_PAYLOAD";
      throw error;
    }
    return body;
  }

  return {
    requestSync(method, params) {
      const body = serializeRequest(method, params);
      const request = new XMLHttpRequest();
      // Sync XHR cannot set timeout on Window. The native endpoint owns the
      // bounded worker deadline; never replace this with a Promise-returning call.
      request.open("POST", endpoint.href, false);
      request.setRequestHeader("Content-Type", "application/json");
      request.send(body);
      if (request.status !== 200) throw new Error(`ERR_ATOOLS_NODE_HTTP: ${request.status}`);
      return unwrap(JSON.parse(request.responseText));
    },
    async requestAsync(method, params) {
      const response = await fetch(endpoint.href, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeRequest(method, params),
        keepalive: method === "release",
      });
      if (!response.ok) throw new Error(`ERR_ATOOLS_NODE_HTTP: ${response.status}`);
      return unwrap(await response.json());
    },
  };
}
