import { expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { capturePinnedSource, captureDependencyClosure, snapshotFiles } from '../../ztools-build/pinned-inputs.mjs';
it('rejects wrong pinned checkout and version before treating installed dependencies as verified', async () => {
    await expect(capturePinnedSource('/Users/harris/Desktop/ZTools', '0'.repeat(40), ['package.json'])).rejects.toThrow('identity');
    await expect(captureDependencyClosure('/Users/harris/Desktop/ZTools', { vue: '0.0.0' })).rejects.toThrow('version mismatch');
});
it('rejects source escape and intermediate-directory symlinks; actual source bytes change the captured digest', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'atools-updater-source-')));
    try {
        await mkdir(join(root, 'owned'));
        await writeFile(join(root, 'owned', 'file.ts'), 'before');
        const before = await snapshotFiles(root, ['owned/file.ts']);
        await writeFile(join(root, 'owned', 'file.ts'), 'after');
        const after = await snapshotFiles(root, ['owned/file.ts']);
        expect(after[0].sha256).not.toBe(before[0].sha256);
        await symlink(join(root, 'owned'), join(root, 'alias'), 'dir');
        await expect(snapshotFiles(root, ['alias/file.ts'])).rejects.toThrow('Unsafe input');
        await expect(snapshotFiles(root, ['../escape.ts'])).rejects.toThrow();
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
