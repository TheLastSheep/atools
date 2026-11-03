import assert from "node:assert/strict";

/** Initialization registers only the document lease, with no permission or business request. */
export function assertInitialHostedIpcRegistration(messages, webContentsId = 1) {
  assert.equal(messages.length, 1, "bridge initialization must post exactly one document control message");
  const message = JSON.parse(JSON.stringify(messages[0]));
  assert.deepEqual(Object.keys(message).sort(), ["__atools_hosted_ipc_document__", "documentNonce", "phase", "webContentsId"].sort(),
    "document registration must not carry business arguments or request authority");
  assert.equal(message.__atools_hosted_ipc_document__, true);
  assert.equal(message.phase, "open");
  assert.equal(message.webContentsId, webContentsId);
  assert.match(message.documentNonce, /^[0-9a-f]{32}$/, "each runtime must register a bounded document nonce");
  return message;
}
