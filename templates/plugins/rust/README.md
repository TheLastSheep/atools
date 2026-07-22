# ATools Rust plugin template

The packaging tool builds this sidecar into a temporary target directory, runs a JSON-RPC smoke call, and places the binary at `bin/atools-rust-echo` in the deterministic ZIP.

```bash
node ../../../scripts/plugin-package.mjs --source . --build-rust --output ./dist/atools-rust-echo.zip
```
