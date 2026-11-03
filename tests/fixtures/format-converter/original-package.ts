import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const pins: Record<string, string> = {
  "plugin.json": "e10710be6aef36a74be9c8bba70b520d40a48b6da26027c01db6b84b6ed2482b",
  "index.html": "269a70d7fca41493c278f7081b35c458e798a61f5f86919e1e1c375dd76761fe",
  "logo.svg": "d30bd4bb0c589b5416198754690d9d731345c5d925eeece23a122c7b4c91bb4a",
  "assets/index-CEGGIQwF.js": "90d895647d64d85fd3a634199e9fdca13885f7f3bd0b3d62c264b28ccb2b649e",
  "assets/index-DfgUdfcR.css": "450a7f5fe5769d9c3e80bbfc743c56000201f4f95f1381f4c908e9836b79a7c5",
  "assets/logo-Bsd9tgVr.svg": "d30bd4bb0c589b5416198754690d9d731345c5d925eeece23a122c7b4c91bb4a",
  "preload/conversion-engine.cjs": "2822908e1811feece7e4976d7a194c675d869e974f6273463ac6c743d0f2a98f",
  "preload/engine-utils.cjs": "26695256618d6cbff561d841c58a79b03833d98f2043514b9e8d1e9e7b8b3f5c",
  "preload/format-registry.cjs": "d211b6a145161aee2669fe11de164e45202c59f7e8b2fab3d2b5059e40b0dfec",
  "preload/image-converter.cjs": "861b9b7aeb70132ddbd4f9442e529e19c76f036d8c3fed4976575f06b29530fd",
  "preload/job-manager.cjs": "d5e7c50f39495634a8c50c809cf6a8b2a5eb830d9249f59934db466c9b2b0b46",
  "preload/office-converter.cjs": "9024412dd2bbbdd63f1894bf1f1909f3dfb2fe0eca0965316ab00ccc389c324e",
  "preload/officecli-installer.cjs": "bb0b757ed999cb20adf7aaed086d72faf28b09a8a9d14d093cd7e11211fd687b",
  "preload/package-lock.json": "fb757db69e92a0ebaabd72a745115dae93e152e0d6404a4435bd65728eeb86af",
  "preload/package.json": "66a4d6ec0c141fab8d8b87c22802a989790ca071cf29a3065906dc943db334b7",
  "preload/path-policy.cjs": "ae6f8551d885848064ba2cff9a8a17e0ee7bf34c1064c090bb01ea57fe5df09e",
  "preload/pdf-converter.cjs": "ad097cc36cba094ad3a0a15204c5889f107d95a1114bb14ff59a5a667f0fac17",
  "preload/runtime-installer.cjs": "92475cac32ecc031947363f26995b0788fd16632b2d8fc32e1ad11fa1042dc16",
  "preload/runtime-loader.cjs": "79bc15d879df36cf5c68855232e7686c9be9b4bbbb063b665b5109092f1bed87",
  "preload/runtime-manifest.json": "74854b02cd793c4e29f49080ee402cae71acd0f08e88481cf91180328ec9b18f",
  "preload/runtime-probe.cjs": "359f41eae28426ff437924ab133989782fe2a22b1c55458273adeeea8274da15",
  "preload/services.cjs": "9848915bdf8dcc7d1f5953cce341631f7809fb315d7ed9d440fbc104363571f3",
  "preload/text-converter.cjs": "ec09b1eb7e013b5d5ad7513de0e50e419da8a2ae220d7c8c0713eaf4ad1b6d4a",
  "preload/node_modules/iconv-lite/package.json": "3a9582fd121f841c245d1fcf84ef0b9e41c94b785b8d7eb63f9f5aec9bad0b98",
  "preload/node_modules/iconv-lite/lib/bom-handling.js": "c230d25d8e7fbb50960c634b636b71327c409e9a77e67fe9446b566bdcea362d",
  "preload/node_modules/iconv-lite/lib/index.js": "0cb1506e70126aa00bc5bdf12f2200db89db032e8dabf23dcdd6a92b37d0f2af",
  "preload/node_modules/iconv-lite/lib/streams.js": "368596cfa80b9b9c6b93f2fde73615f10e89d650e6a1c92d3c07d56c34e4e393",
  "preload/node_modules/iconv-lite/encodings/index.js": "ee406729fdea34f4c77eea5afad5025ea374bc41089fafb6fa0f7336e1216713",
  "preload/node_modules/iconv-lite/encodings/internal.js": "78b012b90e43a9d4648d0526f46e26bf07c572bbd3ae5eaedacb244e343609c5",
  "preload/node_modules/iconv-lite/encodings/utf16.js": "506eabee3546c0551f78e6adb3102f4e73e7312b4c709117d0da016b0f5b3d80",
  "preload/node_modules/iconv-lite/encodings/utf32.js": "3a762514744c1edcaf5262f77df105f89581c1292b8321b6f96ad49e9244d95a",
  "preload/node_modules/iconv-lite/encodings/utf7.js": "289da5c0c44b1ec4a502e2862ee9e46d9b1758420904385fed0abae41f138a6c",
  "preload/node_modules/iconv-lite/encodings/sbcs-codec.js": "fb511c4c70a6cb0e2a06d03e67ca88dca9f4da6266b909c7338e453d2ecc9fdb",
  "preload/node_modules/iconv-lite/encodings/sbcs-data.js": "ecd0497db604060a3bf432ea4e2bde76a427dcb6afcedc05c24567773eb0d25c",
  "preload/node_modules/iconv-lite/encodings/sbcs-data-generated.js": "2cf44b3f70c61c9cdd59fda7ec085bc3180809638f208c7239688ccb90a48866",
  "preload/node_modules/iconv-lite/encodings/dbcs-codec.js": "709d9d2e467540b9414ae53f72e43780f9a49fbf648d9a81983eacd34f501e25",
  "preload/node_modules/iconv-lite/encodings/dbcs-data.js": "9d02b706a5f5411e2cf52b5191971b93f6b05b19d7529d829ebd17a1e060e158",
  "preload/node_modules/iconv-lite/encodings/tables/big5-added.json": "db94db5e5d3ab696ddb0025685cfa85da1864839a4a26aab2f8f86f6b8382288",
  "preload/node_modules/iconv-lite/encodings/tables/cp936.json": "8225bb693efd380279ed7280b8f8419fd069c5f018d20d5946bf187ad92c0cf7",
  "preload/node_modules/iconv-lite/encodings/tables/cp949.json": "77a56ea83d0d94d1dc620042ad3c897f0e40814bb05c0085d3aeed0018e8a3e8",
  "preload/node_modules/iconv-lite/encodings/tables/cp950.json": "99e2114dc4b39092617967c763f9eaeb4d8e70551afc5884baa3fb92827f3420",
  "preload/node_modules/iconv-lite/encodings/tables/eucjp.json": "7c4fe279000f7e99fc7cd59afb1da21725dcebdc1babd9e3b883253a77abb042",
  "preload/node_modules/iconv-lite/encodings/tables/gb18030-ranges.json": "5a3cc11e38f05a0908442acbf1c921d0b73f2a304fb6a9e4484e26eb1ca07d76",
  "preload/node_modules/iconv-lite/encodings/tables/gbk-added.json": "10cbb08708f3a431977271887b2663f734390a22cedf90875fac9fdbd4bb5317",
  "preload/node_modules/iconv-lite/encodings/tables/shiftjis.json": "02b0b120f697c48133e8b547e8dc594bc5b9f1c1799b50c2c5ff917298548558",
  "preload/node_modules/safer-buffer/package.json": "4247a3a63c45a6a7ced1557fe4dd9d2a163af4915d594b95e5867b69a53edb52",
  "preload/node_modules/safer-buffer/safer.js": "37f9716144105051ab302f6a0c30a52ff5de7269b9e1173ac22be798fc11ccad",
};

const assetTypes: Record<string, string> = {
  "assets/index-CEGGIQwF.js": "text/javascript; charset=utf-8",
  "assets/index-DfgUdfcR.css": "text/css; charset=utf-8",
  "assets/logo-Bsd9tgVr.svg": "image/svg+xml",
};

export type FormatConverterPackageCopy = {
  sourceRoot: string;
  pluginRoot: string;
  preloadPath: string;
  indexHtml: string;
  builtHashes: Record<string, { bytes: number; sha256: string }>;
  sourceDigests: Map<string, string>;
  assetPins: Record<string, { sha256: string; contentType: string }>;
};

export async function copyReadOnlyFormatConverterPackage(pluginsRoot: string, scratchRoot: string): Promise<FormatConverterPackageCopy> {
  const sourceRoot = join(pluginsRoot, "format-converter", "dist");
  const pluginRoot = join(scratchRoot, "format-converter-dist");
  const builtHashes: Record<string, { bytes: number; sha256: string }> = {};
  const sourceDigests = new Map<string, string>();
  await mkdir(pluginRoot, { recursive: true, mode: 0o700 });
  try {
    for (const [path, expected] of Object.entries(pins)) {
      const source = join(sourceRoot, path);
      const bytes = await readFile(source);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      assert.equal(sha256, expected, `Harris Format Converter 0.1.0 original build hash changed: ${path}`);
      const destination = join(pluginRoot, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { flag: "wx", mode: 0o400 });
      await chmod(destination, 0o400);
      sourceDigests.set(source, sha256);
      builtHashes[path] = { bytes: bytes.length, sha256 };
    }
    const manifest = JSON.parse(await readFile(join(pluginRoot, "plugin.json"), "utf8"));
    assert.equal(manifest.author, "harris");
    assert.equal(manifest.name, "format-converter");
    assert.equal(manifest.version, "0.1.0");
    assert.equal(manifest.main, "index.html");
    assert.equal(manifest.preload, "preload/services.cjs");
    const directories = ownedDirectories(pluginRoot);
    for (const directory of directories) await chmod(directory, 0o500);
    const assetPins = Object.fromEntries(Object.entries(assetTypes).map(([path, contentType]) => [path, {
      sha256: pins[path], contentType,
    }]));
    return { sourceRoot, pluginRoot, preloadPath: join(pluginRoot, manifest.preload),
      indexHtml: await readFile(join(pluginRoot, manifest.main), "utf8"), builtHashes, sourceDigests, assetPins };
  } catch (error) {
    await restoreOwnedCopyDirectoriesWritable({ pluginRoot }).catch(() => {});
    await rm(pluginRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function assertFormatConverterSourceUnchanged(sourceDigests: Map<string, string>) {
  for (const [source, expected] of sourceDigests) {
    const actual = createHash("sha256").update(await readFile(source)).digest("hex");
    assert.equal(actual, expected, `Published Harris Format Converter build changed during fixture: ${relative(process.cwd(), source)}`);
  }
}

/** Restore permissions only on the private copy's directories before its owning temp root is removed. */
export async function restoreOwnedCopyDirectoriesWritable(packageCopy: Pick<FormatConverterPackageCopy, "pluginRoot">) {
  const directories = ownedDirectories(packageCopy.pluginRoot);
  const failures: unknown[] = [];
  for (const directory of directories) {
    try { await chmod(directory, 0o700); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Could not restore every directory in the owned Format Converter copy");
  return { directoriesRestored: directories.length, pluginRoot: packageCopy.pluginRoot };
}

function ownedDirectories(pluginRoot: string) {
  const directories = new Set([pluginRoot]);
  for (const path of Object.keys(pins)) {
    let directory = dirname(join(pluginRoot, path));
    while (directory.startsWith(`${pluginRoot}/`) && directory !== pluginRoot) {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  return [...directories].sort((left, right) => right.length - left.length);
}
