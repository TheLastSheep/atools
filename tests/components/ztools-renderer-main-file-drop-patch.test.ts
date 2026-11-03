import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { applyReviewedRendererCompatibilityPatch } from '../../packages/ztools-renderer/upstream-compatibility-patches.mjs';

const path = '/Users/harris/Desktop/ZTools/src/renderer/src/components/search/SearchBox.vue';
const relative = 'src/renderer/src/components/search/SearchBox.vue';
const require = createRequire('/Users/harris/Desktop/ZTools/node_modules/.pnpm/package.json');
const { parse } = require('@vue/compiler-sfc');

it('patches the pinned original SearchBox script without changing its template or styles', () => {
  const original = readFileSync(path, 'utf8');
  const patched = applyReviewedRendererCompatibilityPatch(relative, original);
  expect(patched).not.toBeNull();
  const a = parse(original).descriptor, b = parse(patched!.code).descriptor;
  expect(b.template.content).toBe(a.template.content);
  expect(b.styles.map((s: { content: string }) => s.content)).toEqual(a.styles.map((s: { content: string }) => s.content));
  expect(b.scriptSetup.content).toContain('onNativeMainFileDrop');
});
