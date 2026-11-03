import { describe, expect, it } from "vitest";
import { exactPluginFileDropBuffer, parsePluginFileDropPacket } from "../../src/lib/pluginFileDropPacket";
import { mapPluginFileDropPoint } from "../../src/lib/pluginFileDropGeometry";

const REQUEST = "22222222-2222-4222-8222-222222222222";
const LEASE = "33333333-3333-4333-8333-333333333333";
function packet(changes: Partial<{ requestId: string; leaseId: string; expiresAt: number; files: unknown[] }> = {}) {
  const raw = new TextEncoder().encode("ok");
  const header = new TextEncoder().encode(JSON.stringify({ requestId: REQUEST, leaseId: LEASE,
    expiresAt: Date.now() + 30_000, files: [{ name: "a.txt", path: "/private/a.txt", type: "text/plain", lastModified: 1, size: 2, offset: 0 }], ...changes }));
  const value = new ArrayBuffer(9 + header.byteLength + raw.byteLength), bytes = new Uint8Array(value), view = new DataView(value);
  bytes.set([65, 84, 70, 68, 1]); view.setUint32(5, header.byteLength, true); bytes.set(header, 9); bytes.set(raw, 9 + header.byteLength);
  return value;
}

describe("ATFD v1 packet and frame geometry", () => {
  it("accepts the exact bounded payload and rejects mismatched or expanded metadata", () => {
    const value = packet();
    expect(exactPluginFileDropBuffer(value)).toBe(value);
    expect(() => exactPluginFileDropBuffer(new Uint8Array(value))).toThrow("ERR_ATOOLS_FILE_DROP_BINARY_UNAVAILABLE");
    expect(parsePluginFileDropPacket(value, REQUEST).files).toMatchObject([{ name: "a.txt", path: "/private/a.txt", size: 2, offset: 0 }]);
    expect(() => parsePluginFileDropPacket(packet(), "44444444-4444-4444-8444-444444444444")).toThrow("ERR_ATOOLS_FILE_DROP_PACKET");
    expect(() => parsePluginFileDropPacket(packet({ files: [{ name: "a.txt", path: "/private/a.txt", type: "text/plain", lastModified: 1, size: 2, offset: 1 }] }), REQUEST)).toThrow("ERR_ATOOLS_FILE_DROP_PACKET");
    expect(() => parsePluginFileDropPacket(packet({ files: [{ name: "a.txt", path: "/private/a.txt", type: "text/plain", lastModified: 1, size: 2, offset: 0, extra: true }] }), REQUEST)).toThrow("ERR_ATOOLS_FILE_DROP_PACKET");
    expect(() => parsePluginFileDropPacket(packet({ files: Array.from({ length: 17 }, () => ({ name: "a.txt", path: "/private/a.txt", type: "text/plain", lastModified: 1, size: 0, offset: 0 })) }), REQUEST)).toThrow("ERR_ATOOLS_FILE_DROP_PACKET");
  });

  it("matches native basename bounds by UTF-16 units and rejects path/control separators", () => {
    const one = (name: string) => packet({ files: [{ name, path: "/private/name", type: "application/octet-stream",
      lastModified: 0, size: 2, offset: 0 }] });
    expect(parsePluginFileDropPacket(one("a".repeat(255)), REQUEST).files[0].name).toHaveLength(255);
    expect(() => parsePluginFileDropPacket(one("a".repeat(256)), REQUEST)).toThrow("ERR_ATOOLS_FILE_DROP_PACKET");
    expect(parsePluginFileDropPacket(one("😀".repeat(127)), REQUEST).files[0].name).toBe("😀".repeat(127));
    expect(() => parsePluginFileDropPacket(one("😀".repeat(128)), REQUEST)).toThrow("ERR_ATOOLS_FILE_DROP_PACKET");
    for (const name of ["a/b", "a\\b", "a\0b", "a\rb", "a\nb"]) {
      expect(() => parsePluginFileDropPacket(one(name), REQUEST)).toThrow("ERR_ATOOLS_FILE_DROP_PACKET");
    }
  });

  it("maps physical host points through iframe content borders and rejects transformed or stale scale geometry", () => {
    const frame = { clientWidth: 640, clientHeight: 480, clientLeft: 3, clientTop: 2, offsetWidth: 644, offsetHeight: 484,
      parentElement: null, getBoundingClientRect: () => ({ left: 10, top: 10, width: 644, height: 484 }) } as unknown as HTMLIFrameElement;
    const style = (transform = "none") => () => ({ transform, perspective: "none", zoom: "1" } as CSSStyleDeclaration);
    expect(mapPluginFileDropPoint({ xPhysical: 30, yPhysical: 40, scaleFactor: 2 }, frame, 2, style()))
      .toEqual({ x: 2, y: 8, contentWidth: 640, contentHeight: 480 });
    expect(() => mapPluginFileDropPoint({ xPhysical: 30, yPhysical: 40, scaleFactor: 1 }, frame, 2, style())).toThrow("ERR_ATOOLS_FILE_DROP_GEOMETRY");
    expect(() => mapPluginFileDropPoint({ xPhysical: 30, yPhysical: 40, scaleFactor: 2 }, frame, 2, style("matrix(1, 0, 0, 1, 0, 0)"))).toThrow("ERR_ATOOLS_FILE_DROP_GEOMETRY");
  });
});
