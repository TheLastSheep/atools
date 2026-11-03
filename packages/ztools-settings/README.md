# Pinned ZTools settings source build

This target compiles the complete upstream `internal-plugins/setting` Vue app,
including its shared-source imports and all routes. The pinned ZTools checkout
remains read-only. The builder applies a narrowly anchored compatibility pass
only to its disposable staging copy. It does not change the main renderer bundle,
the ATools root package manifest, or the ATools root lockfile.

## Build inputs

- ZTools must be a clean checkout at commit
  `9b15fb1a2a9f3ec886016632761c7bb21e39557a`.
- The isolated `packages/ztools-settings/package.json` dependencies must be
  installed into this package's own `node_modules`. The builder never installs
  packages or contacts a registry.
- Run with the product Node `v22.23.3` executable. From the ATools root:

```sh
src-tauri/binaries/node-aarch64-apple-darwin \
  packages/ztools-settings/build.mjs \
  --upstream /absolute/path/to/ZTools
```

To verify the pinned source and the isolated dependency versions without
building the app:

```sh
src-tauri/binaries/node-aarch64-apple-darwin \
  packages/ztools-settings/build.mjs \
  --upstream /absolute/path/to/ZTools --check-only
```

The builder first copies and verifies the complete pinned setting/shared input
set against the original source hash. It then applies exact-hash, exact-anchor
patches to six files in that private staging copy: four type-only corrections,
one async captcha request-identity guard, and General save-error reporting and
retention-value loading. The type-only corrections do not
change emitted JavaScript. The captcha guard prevents a late response from an
older request from settling a newer pending request. Vue template and CSS bytes
are checked unchanged. The patch audit records each source path, before/after
SHA-256, patch category and template/style check; `source.inputSha256` continues
to identify the unmodified pinned input, while `sourceCompatibility.effectiveInput`
identifies the complete patched input set.

Both typecheck projects from the upstream setting package run against that same
patched stage: `tsc` checks `tsconfig.node.json`, and `vue-tsc` checks
`tsconfig.web.json`. The copy and its temporary `node_modules` link are created
inside this package, so patching, typecheck and Vite cannot write into the
upstream checkout. Vite builds the original `index.html` and `src/main.ts` with
the original UnoCSS config, Vue plugin, Less styles and `@shared` files.

The Tauri child bridge is imported into the staged original entry before both
strict checks. Its complete TypeScript source set and runtime imports are
hashed in `build.hostBridgeSources`; a source change during the build rejects
the candidate. The original templates and styles remain unchanged. Native
hosting uses a private document session and exposes a bounded General projection,
with 15 writable fields: placeholder, theme, primary/custom color, auto-clear,
recent visibility/rows, pinned rows, search mode, match recommendations, Tab
behavior/target, Space command activation, local app search and opacity. These
preferences use one validated patch and the existing commit notification.
On macOS, opacity writes apply and read back the actual window alpha before
committing; failed application or commit restores the previously observed alpha.
The original slider's subsequent same-value save performs no additional write.
Opacity is explicitly unavailable on other platforms; other unsupported actions
report an error. The complete
route bundle does not imply that every settings capability is implemented.

The default strict build stops before Vite and leaves `dist/` untouched when a
typecheck fails. For controlled inspection of the original UI despite existing
upstream type errors, pass `--review-bundle`. That mode still runs every
typecheck, saves each full stdout/stderr log and its SHA-256 in
`review-dist/typecheck-diagnostics/`, then writes the candidate to
`packages/ztools-settings/review-dist/`. Its provenance is always marked
`review-only`; on typecheck failure the command exits nonzero even when the
candidate bundle was emitted. A review candidate is never promoted to `dist/`.

```sh
src-tauri/binaries/node-aarch64-apple-darwin \
  packages/ztools-settings/build.mjs \
  --upstream /absolute/path/to/ZTools --review-bundle
```

The package pins the setting package's own lockfile versions. `element-plus`
2.11.5 is explicitly added because the app imports `ElMessage` while the setting
manifest omits it; its Vue peer range was checked against Vue 3.5.26. `marked`
17.0.1 comes from the pinned ZTools root manifest and lock. The Electron
TypeScript config helpers are included because the upstream setting TypeScript
configs reference them; the build only checks types and does not run Electron.
The exact versions and rationale are recorded in `source-manifest.json`.

## Host bridge seam

The builder injects `src/hostBridgeEntry.ts` before the upstream setting entry.
It creates and attaches the native child bridge in the same WebView, using the
Tauri `call_renderer_settings` command and configured private document session.
Missing Tauri access or invalid bridge configuration reports an error and stops
initialization. The build provenance records the selected bridge input hash; a
bundle does not establish that every host API or the same-window
`openSettings()` flow is implemented.

## Output and provenance

Only `packages/ztools-settings/dist/` receives the built app. The main renderer
continues to use `packages/ztools-renderer/dist/`. Existing `dist/` contents
are replaced only when their `build-provenance.json` contains this builder's
ownership marker.

`dist/build-provenance.json` records the fixed upstream commit and clean-tree
check, the complete original and patched setting/shared input hashes and byte
counts, every compatibility patch, exact installed dependency versions, the
local bridge source hash, typecheck results, and the path, byte size and SHA-256
of every Vite-emitted resource. It also records total emitted resource bytes.
Each successful build prints the full distribution size. The
`original-vue-main-hotkey-2026-10-29` milestone uses the measured R43
784,315-byte emitted-resource baseline and allows 2,048 additional bytes, with
the existing 786,432-byte absolute ceiling. The effective cap is 786,363
bytes. The R44 measurement is 786,127 bytes, leaving 236 bytes under the
effective cap and 305 bytes under the absolute ceiling. The prior
`original-vue-tray-visibility-2026-10-29` policy remains accepted at its frozen
values; it is not the active policy for this artifact.
Both limits apply to the complete uncompressed Vite resource set, including
CSS and images. Exceeding a limit stops promotion and preserves the previous
owned distribution. License, provenance and build-metadata bytes are measured
separately in the full distribution size; this budget is not a whole-application
package or memory measurement.

The static package build can establish that the full Vue application compiled.
It does not establish runtime settings API behavior, original plugin view
integration, visible UI, or business acceptance. Those remain native host and
same-window acceptance work.
