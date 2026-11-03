# Original updater build target

Build the pinned original Vue updater with a closed popup bridge. This target does not check for,
fetch, install or restart updates during build. It leaves the default Svelte entry and the existing
Main/Settings outputs unchanged.

Use bundled Node v22.23.3, an unchanged ZTools checkout at 9b15fb1a2a9f3ec886016632761c7bb21e39557a,
and its already-installed offline dependencies:

```sh
./src-tauri/binaries/node-aarch64-apple-darwin packages/ztools-updater/build.mjs --upstream /Users/harris/Desktop/ZTools --check-only
./src-tauri/binaries/node-aarch64-apple-darwin packages/ztools-updater/build.mjs --upstream /Users/harris/Desktop/ZTools
./src-tauri/binaries/node-aarch64-apple-darwin node_modules/vitest/vitest.mjs run --config packages/ztools-updater/vitest.config.mjs
```

The independent output is `dist-ztools-updater`. Runtime resources are exactly the Vite-emitted
HTML/JS/CSS/original PNG; provenance, source manifest and MIT license are non-runtime metadata.
The source manifest pins separate JS and all-emitted-resource caps. Every build validates the
recursive installed dependency closure, original sources, local bridge/build imports and staged
sources before atomic publication. Budget/type/source failure preserves the previous output.
No dependencies are installed and existing Main/Settings builders are not modified.

Original template, styles and logo remain byte-preserved. The reviewed script patch binds the
closed Native contract, renders notes through a fresh allowlist DOM, routes links/drag to exact
owned-window operations, and cleans all subscriptions on unmount/pagehide. Native owns candidate
identity, real updater work, appearance and window authority; a renderer acknowledgement is not
installation evidence. See `docs/contracts/ztools-original-updater-r78-2026-11-02.md` in the repo.

DOM/caller tests use synthetic transport and an active JSDOM resource-loader control. Real browser
resource/CSP, visible/physical window, actual network update/signature/install/restart and platform
acceptance remain separate work. The updater plugin's transient download allocation is not bounded
by this renderer's note/DOM/resource limits.
