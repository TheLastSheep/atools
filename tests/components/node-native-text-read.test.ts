import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNodeModuleRequire, nodeModuleBridgeScript } from "../../src/lib/nodeModuleBridge";
import type { NodeModuleRequire, NodeModuleTransport } from "../../src/lib/nodeModuleProtocol";

const config = { endpoint: `http://127.0.0.1:43121/node/${"a".repeat(64)}` };
const sessions: NodeModuleRequire[] = [];
afterEach(() => {
  sessions.splice(0).forEach(session => session.close());
  vi.unstubAllGlobals();
});

function setup(reply: unknown = { handled: true, value: "UTF-8 内容\uFEFF" }) {
  const requestSync = vi.fn(() => reply);
  const transport: NodeModuleTransport = { requestSync, requestAsync: vi.fn(async () => undefined) };
  const session = makeNodeModuleRequire(config, transport);
  sessions.push(session);
  return { read: session.readTextPath!, session, requestSync };
}

describe("authorized native text read bridge", () => {
  it("uses one native request without require/get/call RPCs", () => {
    const { read, requestSync } = setup();
    expect(read("/tmp/文档.md")).toEqual({ handled: true, value: "UTF-8 内容\uFEFF" });
    expect(requestSync.mock.calls).toEqual([["readTextPath", { path: "/tmp/文档.md" }]]);
  });

  it("retains the explicit unsupported outcome", () => {
    expect(setup({ handled: false }).read("/tmp/document")).toEqual({ handled: false });
  });

  it.each([null, [], {}, true, { handled: true }, { handled: true, value: 42 },
    { handled: false, value: "ignored" }, { handled: true, value: "ok", extra: 1 },
    Object.assign(Object.create({ handled: false }), { extra: 1 }),
  ])("rejects malformed native replies %#", reply => {
    expect(() => setup(reply).read("/tmp/document")).toThrow(expect.objectContaining({ code: "ERR_ATOOLS_NATIVE_FS_RESPONSE" }));
  });

  it.each(["relative.md", "", "/nul\0.md", "/" + "a".repeat(8192), "/" + "中".repeat(2731)])(
    "rejects ineligible paths before any request %#", path => {
      const { read, requestSync } = setup();
      expect(() => read(path)).toThrow(expect.objectContaining({ code: "ERR_ATOOLS_NATIVE_FS_REQUEST" }));
      expect(requestSync).not.toHaveBeenCalled();
    });

  it.each(["ENOENT", "EACCES", "EIO", "ENOTDIR", "EINVAL", "ENAMETOOLONG", "ENOTSUP", "ETIMEDOUT"])(
    "preserves native %s as an error with no retry", code => {
      const { read, requestSync } = setup();
      requestSync.mockImplementation(() => { throw new Error(`ERR_ATOOLS_NATIVE_FS:${code}`); });
      expect(() => read("/tmp/missing")).toThrow(expect.objectContaining({ code, syscall: "open", path: "/tmp/missing" }));
      expect(requestSync).toHaveBeenCalledTimes(1);
    });

  it("preserves unrelated transport errors unchanged", () => {
    const { read, requestSync } = setup();
    const error = new Error("Plugin document closed");
    requestSync.mockImplementation(() => { throw error; });
    expect(() => read("/tmp/document")).toThrow(error);
    expect(requestSync).toHaveBeenCalledTimes(1);
  });

  it("revokes captured reads when the session closes", () => {
    const { read, session, requestSync } = setup();
    session.close();
    expect(() => read("/tmp/document")).toThrow(expect.objectContaining({ code: "ERR_ATOOLS_NODE_SESSION_CLOSED" }));
    expect(requestSync).not.toHaveBeenCalled();
  });

  it("survives the production serialized iframe factory", () => {
    const requests: unknown[] = [];
    vi.stubGlobal("XMLHttpRequest", class {
      status = 200;
      responseText = JSON.stringify({ ok: true, result: { handled: true, value: "serialized 内容" } });
      open() {}
      setRequestHeader() {}
      send(body: string) { requests.push(JSON.parse(body)); }
    });
    const session: NodeModuleRequire = new Function(`return ${nodeModuleBridgeScript(config)}`)();
    sessions.push(session);
    expect(session.readTextPath!("/tmp/serialized.md")).toEqual({ handled: true, value: "serialized 内容" });
    expect(requests).toEqual([{ method: "readTextPath", params: { path: "/tmp/serialized.md" } }]);
  });
});
