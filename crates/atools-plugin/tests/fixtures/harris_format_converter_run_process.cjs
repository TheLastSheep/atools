'use strict';

const { runProcess } = require('./engine-utils.cjs');

const OUTPUT_HELPER = String.raw`
  const fs = require('node:fs');
  const marker = { pid: process.pid, ppid: process.ppid };
  fs.writeFileSync(process.argv[1], JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
  setTimeout(() => {
    let pending = 2;
    const finish = () => { if (--pending === 0) process.exit(7); };
    process.stdout.write(JSON.stringify(marker) + '\nHARRIS_RUN_PROCESS_STDOUT\n', finish);
    process.stderr.write('HARRIS_RUN_PROCESS_STDERR\n', finish);
  }, 650);
`;

const TIMEOUT_HELPER = String.raw`
  const fs = require('node:fs');
  fs.writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, ppid: process.ppid }), { flag: 'wx', mode: 0o600 });
  setTimeout(() => process.exit(0), 2600);
`;

module.exports = {
  runtimeInfo() {
    return [process.versions.node, process.execPath, process.pid];
  },

  runOutput(binary, markerPath) {
    return runProcess(binary, ['-e', OUTPUT_HELPER, markerPath], {
      env: {},
      allowNonZero: true,
      timeoutMs: 3000,
      maxOutputBytes: 4096,
    });
  },

  runTimeout(binary, markerPath) {
    return runProcess(binary, ['-e', TIMEOUT_HELPER, markerPath], {
      env: {},
      timeoutMs: 1000,
      maxOutputBytes: 4096,
    }).then(
      () => ({ code: 'UNEXPECTED_RESOLUTION', message: 'timed-out child unexpectedly resolved' }),
      error => ({ code: error.code || null, message: String(error.message || error) }),
    );
  },
};
