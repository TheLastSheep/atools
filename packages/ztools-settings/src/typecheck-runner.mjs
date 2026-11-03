import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function summarizeDiagnostics(stdout, stderr) {
  const text = Buffer.concat([stdout, Buffer.from('\n'), stderr])
    .toString('utf8')
    .replace(/\u001b\[[0-9;]*m/g, '')
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const messages = lines.filter((line) => /\berror TS\d+:/i.test(line))
  return {
    errorCount: messages.length,
    messages,
    outputLineCount: lines.length
  }
}

export function runTypeChecks(stageRoot, dependencies, manifest) {
  const results = []
  for (const [index, check] of manifest.build.typeChecks.entries()) {
    const dependency = dependencies[check.package]
    const bin = typeof dependency?.bin === 'string' ? dependency.bin : dependency?.bin?.[check.binary]
    let stdout = Buffer.from('')
    let stderr = Buffer.from('')
    let status = 127
    let signal = null
    let complete = false
    let launchError = null
    const command = bin ? path.join(dependency.root, bin) : null

    console.log(`[ztools-settings-build] ${check.binary} ${check.args.join(' ')}`)
    if (!command) {
      launchError = `Could not locate ${check.binary} in ${check.package} package metadata`
      stderr = Buffer.from(`${launchError}\n`)
    } else {
      const result = spawnSync(process.execPath, [command, ...check.args], {
        cwd: stageRoot,
        encoding: null,
        maxBuffer: 64 * 1024 * 1024
      })
      stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from('')
      stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from('')
      signal = result.signal ?? null
      launchError = result.error?.message ?? null
      status = Number.isInteger(result.status) ? result.status : (result.error ? 127 : 1)
      complete = !result.error && !signal
      if (result.error) {
        stderr = Buffer.concat([stderr, Buffer.from(`\n[runner error] ${result.error.message}\n`)])
      }
    }

    if (stdout.byteLength > 0) process.stdout.write(stdout)
    if (stderr.byteLength > 0) process.stderr.write(stderr)
    const combinedHash = createHash('sha256')
      .update(stdout)
      .update('\0')
      .update(stderr)
      .digest('hex')
    results.push({
      index,
      binary: check.binary,
      args: check.args,
      exitCode: status,
      signal,
      executed: command !== null && launchError === null,
      complete,
      success: status === 0 && complete,
      stdout,
      stderr,
      stdoutBytes: stdout.byteLength,
      stderrBytes: stderr.byteLength,
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr),
      combinedSha256: combinedHash,
      diagnosticSummary: summarizeDiagnostics(stdout, stderr),
      launchError
    })
  }
  return results
}

export async function writeTypecheckLogs(outputRoot, results) {
  const relativeDirectory = 'typecheck-diagnostics'
  await mkdir(path.join(outputRoot, relativeDirectory), { recursive: true })
  return Promise.all(results.map(async (result) => {
    const prefix = `${String(result.index + 1).padStart(2, '0')}-${result.binary}`
    const stdoutPath = `${relativeDirectory}/${prefix}.stdout.log`
    const stderrPath = `${relativeDirectory}/${prefix}.stderr.log`
    await writeFile(path.join(outputRoot, stdoutPath), result.stdout)
    await writeFile(path.join(outputRoot, stderrPath), result.stderr)
    const {
      stdout,
      stderr,
      ...summary
    } = result
    return { ...summary, logs: { stdout: stdoutPath, stderr: stderrPath } }
  }))
}

export function typeChecksPassed(results) {
  return results.length > 0 && results.every((result) => result.success)
}

export function typecheckCaptureComplete(results) {
  return results.length > 0 && results.every((result) => result.complete)
}
