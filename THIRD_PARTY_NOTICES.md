# Third-party notices

## Node.js POSIX path behavior

The `basename` and `parse` state machines in
`src/lib/pluginNodePosixPath.ts` are adapted from Node.js v22.23.3
[`lib/path.js`](https://github.com/nodejs/node/blob/v22.23.3/lib/path.js).
The same copyright and MIT permission notice is preserved in that source file
as a legal comment, which the production JavaScript bundle retains.

Copyright Joyent, Inc. and other Node contributors.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.

---

## ZTools Upstream Renderer, Settings & Updater Bundles

Pinned compatibility bundles under `packages/ztools-renderer`,
`packages/ztools-settings`, and `packages/ztools-updater` (along with their
packaged `ZTools-LICENSE` and `source-manifest.json` artifacts) incorporate
upstream open-source components from the ZTools project
([`ZToolsCenter/ZTools`](https://github.com/ZToolsCenter/ZTools)). Original
upstream license files (`ZTools-LICENSE`) and commit provenance manifests are
retained verbatim inside each corresponding package directory and release
resource bundle.

---

## Rust, Tauri & Web Open-Source Ecosystem

ATools builds upon open-source crates and packages distributed under MIT,
Apache-2.0, BSD, and ISC licenses, including:

- **Tauri v2** (`tauri`, `tauri-build`, `tauri-plugin-*`) — Apache-2.0 / MIT
- **Tokio & Axum** (`tokio`, `axum`, `tower`) — MIT
- **SQLite & Rusqlite** (`rusqlite`, `libsqlite3-sys`) — MIT / Public Domain
- **QuickJS Rust Bindings** (`rquickjs`) — MIT
- **Svelte 5 & Vite** (`svelte`, `vite`, `@sveltejs/vite-plugin-svelte`) — MIT
- **Pinyin Engines** (`pinyin`, `pinyin-pro`) — MIT
