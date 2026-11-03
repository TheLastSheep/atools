import assert from "node:assert/strict";
import { createServer } from "vite";
import { assertOwnedBoundAddress } from "./owned-vite-server.mjs";

let server;
let stopping = false;
let started = false;

function send(message) {
  if (!process.connected || !process.send) return Promise.resolve();
  return new Promise((resolveSend, rejectSend) => {
    process.send(message, error => error ? rejectSend(error) : resolveSend());
  });
}

async function closeWorker(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  try {
    await server?.close();
    process.exit(exitCode);
  } catch (error) {
    try { await send({ type: "close-error", code: "VITE_CLOSE_FAILED" }); }
    catch { /* The parent still owns bounded process termination. */ }
    process.stderr.write(`Owned Vite worker close failed: ${error?.message || error}\n`);
    process.exit(1);
  }
}

process.once("SIGTERM", () => { void closeWorker(0); });
process.once("SIGINT", () => { void closeWorker(0); });
process.once("disconnect", () => { void closeWorker(0); });

process.on("message", async message => {
  if (started || stopping || message?.type !== "start") return;
  started = true;
  try {
    assert.equal(typeof message.root, "string");
    assert.equal(typeof message.host, "string");
    assert.ok(Number.isInteger(message.port));
    assert.equal(typeof message.cachePath, "string");
    server = await createServer({
      root: message.root,
      cacheDir: message.cachePath,
      clearScreen: false,
      logLevel: "warn",
      server: { host: message.host, port: message.port, strictPort: true },
    });
    if (stopping) return;
    await server.listen();
    if (stopping) return;
    const address = server.httpServer?.address?.();
    assert.ok(server.httpServer?.listening, "Vite worker did not retain a bound TCP listener");
    assertOwnedBoundAddress(address, message.host, message.port);
    await send({ type: "ready", address: {
      address: address.address, family: address.family, port: address.port,
    } });
  } catch (error) {
    try { await server?.close(); } catch (closeError) {
      process.stderr.write(`Owned Vite worker cleanup failed: ${closeError?.message || closeError}\n`);
    }
    try { await send({ type: "error", message: String(error?.message || error).slice(0, 4000) }); }
    catch { /* Parent timeout/termination already owns failure reporting. */ }
    process.exit(1);
  }
});
