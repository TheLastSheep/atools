/** Fixture enforcement only: reject real outbound networking, never return fake data. */
export function offlineNodePolicy() {
  const net = require("node:net");
  function allowed(host) {
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  }
  function denied() { return Object.assign(new Error("MATRIX_SCOPE_BLOCKED: external networking is disabled in this offline fixture"), { code: "ERR_MATRIX_OFFLINE_NETWORK" }); }
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...input) {
    const args = Array.isArray(input[0]) ? input[0] : input;
    const options = typeof args[0] === "object" ? args[0] : { port: args[0], host: typeof args[1] === "string" ? args[1] : "localhost" };
    if (options.path || !allowed(options.host || "localhost")) throw denied();
    return Reflect.apply(connect, this, input);
  };
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    const options = typeof args[0] === "object" ? args[0] : { host: typeof args[1] === "string" ? args[1] : "" };
    if (!allowed(options.host)) throw denied();
    return Reflect.apply(listen, this, args);
  };
  const fetch = globalThis.fetch;
  if (fetch) globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!allowed(url.hostname)) return Promise.reject(denied());
    return fetch(input, init);
  };
}
export const offlineNodePolicySource = () => `(${offlineNodePolicy.toString()})();\n`;
