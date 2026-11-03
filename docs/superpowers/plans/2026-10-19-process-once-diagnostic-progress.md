# Process `once` compatibility diagnostic progress

## Result

The B51 diagnostic was accepted as a bounded compatibility diagnostic, with original translation behavior still pending. It establishes that the current production preload builder places the Node environment before the unchanged Easy Translate preload, the serialized production bridge can register a private event against an in-process EventEmitter, and the production CJS codec/bootstrap can register that event in a real Node child. It does not establish the Electron `loaded` lifecycle, the historical “Failed to fetch” cause, or translation/provider behavior.

No product source was changed for this diagnostic. The selected evidence and exact inputs are in [the B51 evidence archive](../../../output/plugin-input-2026-10-19/batch51-evidence-v1/README.md); its file pins are in [the external archive manifest](../../../output/plugin-input-2026-10-19/batch51-evidence-manifest-v1.json). The report’s input selection is a bounded diagnostic set, not the full compiler/runtime dependency closure. The accepted result is recorded in [the root acceptance record](../../../output/plugin-input-2026-10-19/batch51-evidence-v1/root/root-acceptance-v1.json).

## Scope and limits

The VM stage exercised the serialized current bridge with a fake synchronous XHR and isolated EventEmitter. The separate child stage used Node 24.15.0 with the production CJS codec/bootstrap over stdio, manually registered and removed one private listener, observed zero poll events, then closed the child. These are distinct from the Rust-owned production sidecar and desktop host path. The child Node executable is identified by path, byte length, and SHA-256 in the report but is not copied into the archive.

The paired historic browser report includes partial resource fingerprints, but there is no current host/runtime source binding for that historic run. The original Easy Translate preload’s `process.once('loaded', ...)` remains unverified in its real Electron lifecycle. The plugin’s translation/provider request was not run, so the old “Failed to fetch” observation remains unresolved. The child history v1 script and README are retained as explicitly unexecuted history; root found two pre-run blockers, and no v1 child runtime report exists.

This evidence is local diagnostic acceptance only: zero product fixes, zero new native original-plugin workflows, majority direct-use acceptance false, release/formal acceptance false, and the broader ATools goal remains active. No Git mutation was performed.
