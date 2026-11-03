# Pinned ZTools renderer source build

This package builds the original Vue renderer from one pinned ZTools checkout.
It does not switch ATools' default application entry and does not edit upstream
files. A Vite transform prepends the ATools host adapter import to the original
`src/renderer/src/main.ts` while compiling the original renderer HTML entry.

## Requirements

- The upstream checkout must be at commit `9b15fb1a2a9f3ec886016632761c7bb21e39557a`
  with no tracked or untracked changes.
- Its installed `node_modules` must provide the packages listed in
  `source-manifest.json`; this build does not install packages.
- Install this package's build-only dependency from its checked-in npm lock:
  `npm ci --prefix packages/ztools-renderer --ignore-scripts --no-audit --no-fund`.
  Use the bundled Node to run your npm CLI when preparing the dependencies.
  The local npm installation layout is required; linked pnpm dependencies are
  rejected by the build's dependency identity checks.
- Use the product's bundled Node 22.23.3 executable. From the ATools root:

```sh
src-tauri/binaries/node-aarch64-apple-darwin \
  packages/ztools-renderer/build.mjs \
  --upstream /path/to/ZTools
```

The source path is an explicit CLI argument. `ATOOLS_ZTOOLS_SOURCE` is an
equivalent option for scripted builds. The build refuses an unspecified path,
an unexpected source commit, a dirty source checkout, a different Node
version, or a missing ATools adapter module.

To validate the upstream source lock and its installed dependencies without
writing the bundle (the full build also verifies the local post-minifier):

```sh
src-tauri/binaries/node-aarch64-apple-darwin \
  packages/ztools-renderer/build.mjs \
  --upstream /path/to/ZTools --check-only
```

## Output and provenance

The build uses a private sibling stage and an exclusive `.dist.build.lock`.
It publishes `packages/ztools-renderer/dist/` only after the budget, source,
dependency and output checks pass. A build or validation failure before
publication leaves the accepted output unchanged. Publication keeps a
temporary backup and restores it if the stage
rename fails; an unsuccessful rollback reports the retained backup path.
The build removes only its own stage and lock. A lock left by an interrupted
process requires inspection before retrying; the builder does not guess that
another process has stopped or delete its lock. Directory publication uses
backup and rename operations, so it does not promise uninterrupted reads by
an unrelated concurrent process. Run renderer builds through this builder so
they share the lock. A lock-release error after publication reports that the
new output is already published and retains conflicting lock data for recovery.

It preserves the
upstream `LICENSE` as `ZTools-LICENSE`, copies the upstream `package.json` as
`upstream-package.json` for provenance, and includes the pinned
`source-manifest.json` plus generated `build-provenance.json`. The copied
upstream package manifest is metadata; it is not a runtime install manifest.
No Electron or Node runtime is copied into the bundle. The build rejects
Electron and Node built-in imports and scans the output for such imports and
for references to the source checkout's absolute path.

### Frozen historical renderer budgets

The optional original Vue renderer counts every emitted JavaScript chunk,
including its pinyin dependency. Earlier frozen milestones remain accepted by
the provenance validator: settings-input used a 587,945-byte baseline, a
1,879-byte increment and a 589,824-byte absolute cap; disabled-command CAS
used a 589,758-byte baseline, a 1,024-byte increment and a 590,848-byte
absolute cap. Its effective cap was 590,782 bytes. The local-app-search
milestone used a 590,200-byte R36 baseline, a 3,072-byte increment and a
593,920-byte absolute cap, for an effective cap of 593,272 bytes. The final
R37 measurement was 592,149 bytes, 1,949 bytes above that baseline. These
static bundle budgets do not measure runtime performance. The default Svelte
release entry keeps its separate 560 KiB initial-import budget.

### Plugin-inventory build budget

The current `original-vue-plugin-inventory-2026-10-28` milestone uses the final
R37 measurement of 592,149 bytes as its baseline and permits up to 2,048
additional bytes. Its absolute cap remains 593,920 bytes (580 KiB). The
incremental boundary is 594,197 bytes, above the absolute cap, so the effective
limit is 593,920 bytes. The R38 bundle measured 593,860 bytes: 1,711 bytes
above R37 and 60 bytes below the existing absolute cap. This allowance records
the reviewed Main plugin-inventory change; it is not evidence of improved
runtime performance, and it does not raise the absolute budget.

Production builds remove informational `console.log`/`console.debug` calls
through esbuild's pure-call handling. Argument side effects and all warning
and error diagnostics remain; this policy is recorded in build provenance.

### Post-minifier policy

A fixed Terser 5.51.2 pass runs after ordinary Rollup/Vite chunk hooks. It
preserves getters and argument side effects, uses no unsafe compression
options, and does not mangle public property names. The tool is a development
dependency; its code and `node_modules` are not copied into the application
output.

The provenance records the exact tool policy, package/lock/helper hashes,
the full local installed-file tree digest, and per-chunk measurements before
and after the pass. Inputs are checked again before publication. Measurements
at the chunk hook can differ slightly from final emitted bytes after Rollup
replaces hash placeholders; the existing final-chunk budget remains decisive.

The host adapter lives at `packages/ztools-renderer/src/hostAdapter.ts` and is
owned by the ATools host integration. The builder only injects its import; it
does not define or emulate adapter behavior. Bundle success alone does not
prove that the renderer's `window.ztools` calls are implemented or that the UI
is accepted in a Tauri WebView.

## Optional Tauri entry

The default ATools Tauri configuration continues to use the Svelte frontend.
To point an explicit Tauri CLI invocation at an already built Vue renderer,
first build it from a clean, pinned ZTools checkout:

```sh
export ATOOLS_ZTOOLS_SOURCE=/path/to/ZTools
src-tauri/binaries/node-aarch64-apple-darwin \
  packages/ztools-renderer/build.mjs \
  --upstream "$ATOOLS_ZTOOLS_SOURCE"
```

Then pass the optional configuration extension to the Tauri CLI:

```sh
src-tauri/binaries/node-aarch64-apple-darwin -e '
const cli = require("@tauri-apps/cli");
cli.run(process.argv.slice(1), "tauri", (error) => {
  if (error) { cli.logError(error.message); process.exitCode = 1; }
});
' -- dev --config src-tauri/tauri.ztools-renderer.conf.json

# Use the same invocation with `build` to package the already-built renderer.
src-tauri/binaries/node-aarch64-apple-darwin -e '
const cli = require("@tauri-apps/cli");
cli.run(process.argv.slice(1), "tauri", (error) => {
  if (error) { cli.logError(error.message); process.exitCode = 1; }
});
' -- build --config src-tauri/tauri.ztools-renderer.conf.json
```

This extension merges over `src-tauri/tauri.conf.json`. It clears the default
Svelte `beforeDevCommand`, `devUrl`, and `beforeBuildCommand`, and points
`frontendDist` at the Vue build output. Development mode therefore serves the
existing static Vue bundle through Tauri CLI's built-in asset server; it does
not start Vite or rebuild either frontend. Re-run the explicit renderer build
whenever the pinned Vue source or host adapter changes. Passing no `--config`
keeps the normal Svelte entry unchanged.

The original same-window settings entry is opt-in. Build
`packages/ztools-settings/build.mjs` with the same pinned checkout first, then
add `--features ztools-multiwebview` to the explicit Tauri `dev` or `build`
invocation above. The avatar button and Cmd+, open the original settings Vue
app in one private child Webview below the 58 logical-pixel search header.
This does not use the legacy separate `/#/settings` window.

Direct Main writes permit `placeholder`, `theme`, `primaryColor`,
`customColor`, and `autoClear`. The original settings child also permits
search mode, recent/recommendation visibility, recent/pinned rows, Tab mode
and target, and Space command activation (13 fields in total). These writes
use the shared revision-checked coordinator; other mutations report unsupported.
Installed plugin execution and all settings tabs are not yet complete. The
default Svelte entry remains available while this opt-in path is developed.
