import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { publishBuildOutput } from '../packages/ztools-renderer/output-transaction.mjs'

async function withTemporaryDirectory(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atools-renderer-build-output-'))
  try {
    await run(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function snapshotTree(root) {
  const entries = []
  async function walk(directory, relative = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = path.join(relative, entry.name)
      const absolute = path.join(directory, entry.name)
      const metadata = await fs.lstat(absolute)
      if (metadata.isDirectory()) {
        entries.push({ path: childRelative, kind: 'directory', mode: metadata.mode & 0o777 })
        await walk(absolute, childRelative)
      } else if (metadata.isFile()) {
        entries.push({
          path: childRelative,
          kind: 'file',
          mode: metadata.mode & 0o777,
          bytes: await fs.readFile(absolute)
        })
      } else if (metadata.isSymbolicLink()) {
        entries.push({ path: childRelative, kind: 'symlink', target: await fs.readlink(absolute) })
      }
    }
  }
  await walk(root)
  return entries
}

async function assertNoTransactionArtifacts(parent, outputName) {
  const names = await fs.readdir(parent)
  assert.equal(names.some((name) => name.startsWith(`.${outputName}.stage-`)), false)
  assert.equal(names.some((name) => name.startsWith(`.${outputName}.backup-`)), false)
  assert.equal(names.includes(`.${outputName}.build.lock`), false)
  assert.equal(names.some((name) => name.startsWith(`.${outputName}.build.lock.release-claim-`)), false)
}

test('publishes a completed stage over the accepted output and preserves output mode', async () => {
  await withTemporaryDirectory(async (root) => {
    const outputRoot = path.join(root, 'dist')
    await fs.mkdir(outputRoot, { mode: 0o750 })
    await fs.mkdir(path.join(outputRoot, 'assets'))
    await fs.writeFile(path.join(outputRoot, 'index.html'), 'accepted')
    await fs.writeFile(path.join(outputRoot, 'assets', 'old.js'), 'old')

    const published = await publishBuildOutput({
      outputRoot,
      async buildStage(stageRoot) {
        assert.equal((await fs.stat(stageRoot)).mode & 0o777, 0o700)
        await fs.mkdir(path.join(stageRoot, 'assets'))
        await fs.writeFile(path.join(stageRoot, 'index.html'), 'new')
        await fs.writeFile(path.join(stageRoot, 'assets', 'main.js'), 'bundle')
      }
    })

    assert.equal(published, outputRoot)
    assert.equal(await fs.readFile(path.join(outputRoot, 'index.html'), 'utf8'), 'new')
    assert.equal(await fs.readFile(path.join(outputRoot, 'assets', 'main.js'), 'utf8'), 'bundle')
    await assert.rejects(fs.stat(path.join(outputRoot, 'assets', 'old.js')), { code: 'ENOENT' })
    assert.equal((await fs.stat(outputRoot)).mode & 0o777, 0o750)
    await assertNoTransactionArtifacts(root, 'dist')
  })
})

test('publishes a new output when no accepted directory exists yet', async () => {
  await withTemporaryDirectory(async (root) => {
    const outputRoot = path.join(root, 'dist')
    await publishBuildOutput({
      outputRoot,
      async buildStage(stageRoot) {
        await fs.writeFile(path.join(stageRoot, 'index.html'), 'first build')
      }
    })

    assert.equal(await fs.readFile(path.join(outputRoot, 'index.html'), 'utf8'), 'first build')
    assert.equal((await fs.stat(outputRoot)).mode & 0o777, 0o755)
    await assertNoTransactionArtifacts(root, 'dist')
  })
})

test('preserves every accepted file when the build or validation callback throws', async () => {
  await withTemporaryDirectory(async (root) => {
    const outputRoot = path.join(root, 'dist')
    await fs.mkdir(path.join(outputRoot, 'nested'), { recursive: true })
    await fs.writeFile(path.join(outputRoot, 'index.html'), 'accepted html')
    await fs.writeFile(path.join(outputRoot, 'nested', 'bundle.js'), 'accepted bundle')
    const before = await snapshotTree(outputRoot)

    await assert.rejects(publishBuildOutput({
      outputRoot,
      async buildStage(stageRoot) {
        await fs.writeFile(path.join(stageRoot, 'index.html'), 'rejected html')
        await fs.writeFile(path.join(stageRoot, 'new.js'), 'rejected bundle')
        throw new Error('output validation rejected the candidate')
      }
    }), /output validation rejected the candidate/)

    assert.deepEqual(await snapshotTree(outputRoot), before)
    await assertNoTransactionArtifacts(root, 'dist')
  })
})

test('refuses a stage root replaced with a symlink and does not touch its target', async () => {
  await withTemporaryDirectory(async (root) => {
    const outputRoot = path.join(root, 'dist')
    const outside = path.join(root, 'outside')
    await fs.mkdir(outputRoot)
    await fs.writeFile(path.join(outputRoot, 'accepted.js'), 'accepted')
    await fs.mkdir(outside, { mode: 0o751 })
    await fs.chmod(outside, 0o751)
    await fs.writeFile(path.join(outside, 'keep.txt'), 'outside fixture')
    const acceptedBefore = await snapshotTree(outputRoot)
    const outsideBefore = await snapshotTree(outside)
    const outsideModeBefore = (await fs.stat(outside)).mode & 0o777
    let stagePath

    await assert.rejects(publishBuildOutput({
      outputRoot,
      async buildStage(stageRoot) {
        stagePath = stageRoot
        await fs.rename(stageRoot, `${stageRoot}.displaced`)
        await fs.symlink(outside, stageRoot)
      }
    }), /stage ownership changed/)

    assert.deepEqual(await snapshotTree(outputRoot), acceptedBefore)
    assert.deepEqual(await snapshotTree(outside), outsideBefore)
    assert.equal((await fs.stat(outside)).mode & 0o777, outsideModeBefore)
    assert.equal((await fs.lstat(stagePath)).isSymbolicLink(), true)
    assert.equal((await fs.stat(`${stagePath}.displaced`)).isDirectory(), true)
    assert.equal(await fs.readFile(path.join(root, '.dist.build.lock')).catch(() => null), null)
  })
})

test('refuses and preserves a stage path replaced with a different directory', async () => {
  await withTemporaryDirectory(async (root) => {
    const outputRoot = path.join(root, 'dist')
    await fs.mkdir(outputRoot)
    await fs.writeFile(path.join(outputRoot, 'accepted.js'), 'accepted')
    const acceptedBefore = await snapshotTree(outputRoot)
    let stagePath

    await assert.rejects(publishBuildOutput({
      outputRoot,
      async buildStage(stageRoot) {
        stagePath = stageRoot
        await fs.rename(stageRoot, `${stageRoot}.displaced`)
        await fs.mkdir(stageRoot, { mode: 0o700 })
        await fs.writeFile(path.join(stageRoot, 'replacement.txt'), 'do not delete')
      }
    }), /stage ownership changed/)

    assert.deepEqual(await snapshotTree(outputRoot), acceptedBefore)
    assert.equal(await fs.readFile(path.join(stagePath, 'replacement.txt'), 'utf8'), 'do not delete')
    assert.equal((await fs.stat(`${stagePath}.displaced`)).isDirectory(), true)
    assert.equal(await fs.readFile(path.join(root, '.dist.build.lock')).catch(() => null), null)
  })
})

test('rejects symlink and non-directory output targets before invoking the builder', async () => {
  await withTemporaryDirectory(async (root) => {
    const target = path.join(root, 'real-output')
    const linkedOutput = path.join(root, 'linked-dist')
    const fileOutput = path.join(root, 'file-dist')
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'accepted.js'), 'keep')
    await fs.symlink(target, linkedOutput)
    await fs.writeFile(fileOutput, 'accepted file')
    let buildCalls = 0
    const buildStage = async () => { buildCalls += 1 }

    await assert.rejects(publishBuildOutput({ outputRoot: linkedOutput, buildStage }), /ordinary directory/)
    await assert.rejects(publishBuildOutput({ outputRoot: fileOutput, buildStage }), /ordinary directory/)

    assert.equal(buildCalls, 0)
    assert.equal((await fs.lstat(linkedOutput)).isSymbolicLink(), true)
    assert.equal(await fs.readFile(path.join(target, 'accepted.js'), 'utf8'), 'keep')
    assert.equal(await fs.readFile(fileOutput, 'utf8'), 'accepted file')
    await assertNoTransactionArtifacts(root, 'linked-dist')
    await assertNoTransactionArtifacts(root, 'file-dist')
  })
})

test('does not remove a pre-existing lock it does not own', async () => {
  await withTemporaryDirectory(async (root) => {
    const outputRoot = path.join(root, 'dist')
    const lockPath = path.join(root, '.dist.build.lock')
    await fs.writeFile(lockPath, 'foreign-owner:42\n', { mode: 0o600 })
    let buildCalls = 0

    await assert.rejects(publishBuildOutput({
      outputRoot,
      async buildStage() { buildCalls += 1 }
    }), /lock already exists/)

    assert.equal(buildCalls, 0)
    assert.equal(await fs.readFile(lockPath, 'utf8'), 'foreign-owner:42\n')
  })
})

test('serializes competing builds and keeps the first owner lock until publication', async () => {
  await withTemporaryDirectory(async (root) => {
    const outputRoot = path.join(root, 'dist')
    let markStarted
    let releaseBuild
    const started = new Promise((resolve) => { markStarted = resolve })
    const gate = new Promise((resolve) => { releaseBuild = resolve })
    let secondBuildCalls = 0

    const first = publishBuildOutput({
      outputRoot,
      async buildStage(stageRoot) {
        await fs.writeFile(path.join(stageRoot, 'index.html'), 'first')
        markStarted()
        await gate
      }
    })
    await started
    const lockPath = path.join(root, '.dist.build.lock')
    const firstOwnerLock = await fs.readFile(lockPath, 'utf8')

    await assert.rejects(publishBuildOutput({
      outputRoot,
      async buildStage() { secondBuildCalls += 1 }
    }), /lock already exists/)
    assert.equal(await fs.readFile(lockPath, 'utf8'), firstOwnerLock)
    assert.equal(secondBuildCalls, 0)

    releaseBuild()
    await first
    assert.equal(await fs.readFile(path.join(outputRoot, 'index.html'), 'utf8'), 'first')
    await assertNoTransactionArtifacts(root, 'dist')
  })
})

test('leaves a replacement lock untouched and does not publish after ownership loss', async () => {
  await withTemporaryDirectory(async (root) => {
    const outputRoot = path.join(root, 'dist')
    const lockPath = path.join(root, '.dist.build.lock')
    await fs.mkdir(outputRoot)
    await fs.writeFile(path.join(outputRoot, 'accepted.js'), 'accepted')
    const before = await snapshotTree(outputRoot)

    await assert.rejects(publishBuildOutput({
      outputRoot,
      async buildStage(stageRoot) {
        await fs.writeFile(path.join(stageRoot, 'candidate.js'), 'candidate')
        await fs.rm(lockPath)
        await fs.writeFile(lockPath, 'replacement-owner:99\n', { mode: 0o600 })
      }
    }), /lost ownership/)

    assert.deepEqual(await snapshotTree(outputRoot), before)
    assert.equal(await fs.readFile(lockPath, 'utf8'), 'replacement-owner:99\n')
    assert.equal((await fs.readdir(root)).some((name) => name.startsWith('.dist.stage-')), false)
  })
})

test('rolls the accepted output back when publishing the stage rename fails', async () => {
  await withTemporaryDirectory(async (root) => {
    const outputRoot = path.join(root, 'dist')
    await fs.mkdir(path.join(outputRoot, 'assets'), { recursive: true })
    await fs.writeFile(path.join(outputRoot, 'index.html'), 'accepted')
    await fs.writeFile(path.join(outputRoot, 'assets', 'main.js'), 'accepted bundle')
    const before = await snapshotTree(outputRoot)
    let stagePath
    const fileSystem = {
      ...fs,
      async rename(from, to) {
        if (from === stagePath && to === outputRoot) throw new Error('injected stage rename failure')
        return fs.rename(from, to)
      }
    }

    await assert.rejects(publishBuildOutput({
      outputRoot,
      fileSystem,
      async buildStage(stageRoot) {
        stagePath = stageRoot
        await fs.writeFile(path.join(stageRoot, 'index.html'), 'candidate')
      }
    }), /previous output restored/)

    assert.deepEqual(await snapshotTree(outputRoot), before)
    await assertNoTransactionArtifacts(root, 'dist')
  })
})

test('retains the accepted backup and reports its path when rollback rename fails', async () => {
  await withTemporaryDirectory(async (root) => {
    const outputRoot = path.join(root, 'dist')
    await fs.mkdir(path.join(outputRoot, 'nested'), { recursive: true })
    await fs.writeFile(path.join(outputRoot, 'index.html'), 'accepted')
    await fs.writeFile(path.join(outputRoot, 'nested', 'bundle.js'), 'accepted bundle')
    const before = await snapshotTree(outputRoot)
    let stagePath
    let backupPath
    const fileSystem = {
      ...fs,
      async rename(from, to) {
        if (from === outputRoot) backupPath = to
        if (from === stagePath && to === outputRoot) throw new Error('injected stage rename failure')
        if (from === backupPath && to === outputRoot) throw new Error('injected rollback rename failure')
        return fs.rename(from, to)
      }
    }

    await assert.rejects(publishBuildOutput({
      outputRoot,
      fileSystem,
      async buildStage(stageRoot) {
        stagePath = stageRoot
        await fs.writeFile(path.join(stageRoot, 'index.html'), 'candidate')
      }
    }), (error) => {
      assert.match(error.message, /publication and rollback failed/)
      assert.ok(backupPath)
      assert.ok(error.message.includes(backupPath))
      return true
    })

    assert.deepEqual(await snapshotTree(backupPath), before)
    await assert.rejects(fs.stat(outputRoot), { code: 'ENOENT' })
    await assert.rejects(fs.stat(stagePath), { code: 'ENOENT' })
    await assert.rejects(fs.stat(path.join(root, '.dist.build.lock')), { code: 'ENOENT' })
  })
})

test('does not overwrite an occupied output path while attempting rollback', async () => {
  await withTemporaryDirectory(async (root) => {
    const outputRoot = path.join(root, 'dist')
    await fs.mkdir(outputRoot)
    await fs.writeFile(path.join(outputRoot, 'accepted.js'), 'accepted')
    const acceptedBefore = await snapshotTree(outputRoot)
    let stagePath
    let backupPath
    const fileSystem = {
      ...fs,
      async rename(from, to) {
        if (from === outputRoot) {
          backupPath = to
          return fs.rename(from, to)
        }
        if (from === stagePath && to === outputRoot) {
          await fs.mkdir(outputRoot)
          await fs.writeFile(path.join(outputRoot, 'foreign.txt'), 'leave untouched')
          throw new Error('injected stage rename failure')
        }
        return fs.rename(from, to)
      }
    }

    await assert.rejects(publishBuildOutput({
      outputRoot,
      fileSystem,
      async buildStage(stageRoot) {
        stagePath = stageRoot
        await fs.writeFile(path.join(stageRoot, 'candidate.js'), 'candidate')
      }
    }), /output path is occupied/)

    assert.deepEqual(await snapshotTree(backupPath), acceptedBefore)
    assert.equal(await fs.readFile(path.join(outputRoot, 'foreign.txt'), 'utf8'), 'leave untouched')
    await assert.rejects(fs.stat(stagePath), { code: 'ENOENT' })
    await assert.rejects(fs.stat(path.join(root, '.dist.build.lock')), { code: 'ENOENT' })
  })
})
test('restores an unexpected directory moved into the backup slot and rejects its candidate', async () => {
  await withTemporaryDirectory(async (root) => {
    const outputRoot = path.join(root, 'dist')
    const displacedAccepted = path.join(root, 'accepted-displaced-by-racer')
    await fs.mkdir(path.join(outputRoot, 'nested'), { recursive: true })
    await fs.writeFile(path.join(outputRoot, 'accepted.js'), 'accepted')
    await fs.writeFile(path.join(outputRoot, 'nested', 'keep.txt'), 'accepted nested')
    const acceptedBefore = await snapshotTree(outputRoot)
    let stagePath
    let injected = false
    const fileSystem = {
      ...fs,
      async chmod(target, mode) {
        await fs.chmod(target, mode)
        if (target === stagePath && !injected) {
          injected = true
          await fs.rename(outputRoot, displacedAccepted)
          await fs.mkdir(outputRoot)
          await fs.writeFile(path.join(outputRoot, 'foreign.txt'), 'foreign directory')
        }
      }
    }

    await assert.rejects(publishBuildOutput({
      outputRoot,
      fileSystem,
      async buildStage(stageRoot) {
        stagePath = stageRoot
        await fs.writeFile(path.join(stageRoot, 'candidate.js'), 'candidate')
      }
    }), /output identity changed at the publication boundary.*restored to the output path/)

    assert.deepEqual(await snapshotTree(displacedAccepted), acceptedBefore)
    assert.equal(await fs.readFile(path.join(outputRoot, 'foreign.txt'), 'utf8'), 'foreign directory')
    await assert.rejects(fs.stat(path.join(outputRoot, 'candidate.js')), { code: 'ENOENT' })
    await assert.rejects(fs.stat(stagePath), { code: 'ENOENT' })
    await assertNoTransactionArtifacts(root, 'dist')
  })
})
test('captures and restores a foreign lock swapped as release begins', async () => {
  await withTemporaryDirectory(async (root) => {
    const outputRoot = path.join(root, 'dist')
    const lockPath = path.join(root, '.dist.build.lock')
    let stagePath
    let injected = false
    const fileSystem = {
      ...fs,
      async rename(from, to) {
        if (from === lockPath && to.includes('.release-claim-') && !injected) {
          injected = true
          await fs.rm(lockPath)
          await fs.writeFile(lockPath, 'foreign-owner:release-race\n', { mode: 0o600 })
        }
        return fs.rename(from, to)
      }
    }

    await assert.rejects(publishBuildOutput({
      outputRoot,
      fileSystem,
      async buildStage(stageRoot) {
        stagePath = stageRoot
        await fs.writeFile(path.join(stageRoot, 'candidate.js'), 'candidate')
      }
    }), /ownership changed; foreign lock was restored/)

    assert.equal(await fs.readFile(lockPath, 'utf8'), 'foreign-owner:release-race\n')
    assert.equal(await fs.readFile(path.join(outputRoot, 'candidate.js'), 'utf8'), 'candidate')
    await assert.rejects(fs.stat(stagePath), { code: 'ENOENT' })
    assert.equal((await fs.readdir(root)).some((name) => name.startsWith('.dist.build.lock.release-claim-')), false)
  })
})

test('retains a captured foreign lock when a newer lock occupies its path', async () => {
  await withTemporaryDirectory(async (root) => {
    const outputRoot = path.join(root, 'dist')
    const lockPath = path.join(root, '.dist.build.lock')
    const capturedText = 'foreign-owner:captured\n'
    const replacementText = 'foreign-owner:newer\n'
    let stagePath
    let claimPath
    let injected = false
    const fileSystem = {
      ...fs,
      async rename(from, to) {
        if (from === lockPath && to.includes('.release-claim-') && !injected) {
          injected = true
          await fs.rm(lockPath)
          await fs.writeFile(lockPath, capturedText, { mode: 0o600 })
          await fs.rename(from, to)
          claimPath = to
          await fs.writeFile(lockPath, replacementText, { mode: 0o600 })
          return
        }
        return fs.rename(from, to)
      }
    }

    await assert.rejects(publishBuildOutput({
      outputRoot,
      fileSystem,
      async buildStage(stageRoot) {
        stagePath = stageRoot
        await fs.writeFile(path.join(stageRoot, 'candidate.js'), 'candidate')
      }
    }), (error) => {
      assert.match(error.message, /foreign build lock retained at release claim path/)
      assert.ok(claimPath)
      assert.ok(error.message.includes(claimPath))
      return true
    })

    assert.equal(await fs.readFile(lockPath, 'utf8'), replacementText)
    assert.equal(await fs.readFile(claimPath, 'utf8'), capturedText)
    assert.equal(await fs.readFile(path.join(outputRoot, 'candidate.js'), 'utf8'), 'candidate')
    await assert.rejects(fs.stat(stagePath), { code: 'ENOENT' })
  })
})
