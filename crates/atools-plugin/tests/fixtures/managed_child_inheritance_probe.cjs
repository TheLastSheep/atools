'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const RESERVED_ENVIRONMENT_KEYS = [
  'ATOOLS_MANAGED_CHILD_CONTROL_SOCKET',
  'ATOOLS_MANAGED_CHILD_EVENT_SOCKET',
  'ATOOLS_MANAGED_CHILD_TOKEN',
  'ATOOLS_MANAGED_CHILD_CONTROL_FD',
  'ATOOLS_MANAGED_CHILD_EVENT_FD',
];
const MODULE_LOAD_RESERVED_ENVIRONMENT_ABSENT = RESERVED_ENVIRONMENT_KEYS.every(
  (key) => !Object.prototype.hasOwnProperty.call(process.env, key),
);
const CHILD_DEADLINE_MS = 2800;
const MAX_CHILD_OUTPUT_BYTES = 16 * 1024;

function listReservedEnvironmentKeysPresent() {
  return RESERVED_ENVIRONMENT_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(process.env, key));
}

function listOpenSocketFds() {
  const entries = fs.readdirSync('/dev/fd');
  const sockets = [];
  for (const entry of entries) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(entry)) continue;
    const fd = Number(entry);
    if (!Number.isSafeInteger(fd) || fd <= 2) continue;
    let stats;
    try { stats = fs.fstatSync(fd, { bigint: true }); }
    catch (error) {
      if (error && error.code === 'EBADF') continue;
      throw new Error('ERR_MANAGED_CHILD_PROBE_FSTAT_FAILED');
    }
    if (!stats.isSocket()) continue;
    sockets.push({ fd, device: String(stats.dev), inode: String(stats.ino) });
  }
  return sockets.sort((left, right) => left.fd - right.fd);
}

const CHILD_REPORT_SCRIPT = String.raw`
  const fs = require('node:fs');
  const sockets = [];
  for (const entry of fs.readdirSync('/dev/fd')) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(entry)) continue;
    const fd = Number(entry);
    if (!Number.isSafeInteger(fd) || fd <= 2) continue;
    try {
      const stats = fs.fstatSync(fd, { bigint: true });
      if (stats.isSocket()) sockets.push({ fd, device: String(stats.dev), inode: String(stats.ino) });
    } catch (error) {
      if (!error || error.code !== 'EBADF') process.exitCode = 2;
    }
  }
  sockets.sort((left, right) => left.fd - right.fd);
  process.stdout.write(JSON.stringify({ pid: process.pid, socketFds: sockets }));
`;

function spawnRawChildReport() {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, ['-e', CHILD_REPORT_SCRIPT], {
        detached: false,
        env: {},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (_) {
      reject(new Error('ERR_MANAGED_CHILD_PROBE_SPAWN_FAILED'));
      return;
    }
    let stdout = '';
    let outputOverflow = false;
    let timedOut = false;
    let settled = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, CHILD_DEADLINE_MS);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.on('data', (chunk) => {
      if (Buffer.byteLength(stdout) + chunk.length > MAX_CHILD_OUTPUT_BYTES) {
        outputOverflow = true;
        try { child.kill('SIGKILL'); } catch (_) {}
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.resume();
    child.once('error', () => finish(new Error('ERR_MANAGED_CHILD_PROBE_SPAWN_FAILED')));
    child.once('close', (exitCode, signalCode) => {
      if (timedOut) return finish(new Error('ERR_MANAGED_CHILD_PROBE_TIMEOUT'));
      if (outputOverflow) return finish(new Error('ERR_MANAGED_CHILD_PROBE_OUTPUT_LIMIT'));
      if (exitCode !== 0 || signalCode !== null) return finish(new Error('ERR_MANAGED_CHILD_PROBE_EXIT'));
      try { finish(null, { ...JSON.parse(stdout), exitCode, signalCode }); }
      catch (_) { finish(new Error('ERR_MANAGED_CHILD_PROBE_INVALID_REPORT')); }
    });
  });
}

module.exports = {
  runtimeInfo() { return [process.versions.node, process.execPath]; },
  moduleLoadReservedEnvironmentAbsent: MODULE_LOAD_RESERVED_ENVIRONMENT_ABSENT,
  observeRawChildInheritance() {
    const parentSocketFds = listOpenSocketFds();
    const parentReservedEnvironmentKeysPresent = listReservedEnvironmentKeysPresent();
    return spawnRawChildReport().then((child) => {
      const childSocketFds = Array.isArray(child.socketFds) ? child.socketFds : [];
      return {
        moduleLoadReservedEnvironmentAbsent: MODULE_LOAD_RESERVED_ENVIRONMENT_ABSENT,
        parentReservedEnvironmentKeysPresent,
        parentSocketFds,
        childSocketFds,
        childExitCode: Number.isInteger(child.exitCode) ? child.exitCode : null,
        childSignalCode: typeof child.signalCode === 'string' ? child.signalCode : null,
        sameFdMatches: childSocketFds.filter((childSocket) => parentSocketFds.some(
          (parentSocket) => parentSocket.fd === childSocket.fd,
        )),
        sameSocketIdentityMatches: childSocketFds.filter((childSocket) => parentSocketFds.some(
          (parentSocket) => parentSocket.device === childSocket.device && parentSocket.inode === childSocket.inode,
        )),
        childPid: Number.isSafeInteger(child.pid) ? child.pid : null,
      };
    });
  },
};
