// @vitest-environment node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { appendPluginNativeWindowDocumentId, preparePluginNativeWindowDocument } from "../../src/lib/pluginNativeBrowserWindowDocument";
import { createPluginBroadcastChannelProductionFixture, snipasteFixtureAction } from "./pluginBroadcastChannelProductionFixture";

const configuredPluginsRoot = process.env.ATOOLS_HARRIS_PLUGIN_SOURCE || "/Users/harris/Desktop/ZTools-plugins/plugins";
const PINNED_PASTER_SHA256 = "2973604cc65b7558ac30d33ecf145abca478b9eedde4207c75d167708ce0a1e5";
const SESSION = "7285fa3a-d658-4dca-8d69-6f5b1f23d784";
const DOCUMENT_TOKEN = "de".repeat(32);
const RESOURCE_ORIGIN = "https://atools-plugin.localhost";
const PARENT_HTML = "<!doctype html><html><head><title>main receiver</title></head><body><main>receiver</main></body></html>";

const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

it("routes the unmodified Harris Snipaste 2.0.1 paster messages through native preparation, compiled bridge, and the authenticated host", async () => {
  expect(configuredPluginsRoot,
    "ATOOLS_HARRIS_PLUGIN_SOURCE must point to /Users/harris/Desktop/ZTools-plugins/plugins; this source contract must not silently skip")
    .toBeTruthy();
  const pluginRoot = resolve(configuredPluginsRoot!, "snipaste");
  const manifest = JSON.parse(await readFile(join(pluginRoot, "plugin.json"), "utf8"));
  expect(manifest).toMatchObject({ author: "harris", version: "2.0.1", main: "dist/index.html" });

  const pasterPath = join(pluginRoot, "dist/paster.html");
  const originalPaster = await readFile(pasterPath);
  expect(sha256(originalPaster)).toBe(PINNED_PASTER_SHA256);
  expect(sha256(await readFile(join(pluginRoot, "paster.html")))).toBe(PINNED_PASTER_SHA256);

  const document = await preparePluginNativeWindowDocument({
    pluginRoot,
    mainUrl: manifest.main,
    requestedUrl: "paster.html?id=1&windowRole=child",
    resourceSessionId: SESSION,
    resourceOrigin: RESOURCE_ORIGIN,
    readTextFile: async path => readFile(path, "utf8"),
  });
  expect(document.relativePath).toBe("dist/paster.html");
  expect(document.resourceUrl).toBe(`${RESOURCE_ORIGIN}/${SESSION}/dist/paster.html?id=1&windowRole=child`);
  expect(document.html).toContain("--atools-native-app-region: drag");
  expect(sha256(await readFile(pasterPath))).toBe(PINNED_PASTER_SHA256);

  const fixture = createPluginBroadcastChannelProductionFixture();
  let receiver: BroadcastChannel | undefined;
  try {
  const main = fixture.createDocument({ role: { kind: "main" }, html: PARENT_HTML,
    url: "https://snipaste-fixture.invalid/index.html" });
  const received: Array<{ data: Record<string, unknown>; origin: string }> = [];
  receiver = new (main.window.BroadcastChannel as unknown as new (name: string) => BroadcastChannel)("snipaste-pro-bus");
  receiver.onmessage = event => received.push({ data: event.data as Record<string, unknown>, origin: event.origin });
  await fixture.flush();

  const payload = { id: 1, width: 160, height: 120, scale: 1, opacity: 1, rotationQuarterTurns: 0,
    flipHorizontal: false, flipVertical: false, grayscale: false, invertColors: false, text: "contract payload" };
  const queryIds: Array<string | null> = [];
  const resizeCalls: Array<[number, number]> = [];
  const childUrl = appendPluginNativeWindowDocumentId(document.resourceUrl, DOCUMENT_TOKEN);
  const child = fixture.createDocument({ role: { kind: "child", windowId: "native-paster-1" },
    html: document.html, url: childUrl, hostKind: "native",
    services: {
      readLatestPasterWindowPayload(id: string | null) {
        queryIds.push(id);
        return { ok: true, payload };
      },
      resizeCurrentWindowTo(width: number, height: number) { resizeCalls.push([width, height]); },
    },
  });
  expect(child.window.location.search).toBe(`?id=1&windowRole=child&__atools_window_document=${DOCUMENT_TOKEN}`);
  expect(queryIds).toEqual(["1"]);
  await fixture.flush();

  const initial = received.filter(item => item.data.type === "PASTER_TRANSFORM_UPDATED");
  expect(initial).toHaveLength(1);
  expect(initial[0]).toMatchObject({ data: { type: "PASTER_TRANSFORM_UPDATED", id: 1, scale: 1 }, origin: "null" });

  received.length = 0;
  child.window.dispatchEvent(new child.window.WheelEvent("wheel", { deltaY: -100, cancelable: true }));
  await fixture.flush();
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ data: { type: "PASTER_TRANSFORM_UPDATED", id: 1, scale: 1.1 }, origin: "null" });
  expect(resizeCalls).toEqual([[176, 132]]);

  received.length = 0;
  const surface = child.window.document.querySelector("#drag-surface");
  surface?.dispatchEvent(new child.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
  expect(child.window.document.querySelector("#ctx-menu")?.getAttribute("style")).toContain("display: flex");
  child.window.document.querySelector<HTMLElement>('#ctx-menu [data-act="solo"]')?.click();
  await fixture.flush();
  expect(received.map(item => item.data.type)).toEqual(["PASTER_TOGGLE_SOLO"]);
  expect(received.map(item => item.data.id)).toEqual([1]);
  expect(received.every(item => item.origin === "null")).toBe(true);

  received.length = 0;
  child.window.document.querySelector<HTMLButtonElement>("#btn-close")?.click();
  await fixture.flush();
  expect(received).toEqual([{ data: { type: "PASTER_CLOSED", id: 1 }, origin: "null" }]);

  const childIngress = fixture.observedBroadcastIngress.filter(item => item.source === child.source);
  expect(childIngress.map(item => (item.data.data as Record<string, unknown> | undefined)?.type)
    .filter(type => typeof type === "string"))
    .toEqual(["PASTER_TRANSFORM_UPDATED", "PASTER_TRANSFORM_UPDATED", "PASTER_TOGGLE_SOLO", "PASTER_CLOSED"]);
  expect(childIngress.every(item => item.origin === "null"
    && !Object.prototype.hasOwnProperty.call(item.data, "__atoolsDocument"))).toBe(true);
  } finally {
    receiver?.close();
    fixture.close();
  }
});
