import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  link,
  readFile,
  rename,
  rmdir,
  rm,
  chmod
} from 'node:fs/promises'
import path from 'node:path'

const nativeFileSystem = Object.freeze({ lstat, mkdir, open, link, readFile, rename, rmdir, rm, chmod })
const MAX_NAME_ATTEMPTS = 8

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isNotFound(error) {
  return error?.code === 'ENOENT'
}

function sameIdentity(left, right) {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino
}

async function optionalLstat(fileSystem, target) {
  try {
    return await fileSystem.lstat(target)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

async function inspectOutput(fileSystem, outputRoot) {
  const metadata = await optionalLstat(fileSystem, outputRoot)
  if (metadata === null) return null
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Renderer output target must be an ordinary directory: ${outputRoot}`)
  }
  return metadata
}

async function createSiblingPath(fileSystem, parent, outputName, role) {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = path.join(parent, `.${outputName}.${role}-${process.pid}-${randomUUID()}`)
    if (await optionalLstat(fileSystem, candidate) === null) return candidate
  }
  throw new Error(`Could not allocate a unique renderer ${role} path beside the output`)
}

async function createStage(fileSystem, parent, outputName) {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = await createSiblingPath(fileSystem, parent, outputName, 'stage')
    try {
      await fileSystem.mkdir(candidate, { mode: 0o700 })
      const metadata = await fileSystem.lstat(candidate)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Renderer build stage is not an ordinary directory; path retained: ${candidate}`)
      }
      return { path: candidate, identity: { dev: metadata.dev, ino: metadata.ino } }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new Error('Could not create a private renderer build stage')
}

async function acquireLock(fileSystem, lockPath) {
  let handle
  try {
    handle = await fileSystem.open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Renderer build lock already exists; inspect it for an active or stale build: ${lockPath}`)
    }
    throw new Error(`Could not acquire renderer build lock: ${errorMessage(error)}`, { cause: error })
  }

  const token = `${JSON.stringify({ pid: process.pid, nonce: randomUUID() })}\n`
  let identity = null
  try {
    const metadata = await handle.stat()
    identity = { dev: metadata.dev, ino: metadata.ino }
    await handle.writeFile(token, 'utf8')
    await handle.close()
    handle = null
    return { lockPath, token, identity }
  } catch (error) {
    if (handle) {
      try { await handle.close() } catch {}
    }
    if (identity) await removeCreatedLock(fileSystem, lockPath, identity)
    throw new Error(`Could not write renderer build lock; inspect it before retrying: ${lockPath}`, { cause: error })
  }
}

async function removeCreatedLock(fileSystem, lockPath, identity) {
  const metadata = await optionalLstat(fileSystem, lockPath)
  if (sameIdentity(identity, metadata)) await fileSystem.rm(lockPath, { force: true })
}

async function ownsLock(fileSystem, lock) {
  const metadata = await optionalLstat(fileSystem, lock.lockPath)
  if (!sameIdentity(lock.identity, metadata)) return false
  try {
    return (await fileSystem.readFile(lock.lockPath, 'utf8')) === lock.token
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

async function createReleaseClaim(fileSystem, parent, lockPath) {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const directoryPath = path.join(
      parent,
      `${path.basename(lockPath)}.release-claim-${process.pid}-${randomUUID()}`
    )
    try {
      await fileSystem.mkdir(directoryPath, { mode: 0o700 })
      const metadata = await fileSystem.lstat(directoryPath)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Renderer lock release claim is not an ordinary directory: ${directoryPath}`)
      }
      return {
        directoryPath,
        filePath: path.join(directoryPath, 'captured-lock'),
        identity: { dev: metadata.dev, ino: metadata.ino }
      }
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('Could not allocate a private renderer lock release claim')
}

async function cleanupReleaseClaimDirectory(fileSystem, claim) {
  const metadata = await optionalLstat(fileSystem, claim.directoryPath)
  if (metadata === null) return
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || !sameIdentity(claim.identity, metadata)
  ) {
    throw new Error(`Renderer lock release claim ownership changed; path retained: ${claim.directoryPath}`)
  }
  await fileSystem.rmdir(claim.directoryPath)
}

async function restoreClaimedForeignLock(fileSystem, lock, claim) {
  const claimedMetadata = await optionalLstat(fileSystem, claim.filePath)
  if (claimedMetadata === null) {
    await cleanupReleaseClaimDirectory(fileSystem, claim)
    throw new Error('build lock disappeared while being released; no lock file was removed')
  }

  if (claimedMetadata.isSymbolicLink() || !claimedMetadata.isFile()) {
    throw new Error(`foreign build lock retained at release claim path ${claim.filePath}`)
  }

  try {
    // link() creates the destination atomically only when it is absent; unlike rename(),
    // it cannot overwrite a lock another builder installed during this recovery window.
    await fileSystem.link(claim.filePath, lock.lockPath)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`foreign build lock retained at release claim path ${claim.filePath}; lock path is occupied`)
    }
    throw new Error(`foreign build lock retained at release claim path ${claim.filePath}: ${errorMessage(error)}`)
  }

  const restored = await optionalLstat(fileSystem, lock.lockPath)
  const retained = await optionalLstat(fileSystem, claim.filePath)
  if (!sameIdentity(claimedMetadata, restored) || !sameIdentity(claimedMetadata, retained)) {
    throw new Error(`foreign build lock retained at release claim path ${claim.filePath}; recovery identity changed`)
  }
  await fileSystem.rm(claim.filePath)
  await cleanupReleaseClaimDirectory(fileSystem, claim)
  throw new Error('build lock ownership changed; foreign lock was restored without replacing another lock')
}

async function releaseLock(fileSystem, lock) {
  const claim = await createReleaseClaim(fileSystem, path.dirname(lock.lockPath), lock.lockPath)
  try {
    await fileSystem.rename(lock.lockPath, claim.filePath)
  } catch (error) {
    try {
      await cleanupReleaseClaimDirectory(fileSystem, claim)
    } catch (cleanupError) {
      throw new Error(`${errorMessage(error)}; release claim retained: ${errorMessage(cleanupError)}`, { cause: error })
    }
    if (isNotFound(error)) return false
    throw error
  }

  const claimedMetadata = await optionalLstat(fileSystem, claim.filePath)
  let token = null
  if (claimedMetadata && !claimedMetadata.isSymbolicLink() && claimedMetadata.isFile()) {
    try {
      token = await fileSystem.readFile(claim.filePath, 'utf8')
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
  const confirmedMetadata = await optionalLstat(fileSystem, claim.filePath)
  if (
    !sameIdentity(lock.identity, claimedMetadata)
    || !sameIdentity(lock.identity, confirmedMetadata)
    || token !== lock.token
  ) {
    await restoreClaimedForeignLock(fileSystem, lock, claim)
  }

  await fileSystem.rm(claim.filePath)
  await cleanupReleaseClaimDirectory(fileSystem, claim)
  return true
}

async function restoreUnexpectedBackup(fileSystem, backupPath, outputRoot) {
  try {
    const backupMetadata = await optionalLstat(fileSystem, backupPath)
    if (backupMetadata === null) return `the backup path disappeared: ${backupPath}`
    if ((await optionalLstat(fileSystem, outputRoot)) !== null) {
      return `the moved directory is retained at ${backupPath}; output path is occupied`
    }
    await fileSystem.rename(backupPath, outputRoot)
    return 'the moved directory was restored to the output path'
  } catch (error) {
    return `the moved directory is retained at ${backupPath}: ${errorMessage(error)}`
  }
}

async function inspectOwnedStage(fileSystem, stage) {
  const metadata = await optionalLstat(fileSystem, stage.path)
  if (
    metadata === null
    || metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || !sameIdentity(stage.identity, metadata)
  ) {
    throw new Error(`Renderer build stage ownership changed; refusing to use or remove it: ${stage.path}`)
  }
  return metadata
}

async function cleanupStage(fileSystem, stage) {
  if (stage === null) return
  const metadata = await optionalLstat(fileSystem, stage.path)
  if (metadata === null) return
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || !sameIdentity(stage.identity, metadata)
  ) {
    throw new Error(`Renderer build stage ownership changed; replacement retained at ${stage.path}`)
  }
  await fileSystem.rm(stage.path, { recursive: true, force: true })
}

function sameOutput(left, right) {
  if (left === null || right === null) return left === right
  return sameIdentity(left, right)
}

/**
 * Build and validate an isolated sibling stage, then publish it as one output transaction.
 * The callback may write only below stageRoot. The optional fileSystem adapter exists for
 * private transaction tests; callers should use the default filesystem. The build lock is
 * cooperative and does not defend against arbitrary hostile writes by the same user.
 */
export async function publishBuildOutput({ outputRoot, buildStage, fileSystem = nativeFileSystem }) {
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) {
    throw new TypeError('Renderer outputRoot must be an absolute path')
  }
  if (typeof buildStage !== 'function') throw new TypeError('Renderer buildStage callback is required')

  const resolvedOutputRoot = path.resolve(outputRoot)
  const parent = path.dirname(resolvedOutputRoot)
  const outputName = path.basename(resolvedOutputRoot)
  if (!outputName || resolvedOutputRoot === parent) throw new Error('Renderer output target cannot be a filesystem root')
  const parentMetadata = await fileSystem.lstat(parent)
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error(`Renderer output parent must be an ordinary directory: ${parent}`)
  }

  const lockPath = path.join(parent, `.${outputName}.build.lock`)
  const lock = await acquireLock(fileSystem, lockPath)
  let stage = null
  let failure = null
  let lockReleaseFailure = null

  try {
    const acceptedOutput = await inspectOutput(fileSystem, resolvedOutputRoot)
    stage = await createStage(fileSystem, parent, outputName)
    await buildStage(stage.path)

    await inspectOwnedStage(fileSystem, stage)
    if (!(await ownsLock(fileSystem, lock))) {
      throw new Error(`Renderer build lost ownership of its output lock; output was not published: ${lockPath}`)
    }
    const currentOutput = await inspectOutput(fileSystem, resolvedOutputRoot)
    if (!sameOutput(acceptedOutput, currentOutput)) {
      throw new Error(`Renderer output changed while building; refusing to replace it: ${resolvedOutputRoot}`)
    }

    const finalMode = acceptedOutput ? acceptedOutput.mode & 0o777 : 0o755
    await fileSystem.chmod(stage.path, finalMode)
    if (acceptedOutput === null) {
      const appeared = await inspectOutput(fileSystem, resolvedOutputRoot)
      if (appeared !== null) throw new Error(`Renderer output appeared while building; refusing to replace it: ${resolvedOutputRoot}`)
      await fileSystem.rename(stage.path, resolvedOutputRoot)
      stage = null
    } else {
      const backupPath = await createSiblingPath(fileSystem, parent, outputName, 'backup')
      await fileSystem.rename(resolvedOutputRoot, backupPath)
      let movedOutput = null
      let backupInspectionFailure = null
      try {
        movedOutput = await optionalLstat(fileSystem, backupPath)
      } catch (error) {
        backupInspectionFailure = error
      }
      if (backupInspectionFailure || !sameIdentity(acceptedOutput, movedOutput)) {
        const recovery = await restoreUnexpectedBackup(fileSystem, backupPath, resolvedOutputRoot)
        const reason = backupInspectionFailure
          ? `could not verify the moved output identity: ${errorMessage(backupInspectionFailure)}`
          : 'output identity changed at the publication boundary'
        throw new Error(`Renderer ${reason}; refusing to publish; ${recovery}`)
      }
      try {
        const appeared = await inspectOutput(fileSystem, resolvedOutputRoot)
        if (appeared !== null) throw new Error(`Renderer output appeared during publication: ${resolvedOutputRoot}`)
        await fileSystem.rename(stage.path, resolvedOutputRoot)
        stage = null
      } catch (publishError) {
        try {
          if ((await optionalLstat(fileSystem, resolvedOutputRoot)) !== null) {
            throw new Error('output path is occupied; refusing to overwrite it during rollback')
          }
          await fileSystem.rename(backupPath, resolvedOutputRoot)
        } catch (rollbackError) {
          throw new Error(
            `Renderer publication and rollback failed; the accepted output is retained at ${backupPath}: ${errorMessage(rollbackError)}`,
            { cause: publishError }
          )
        }
        throw new Error(`Renderer publication failed; previous output restored: ${errorMessage(publishError)}`, {
          cause: publishError
        })
      }

      try {
        await fileSystem.rm(backupPath, { recursive: true, force: true })
      } catch (error) {
        process.emitWarning(
          `Renderer output was published; previous output backup could not be removed at ${backupPath}: ${errorMessage(error)}`
        )
      }
    }
  } catch (error) {
    failure = error
  }

  try {
    await cleanupStage(fileSystem, stage)
  } catch (error) {
    const message = `Could not remove renderer build stage${stage ? ` ${stage.path}` : ''}: ${errorMessage(error)}`
    failure = failure
      ? new Error(`${errorMessage(failure)}; ${message}`, { cause: failure })
      : new Error(message, { cause: error })
  }

  try {
    if (!(await releaseLock(fileSystem, lock))) {
      throw new Error('build lock ownership changed; leaving the current lock untouched')
    }
  } catch (error) {
    lockReleaseFailure = error
  }

  if (failure) {
    if (lockReleaseFailure) {
      throw new Error(`${errorMessage(failure)}; could not release owned build lock ${lockPath}: ${errorMessage(lockReleaseFailure)}`, {
        cause: failure
      })
    }
    throw failure
  }
  if (lockReleaseFailure) {
    throw new Error(`Renderer output was published but owned build lock could not be released at ${lockPath}: ${errorMessage(lockReleaseFailure)}`, {
      cause: lockReleaseFailure
    })
  }
  return resolvedOutputRoot
}
