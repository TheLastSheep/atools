import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNodeModuleRequire, nodeModuleBridgeScript } from "../../src/lib/nodeModuleBridge";
import type { NodeModuleRequire } from "../../src/lib/nodeModuleProtocol";

const config = { endpoint: `http://127.0.0.1:43121/node/${"a".repeat(64)}` };
const sessions: NodeModuleRequire[] = [];
afterEach(() => { sessions.splice(0).forEach(session => session.close()); vi.unstubAllGlobals(); });
function setup(response: unknown = { handled: true }) {
  const request = vi.fn((_method: string, _params: Record<string, unknown>) => response);
  const session = makeNodeModuleRequire(config, { requestSync: request, requestAsync: async () => undefined });
  sessions.push(session);
  return { write: session.writeTextPath!, session, request };
}

describe("authorized native text write bridge", () => {
  it("uses a single native request, preserving UTF-8 text and the BOM", () => {
    const { write, request } = setup();
    expect(write("/tmp/文档.md", "\uFEFF# 保存 🙂\n")).toEqual({ handled: true });
    expect(request.mock.calls).toEqual([["writeTextPath", { path: "/tmp/文档.md", text: "\uFEFF# 保存 🙂\n" }]]);
  });
  it("keeps the explicit unsupported result", () => {
    expect(setup({ handled: false }).write("/tmp/unsupported", "content")).toEqual({ handled: false });
  });
  it.each([null, {}, [], { handled: 1 }, { handled: true, value: "text" }, { handled: false, extra: 1 },
    Object.create({ handled: true }), { get handled() { throw new Error("getter must not run"); } },
  ])("rejects malformed success/decline responses %#", response => {
    expect(() => setup(response).write("/tmp/out.md", "ok"))
      .toThrow(expect.objectContaining({ code: "ERR_ATOOLS_NATIVE_FS_RESPONSE" }));
  });
  it.each(["ENOENT", "EACCES", "ENOSPC", "EROFS", "EEXIST", "EFBIG", "EISDIR", "ELOOP", "EIO", "ETIMEDOUT"])(
    "propagates %s without retrying a possible write", code => {
      const { write, request } = setup();
      request.mockImplementation(() => { throw new Error(`ERR_ATOOLS_NATIVE_FS:${code}`); });
      expect(() => write("/tmp/out.md", "ok")).toThrow(expect.objectContaining({ code, path: "/tmp/out.md", syscall: "write" }));
      expect(request).toHaveBeenCalledTimes(1);
    });
  it("leaves transport and authorization failures unchanged", () => {
    const { write, request } = setup();
    const denied = new Error("Plugin document closed");
    request.mockImplementation(() => { throw denied; });
    expect(() => write("/tmp/out.md", "ok")).toThrow(denied);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["relative", "ok"], ["/nul\0", "ok"], ["/" + "中".repeat(2731), "ok"],
    ["/tmp/out", "a".repeat(512 * 1024 + 1)], ["/tmp/out", "中".repeat(174763)],
    ["/tmp/out", "\ud800"], ["/tmp/\udc00", "ok"],
  ])("rejects invalid or oversized inputs before a request %#", (path, text) => {
    const { write, request } = setup();
    expect(() => write(path, text)).toThrow(expect.objectContaining({ code: "ERR_ATOOLS_NATIVE_FS_REQUEST" }));
    expect(request).not.toHaveBeenCalled();
  });
  it("supports empty text and the exact UTF-8 body limit", () => {
    const { write, request } = setup();
    expect(write("/tmp/out", "")).toEqual({ handled: true });
    expect(write("/tmp/out", "a".repeat(512 * 1024))).toEqual({ handled: true });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("revokes an already captured method when its session closes", () => {
    const { write, session, request } = setup(); session.close();
    expect(() => write("/tmp/out", "ok")).toThrow(expect.objectContaining({ code: "ERR_ATOOLS_NODE_SESSION_CLOSED" }));
    expect(request).not.toHaveBeenCalled();
  });
  it("runs inside the production serialized iframe factory", () => {
    const requests: unknown[] = [];
    vi.stubGlobal("XMLHttpRequest", class {
      status = 200; responseText = JSON.stringify({ ok: true, result: { handled: true } });
      open() {} setRequestHeader() {}
      send(body: string) { requests.push(JSON.parse(body)); }
    });
    const session: NodeModuleRequire = new Function(`return ${nodeModuleBridgeScript(config)}`)(); sessions.push(session);
    expect(session.writeTextPath!("/tmp/out", "serialized内容")).toEqual({ handled: true });
    expect(requests).toEqual([{ method: "writeTextPath", params: { path: "/tmp/out", text: "serialized内容" } }]);
  });
});
