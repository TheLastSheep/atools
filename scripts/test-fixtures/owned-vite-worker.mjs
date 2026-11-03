import { createServer } from "node:http";

const mode = process.argv[2] || "normal";
let server;
let started = false;

function send(message, exitCode) {
  if (!process.connected || !process.send) {
    if (exitCode != null) process.exit(exitCode);
    return;
  }
  process.send(message, () => { if (exitCode != null) process.exit(exitCode); });
}

async function close() {
  if (mode === "hang-close") return;
  if (mode === "close-error") return send({ type: "close-error", code: "VITE_CLOSE_FAILED" }, 1);
  if (!server?.listening) return process.exit(0);
  server.close(() => process.exit(0));
}

process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
process.once("disconnect", () => { void close(); });
process.on("message", message => {
  if (started || message?.type !== "start") return;
  started = true;
  if (mode === "hang-start") return;
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("owned fixture");
  });
  server.once("error", error => send({ type: "error", message: error.message }, 1));
  server.listen(message.port, message.host, () => {
    if (mode === "hang-ready") return;
    const address = server.address();
    send({ type: "ready", address: { address: address.address, family: address.family, port: address.port } });
  });
});
