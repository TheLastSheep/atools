import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { auditWebviewOutput } from '../../ztools-build/webview-output.mjs'
import { inspectEmittedResources } from '../../ztools-settings/src/output-audit.mjs'
import { builtinModules } from 'node:module'
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))
async function fixture(entry = 'updater.html') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'atools-updater-output-')))
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, entry), '<script type="module" src="./assets/app.js"></script>')
  await writeFile(join(root, 'assets/app.js'), 'console.warn("safe")')
  return {
    root,
    paths: [entry, 'assets/app.js'],
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}
it('audits actual updater.html without altering the default Settings index.html contract', async () => {
  const f = await fixture()
  try {
    await expect(inspectEmittedResources(f.root, [], builtins)).rejects.toThrow(
      'did not emit index.html'
    )
    expect(
      (await auditWebviewOutput(f.root, { entryHtml: 'updater.html', expectedPaths: f.paths }))
        .resources
    ).toHaveLength(2)
    await expect(
      auditWebviewOutput(f.root, { entryHtml: 'index.html', expectedPaths: f.paths })
    ).rejects.toThrow('did not emit index.html')
  } finally {
    await f.cleanup()
  }
  const old = await fixture('index.html')
  try {
    expect((await inspectEmittedResources(old.root, [], builtins)).resources).toHaveLength(2)
  } finally {
    await old.cleanup()
  }
})
it('rejects missing, extra, symlink resources and symlink output roots', async () => {
  const f = await fixture()
  try {
    await expect(
      auditWebviewOutput(f.root, { entryHtml: 'updater.html', expectedPaths: ['updater.html'] })
    ).rejects.toThrow('resource set')
    await expect(
      auditWebviewOutput(f.root, {
        entryHtml: 'updater.html',
        expectedPaths: [...f.paths, 'missing.js']
      })
    ).rejects.toThrow('resource set')
    await symlink(join(f.root, 'assets/app.js'), join(f.root, 'assets/link.js'))
    await expect(
      auditWebviewOutput(f.root, {
        entryHtml: 'updater.html',
        expectedPaths: [...f.paths, 'assets/link.js']
      })
    ).rejects.toThrow('symlink')
    await symlink(f.root, f.root + '-link', 'dir')
    try {
      await expect(
        auditWebviewOutput(f.root + '-link', { entryHtml: 'updater.html', expectedPaths: f.paths })
      ).rejects.toThrow('ordinary directory')
    } finally {
      await rm(f.root + '-link')
    }
  } finally {
    await f.cleanup()
  }
})
for (const module of [
  'node:fs',
  'fs/promises',
  'electron/renderer',
  'https://invalid.example/module.js'
])
  it(`rejects dangerous runtime import ${module}`, async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.root, 'assets/app.js'), `import x from ${JSON.stringify(module)};`)
      await expect(
        auditWebviewOutput(f.root, { entryHtml: 'updater.html', expectedPaths: f.paths })
      ).rejects.toThrow('Forbidden WebView')
    } finally {
      await f.cleanup()
    }
  })
it('rejects absolute source leaks and noncanonical or duplicate expected paths', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'assets/app.js'), 'const source="/owned/worktree/private"')
    await expect(
      auditWebviewOutput(f.root, {
        entryHtml: 'updater.html',
        expectedPaths: f.paths,
        forbiddenPaths: ['/owned/worktree']
      })
    ).rejects.toThrow('absolute source')
    for (const expectedPaths of [['../escape.js'], ['updater.html', 'updater.html']])
      await expect(
        auditWebviewOutput(f.root, { entryHtml: 'updater.html', expectedPaths })
      ).rejects.toThrow('Invalid closed')
  } finally {
    await f.cleanup()
  }
})
