import { createHostClipboardBridge, hostClipboardBridgeScript } from "../../src/lib/hostClipboardBridge";
import { createPluginElectronAdapter } from "../../src/lib/pluginElectronAdapter";
import packageInfo from "../../package.json";
declare const __ATOOLS_ORIGINAL_CLIPBOARD_PRELOADS__: { id: string; source: string; sha256: string }[];

const config = (window as any).__nativeHostClipboardConfig;
const checks: Record<string, boolean> = {};
const check = (name: string, value: boolean) => { checks[name] = value; if (!value) throw new Error(name); };
try {
  const requests: string[] = [];
  const unauthorized = createHostClipboardBridge({ instanceId: config.instanceId }, (access) => requests.push(access));
  let readBlocked = false, writeBlocked = false;
  try { unauthorized.readText(); } catch (error: any) { readBlocked = error.code === "ERR_ATOOLS_HOST_CLIPBOARD_PERMISSION_REQUIRED"; }
  try { unauthorized.writeText(config.privateText); } catch (error: any) { writeBlocked = error.code === "ERR_ATOOLS_HOST_CLIPBOARD_PERMISSION_REQUIRED"; }
  check("beforeGrantThrowsWithoutPayload", readBlocked && writeBlocked && JSON.stringify(requests) === '["read","write"]');
  let filesBlocked = false;
  try { unauthorized.readFiles(); } catch (error: any) { filesBlocked = error.code === "ERR_ATOOLS_HOST_CLIPBOARD_PERMISSION_REQUIRED"; }
  check("filesBeforeGrantThrowsWithoutReplay", filesBlocked && JSON.stringify(requests) === '["read","write"]');
  const bridge = createHostClipboardBridge(config, () => { throw new Error("Unexpected authorization request"); });
  const expected = config.expectedFiles;
  check("nativeFilesFixtureHasActualFileAndDirectory", Array.isArray(expected) && expected.length === 2
    && expected.some((item: any) => item.isFile && !item.isDirectory) && expected.some((item: any) => item.isDirectory && !item.isFile));
  const canonical = (items: any[]) => items.map(({ name, path, isFile, isDirectory }) => ({ name, path, isFile, isDirectory }));
  const expectedMetadata = JSON.stringify(canonical(expected));
  const files = bridge.readFiles();
  check("nativeCopiedFilesAreSynchronousExactMetadata", Array.isArray(files) && !(files as any).then
    && JSON.stringify(canonical(files)) === expectedMetadata);
  check("copiedFileLegacyAliasMatchesCanonicalDirectory", files.every(item => item.isDiractory === item.isDirectory));
  files[0].path = "mutated-local-copy";
  check("nativeCopiedFilesReturnFreshMetadata", JSON.stringify(canonical(bridge.readFiles())) === expectedMetadata);
  const fallback = () => { throw Error("Unexpected asynchronous copied-file fallback"); };
  const api = { clipboard: {}, getCopyedFiles: fallback, getCopiedFiles: fallback };
  (window as any).utools = api; (window as any).ztools = api;
  const serialized = hostClipboardBridgeScript(config).replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
  new Function(serialized)();
  for (const name of ["getCopyedFiles", "getCopiedFiles"] as const) {
    const actual = (window as any).utools[name]();
    check(name + "SerializedNativeExactFiles", Array.isArray(actual) && !(actual as any).then && JSON.stringify(canonical(actual)) === expectedMetadata);
  }
  const electron = createPluginElectronAdapter({ application: { name: packageInfo.productName, version: packageInfo.version }, clipboard: bridge });
  check("actualMetadata", electron.app.getVersion() === packageInfo.version);
  for (const [index, value] of ["", " \t\r\n", "  " + config.privateText + " 🧰\n", "a\0b"].entries()) {
    check("syncWrite" + index, electron.clipboard.writeText(value) === undefined);
    const actual = electron.clipboard.readText();
    check("exactNativeText" + index, typeof actual === "string" && actual === value);
  }
  const readOnly = createHostClipboardBridge({ instanceId: config.instanceId, endpoints: { read: config.endpoints.read } }, () => {});
  let writeEscalationBlocked = false;
  try { readOnly.writeText(config.privateText); } catch (error: any) { writeEscalationBlocked = error.code === "ERR_ATOOLS_HOST_CLIPBOARD_PERMISSION_REQUIRED"; }
  check("readDoesNotGrantWrite", writeEscalationBlocked);
  const originalPlugins: { id: string; sha256: string; businessPassed: boolean }[] = [];
  for (const original of __ATOOLS_ORIGINAL_CLIPBOARD_PRELOADS__) {
    // Audited entire unmodified sources, pinned in the runner. No Node process,
    // OS command, filesystem API, history/database shim or external service.
    new Function("require", "window", original.source)((specifier: string) => {
      if (specifier !== "electron") throw new Error("Unexpected module in audited clipboard fixture");
      return electron;
    }, window);
    const text = "  " + config.privateText + "\t\n";
    if (original.id === "uuid-kit") check("uuidOriginalReturn", (window as any).__nativeCopy(text) === true);
    else if (original.id === "subnet-calculator") check("subnetOriginalReturn", (window as any).subnetApis.copyToClipboard(text) === undefined);
    else throw new Error("Unexpected original clipboard fixture");
    check(original.id + "OriginalNativeReadback", electron.clipboard.readText() === text);
    originalPlugins.push({ id: original.id, sha256: original.sha256, businessPassed: true });
  }
  parent.postMessage({ hostClipboardReport: true, passed: true, checks, originalPlugins }, "*");
} catch (error) {
  parent.postMessage({ hostClipboardReport: true, passed: false, checks, error: String(error) }, "*");
}
