# B970 QA recipe

Run this recipe only after the parent worker stages this candidate's `after/scripts/test-plugin-market-recovery-browser.mjs` into the exact B964 pinned project graph.

1. Preserve the original B964 failure log and report as historical evidence; do not overwrite them.
2. From the staged project root, run `node scripts/test-plugin-market-recovery-browser.mjs` with the same pinned frontend `dist`, local Chrome/CDP setup, and fixture-only environment used for B964. The runner owns Vite on `127.0.0.1:1454` and writes a fresh timestamped report under `output/launcher-ui-2026-10-15/`.
3. Confirm the `restore-custom-market-source` step clicks the visible `button.return-button[aria-label="回到主搜索"]` through `clickAt` (viewport and elementFromPoint hit checks), then waits until the naturally restored `[role=combobox]` is `document.activeElement` before `searchForImport` performs its existing input preparation.
4. Require the complete browser suite to pass, including both Enter and Space recovery activation, exact market restoration, install confirmation cancel/accept, update expected-version behavior, no unexpected commands or external requests, stable source hashes, and successful CDP/Chrome/Vite cleanup.

This candidate was prepared by static inspection only; the QA recipe has not been executed here. The root worker owns runtime execution and acceptance.
