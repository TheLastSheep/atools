# ZTools setting build dependency availability

> Historical availability audit below. The 2026-10-27 follow-up restored exact dependencies in the isolated ATools `packages/ztools-settings` package; it did not install into this upstream checkout or change the root ATools dependencies. Current build results are appended at the end.

## Scope and evidence

- ATools workspace: `/Users/harris/Desktop/atools`, branch `codex/atools-ztools-parity`.
- Upstream HEAD: `9b15fb1a2a9f3ec886016632761c7bb21e39557a`; `internal-plugins/setting` has no scoped Git changes.
- `internal-plugins/setting/node_modules` and `dist` are absent. Its package build script is `vue-tsc && vite build` (`package.json:6-8`).
- Inspected setting `package.json`, Vite/Uno/TypeScript configs and imports; resolved packages with Node `createRequire.resolve`, then read package manifests and `.pnpm` store entries. No package code was loaded.
- Resolution below is from setting's ancestor `ZTools/node_modules` and ATools' existing store; it does not imply the packages are declared or reproducibly linked by setting.

## Build dependency matrix

| Need | Setting range / evidence | Existing package evidence |
|---|---|---|
| Vue | `^3.5.13`, declared dependency | Upstream 3.5.26 at `/Users/harris/Desktop/ZTools/node_modules/.pnpm/vue@3.5.26_typescript@5.9.3/node_modules/vue`; range matches. |
| Vue Router | `^4.6.4`, declared and imported by router/views | Missing from both stores. |
| VueUse | `^14.2.1`, declared and imported by composables | Missing from both stores. |
| Element Plus | imported by `src/utils/message.ts`; undeclared in setting | Missing from both stores. |
| Marked | imported by `usePluginDetail.ts`; undeclared in setting | Upstream root 17.0.1 at `/Users/harris/Desktop/ZTools/node_modules/.pnpm/marked@17.0.1/node_modules/marked`; absent in ATools. Incidental root availability, not a setting declaration. |
| Vite | `^6.0.11`, build script/config | Upstream 7.3.0 at `/Users/harris/Desktop/ZTools/node_modules/.pnpm/vite@7.3.0_@types+node@22.19.3_yaml@2.8.2/node_modules/vite`; ATools 5.4.21 at `/Users/harris/Desktop/atools/node_modules/.pnpm/vite@5.4.21_@types+node@26.1.1/node_modules/vite`. Neither satisfies the range. |
| Vue Vite plugin | `^5.2.1`, `vite.config.ts` | Upstream 6.0.3 at `/Users/harris/Desktop/ZTools/node_modules/.pnpm/@vitejs+plugin-vue@6.0.3_vite@7.3.0_@types+node@22.19.3_yaml@2.8.2__vue@3.5.26_typescript@5.9.3_/node_modules/@vitejs/plugin-vue`; out of range. Missing in ATools. |
| vue-tsc | `^2.0.0`, build script | Upstream 3.1.8 at `/Users/harris/Desktop/ZTools/node_modules/.pnpm/vue-tsc@3.1.8_typescript@5.9.3/node_modules/vue-tsc`; out of range. Missing in ATools. |
| TypeScript | `^5.3.0` | Upstream and ATools 5.9.3 at `/Users/harris/Desktop/ZTools/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript` and `/Users/harris/Desktop/atools/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript`; ranges match. |
| Node types | `^25.3.5` | Upstream 22.19.3 at `/Users/harris/Desktop/ZTools/node_modules/.pnpm/@types+node@22.19.3/node_modules/@types/node` and stored 24.13.2 at `/Users/harris/Desktop/ZTools/node_modules/.pnpm/@types+node@24.13.2/node_modules/@types/node`; ATools 26.1.1 at `/Users/harris/Desktop/atools/node_modules/.pnpm/@types+node@26.1.1/node_modules/@types/node`. None satisfies the range. |
| UnoCSS | `^66.6.6`; Vite config imports `unocss/vite`, Uno config imports package | Missing from both stores. |
| Uno icon preset | `^66.6.6`; used in `uno.config.ts` | Missing from both stores. |
| Uno directives transformer | `^66.6.6`; used in `uno.config.ts` | Missing from both stores. |
| Iconify utils | `^3.1.0`; Uno config imports `@iconify/utils/lib/loader/node-loaders` | Missing from both stores. |
| Less | `^4.5.1`; five Vue files use `<style lang="less">` | Missing from both stores. |
| ZTools API types | `^1.0.1`; `tsconfig.web.json` requests this type package | Missing from both stores. |
| Electron config types | `tsconfig.node.json` extends `@electron-toolkit/tsconfig` and requests `electron-vite/node` | Upstream `@electron-toolkit/tsconfig` 2.0.0 at `/Users/harris/Desktop/ZTools/node_modules/.pnpm/@electron-toolkit+tsconfig@2.0.0_@types+node@22.19.3/node_modules/@electron-toolkit/tsconfig`; `electron-vite` 4.0.1 at `/Users/harris/Desktop/ZTools/node_modules/.pnpm/electron-vite@4.0.1_vite@7.3.0_@types+node@22.19.3_yaml@2.8.2_/node_modules/electron-vite`. Neither is declared by setting; missing in ATools. |

All installed-package physical paths above were resolved from the setting directory or read from the two scoped `.pnpm` stores. The upstream Node-types store has two versions (22.19.3 and 24.13.2), both below the requested `^25.3.5` range; do not substitute them. The same applies to available Vite/plugin/`vue-tsc` versions above.

## Conclusion and limits

- A zero-install, offline build cannot be established from either existing store: required Vue Router, VueUse, Element Plus, UnoCSS packages, Iconify utils, Less, and setting API types are missing; available Vite/plugin/`vue-tsc`/Node types are outside declared ranges.
- `@shared` points outside `internal-plugins/setting`; its target and the complete settings API/host integration were not audited here. This is dependency evidence only, not proof that Settings API calls are connected.
- Preserve the existing same-window `openSettings()` → main-window `pluginView` contract. A new Tauri settings window is not an equivalent replacement.
- No install, build, Cargo command, or upstream script ran. One tool invocation was accidentally routed to a read-only GUI inventory call; that invocation only read the inventory and performed no click, launch, navigation, or state change. No inventory contents are included here.

## 2026-10-27 isolated build follow-up

The package's own previously uninspected `internal-plugins/setting/pnpm-lock.yaml` supplies the exact declared versions. ATools now has a separate `packages/ztools-settings/package.json` and npm lock, with 205 packages installed using the product Node and `--ignore-scripts`. The root ATools manifests/locks and clean pinned upstream remain unchanged. Additional declared build inputs are Element Plus 2.11.5 for the upstream omitted import (official npm metadata confirms Vue peer `^3.2.0`), marked 17.0.1 from the upstream root lock, and the original Electron TypeScript config helpers. No Electron runtime is launched.

`packages/ztools-settings/build.mjs` verifies the pinned upstream commit and stages byte-identical setting/shared sources before running both original TypeScript projects. Source/dependency check passes for 189 files and 1,246,776 bytes. Node config types pass; original web types produce **12 source diagnostics**, before any bridge injection. They concern AliyunCaptcha's nullable state, command/shortcut type unions and Provider return types; they are not proof of a working settings UI.

Default strict build exits 1 and writes no `dist`. Explicit `--review-bundle` preserves the failed checks and still exits 1, but generates only `review-dist` marked `review-only/typecheck-failed`, with complete diagnostic logs/hashes and byte metrics. The measured candidate has 51 emitted resources / 749,106 bytes (511,398 JS; 194,787 CSS), and 783,054 bytes including provenance/license/diagnostics. It has a bridge injection seam, **no connected host API by default**. It is not a production or same-window acceptance result.

Current logs and boundaries: `output/renderer-settings-2026-10-27/verification.md`. The earlier no-install statements above describe the earlier audit only.
