'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const HELPER_LIFETIME_MS = 2600;
const MAX_CAPTURE_BYTES = 16 * 1024;

const STDIO_HELPER = String.raw`
  const mode = process.argv[1];
  const input = process.argv[2] || '';
  const lifetimeMs = Number(process.argv[3]);
  if (mode === 'ignore') {
    process.stdout.write('stdout:ready\n');
    process.stderr.write('stderr:ready\n');
  } else {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      process.stdout.write('stdout:' + chunk);
      process.stderr.write('stderr:' + chunk);
    });
    process.stdin.on('end', () => setTimeout(() => process.exit(0), 900));
  }
  setTimeout(() => process.exit(0), lifetimeMs);
`;

function spawnAndRecord(file, args, options, markerPath, initial = {}) {
  const child = spawn(file, args, options);
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let spawnError = null;
  let outputOverflow = false;
  const append = (field, chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_CAPTURE_BYTES) {
      outputOverflow = true;
      child.kill('SIGKILL');
      return;
    }
    if (field === 'stdout') stdout += chunk.toString('utf8');
    else stderr += chunk.toString('utf8');
  };
  child.stdout?.on('data', (chunk) => append('stdout', chunk));
  child.stderr?.on('data', (chunk) => append('stderr', chunk));
  child.once('error', (error) => {
    spawnError = {
      code: typeof error.code === 'string' ? error.code : null,
      errno: Number.isInteger(error.errno) ? error.errno : null,
      syscall: typeof error.syscall === 'string' ? error.syscall : null,
      path: typeof error.path === 'string' ? error.path : null,
    };
  });
  child.once('close', (exitCode, signalCode) => {
    const report = {
      ...initial,
      pid: Number.isSafeInteger(child.pid) ? child.pid : null,
      exitCode,
      signalCode,
      stdout,
      stderr,
      spawnError,
      outputOverflow,
    };
    fs.writeFileSync(markerPath, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
  });
  return child;
}

let lastChild = null;

module.exports = {
  runtimeInfo() {
    return [process.versions.node, process.execPath];
  },

  waitForExitBeforeConsumingOutput() {
    const childScript = [
      "process.stdout.write(Buffer.alloc(96 * 1024, 0x61));",
      "setTimeout(() => process.exit(19), 200);",
    ].join('\n');
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', childScript], {
        detached: true,
        env: {},
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let exitSeen = false;
      let exitCode = null;
      let exitSignal = null;
      let outputBytes = 0;
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        exitSeen = true;
        exitCode = code;
        exitSignal = signal;
        child.stdout.on('data', (chunk) => { outputBytes += chunk.length; });
        child.stdout.resume();
      });
      child.once('close', (code, signal) => {
        resolve([
          process.pid,
          Number.isSafeInteger(child.pid) ? child.pid : null,
          exitSeen,
          exitCode,
          exitSignal,
          code,
          signal,
          outputBytes,
        ]);
      });
    });
  },

  spawnStdioProbe(markerPath, mode, input) {
    const stdio = mode === 'ignore'
      ? ['ignore', 'pipe', 'pipe']
      : ['pipe', 'pipe', 'pipe'];
    const child = spawnAndRecord(
      process.execPath,
      ['-e', STDIO_HELPER, mode, input, String(HELPER_LIFETIME_MS)],
      { detached: true, stdio, env: {} },
      markerPath,
    );
    if (mode === 'pipe') child.stdin.end(input);
    return [process.pid, child.pid == null ? null : child.pid];
  },

  spawnQuickExit(markerPath) {
    const child = spawnAndRecord(
      process.execPath,
      ['-e', 'process.exit(23)'],
      { detached: true, stdio: 'ignore', env: {} },
      markerPath,
    );
    return [process.pid, child.pid == null ? null : child.pid];
  },

  spawnMissing(markerPath, file) {
    const child = spawnAndRecord(
      file,
      [],
      { detached: true, stdio: 'ignore', env: {} },
      markerPath,
    );
    return [process.pid, child.pid == null ? null : child.pid];
  },

  spawnLongLived(markerPath) {
    lastChild = spawnAndRecord(
      process.execPath,
      ['-e', `setTimeout(() => process.exit(0), ${HELPER_LIFETIME_MS})`],
      { detached: true, stdio: 'ignore', env: {} },
      markerPath,
    );
    return [process.pid, lastChild.pid == null ? null : lastChild.pid];
  },

  killLastChild() {
    if (!lastChild) throw new Error('ERR_ATOOLS_FIXTURE_CHILD_NOT_STARTED');
    return lastChild.kill('SIGTERM');
  },

  crashRoot() {
    setImmediate(() => process.kill(process.pid, 'SIGKILL'));
    return 'crash-scheduled';
  },
};
