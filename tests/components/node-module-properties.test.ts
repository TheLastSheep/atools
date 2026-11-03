import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNodeModuleRequire } from "../../src/lib/nodeModuleBridge";
import type { NodeModuleTransport } from "../../src/lib/nodeModuleProtocol";

const config = { endpoint: `http://127.0.0.1:43121/node/${"a".repeat(64)}` };
const sessions: ReturnType<typeof makeNodeModuleRequire>[] = [];
afterEach(() => { sessions.splice(0).forEach(session => session.close()); vi.restoreAllMocks(); });

function setup() {
  let stored = 1;
  const transport: NodeModuleTransport = {
    requestSync: vi.fn((method, params: any) => {
      if (method === "require") return { kind: "handle", handleId: 1, callable: false, keys: ["value"] };
      if (method === "release") return {};
      if (method === "get") return { kind: "value", value: stored };
      if (method === "set") {
        if (params.property === "readonly") return false;
        if (params.property === "throws") throw Error("real setter failed");
        stored = params.value.value;
        return true;
      }
      throw Error("Unexpected method " + method);
    }),
    requestAsync: vi.fn(async () => ({})),
  };
  const require = makeNodeModuleRequire(config, transport);
  sessions.push(require);
  return { remote: require("fixture"), transport, mutate: (value: number) => { stored = value; } };
}

describe("Genuine remote property assignments", () => {
  it("writes through to Node and keeps subsequent reads live", () => {
    const { remote, transport, mutate } = setup();
    expect(Reflect.set(remote, "value", 17)).toBe(true);
    expect(transport.requestSync).toHaveBeenCalledWith("set", { handleId: 1, property: "value", value: { kind: "value", value: 17 } });
    mutate(99);
    expect(remote.value).toBe(99);
    expect(Object.getOwnPropertyDescriptor(remote, "value")?.value).toBeUndefined();
  });
  it("preserves false and strict assignment errors instead of claiming a successful write", () => {
    const { remote } = setup();
    expect(Reflect.set(remote, "readonly", 1)).toBe(false);
    expect(() => { remote.readonly = 1; }).toThrow(TypeError);
    expect(() => { remote.throws = 1; }).toThrow("real setter failed");
  });
  it("blocks prototype paths, symbols and function/callback retention without starting polling", () => {
    const { remote, transport } = setup();
    for (const property of ["constructor", "__proto__", "prototype", Symbol("hidden")]) {
      expect(() => Reflect.set(remote, property, 1)).toThrow("Blocked remote property");
    }
    expect(() => { remote.fn = () => {}; }).toThrow("Function property assignments");
    expect(() => { remote.options = { nested: [() => {}] }; }).toThrow("Callback property assignments");
    expect(() => Object.defineProperty(remote, "local", { value: 1 })).toThrow("descriptor changes are unsupported");
    expect(() => Reflect.deleteProperty(remote, "value")).toThrow("deletion is unsupported");
    expect(vi.mocked(transport.requestSync).mock.calls.some(([method]) => method === "set")).toBe(false);
  });
});
