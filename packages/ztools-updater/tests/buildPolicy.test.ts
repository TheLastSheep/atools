import { expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertUpdaterBudget } from '../src/buildPolicy.mjs';
import { publishBuildOutput } from '../../ztools-renderer/output-transaction.mjs';
const policy = { budgetMilestone: 'original-vue-updater-2026-11-02',
    javascript: { baselineBytes: 104330, maxIncreaseBytes: 16384, maxBytes: 120714 },
    resources: { baselineBytes: 284598, maxIncreaseBytes: 16384, maxBytes: 300982 } };
it('holds both independent exact caps and rejects policy drift', () => {
    expect(assertUpdaterBudget({ totalJavaScriptBytes: 120714, totalResourceBytes: 300982 }, policy).passed).toBe(true);
    for (const measured of [{ totalJavaScriptBytes: 120715, totalResourceBytes: 300982 }, { totalJavaScriptBytes: 120714, totalResourceBytes: 300983 }])
        expect(() => assertUpdaterBudget(measured, policy)).toThrow('budget exceeded');
    expect(() => assertUpdaterBudget({ totalJavaScriptBytes: 1, totalResourceBytes: 1 }, { ...policy, resources: { ...policy.resources, maxBytes: 400000 } })).toThrow();
});
it('a staged budget failure never overwrites a previous published updater artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atools-updater-budget-')), output = join(root, 'dist');
    try {
        await mkdir(output);
        await writeFile(join(output, 'updater.html'), 'previous trusted output');
        await expect(publishBuildOutput({ outputRoot: output, buildStage: async (stage: string) => {
                await writeFile(join(stage, 'updater.html'), 'over-budget candidate');
                assertUpdaterBudget({ totalJavaScriptBytes: 120715, totalResourceBytes: 300982 }, policy);
            } })).rejects.toThrow('budget exceeded');
        expect(await readFile(join(output, 'updater.html'), 'utf8')).toBe('previous trusted output');
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
