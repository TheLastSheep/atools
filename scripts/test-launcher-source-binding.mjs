import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { launcherFrontendSourceFiles, launcherSourceFiles } from './lib/launcher-source-binding.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const [label, files] of Object.entries({ launcherFrontendSourceFiles, launcherSourceFiles })) {
  test(`${label} can be enumerated by real source-binding consumers`, () => {
    assert.ok(files.length > 0);
    for (const [index, source] of Array.from(files).entries()) {
      assert.equal(typeof source, 'string', `${label}[${index}] must not be an empty array slot`);
      assert.ok(source.length > 0);
      assert.equal(path.isAbsolute(source), false);
      const absolute = path.resolve(root, source);
      assert.ok(absolute.startsWith(root), `source must stay in the repository: ${source}`);
      assert.equal(statSync(absolute).isFile(), true, `source must exist: ${source}`);
    }
  });
}
