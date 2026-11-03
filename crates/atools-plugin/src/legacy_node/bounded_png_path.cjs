/** Read one bounded local PNG for the Electron NativeImage compatibility adapter. */
function readBoundedPngPath(params) {
  const fs = require('node:fs');
  const path = require('node:path');
  const maxBytes = 512 * 1024;

  function fail(code) {
    const messages = {
      ERR_ATOOLS_IMAGE_PATH_INVALID: 'Invalid local PNG path',
      ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE: 'PNG file is unavailable',
      ERR_ATOOLS_IMAGE_PATH_UNSUPPORTED: 'Bounded PNG path reads are unavailable on this platform',
      ERR_ATOOLS_IMAGE_PATH_LIMIT: 'PNG file exceeds the supported limit',
      ERR_ATOOLS_IMAGE_PATH_CHANGED: 'PNG file changed during the read',
      ERR_ATOOLS_IMAGE_PATH_NOT_PNG: 'File is not a PNG image',
      ERR_ATOOLS_IMAGE_PATH_CLOSE: 'Could not close the PNG file handle',
    };
    const error = new Error(messages[code] || 'PNG file read failed');
    error.code = code;
    throw error;
  }

  if (!params || typeof params !== 'object' || Array.isArray(params)
      || Object.keys(params).length !== 1 || typeof params.path !== 'string') {
    fail('ERR_ATOOLS_IMAGE_PATH_INVALID');
  }
  const filePath = params.path;
  if (!filePath || filePath.includes('\0') || Buffer.byteLength(filePath, 'utf8') > 8192
      || !path.isAbsolute(filePath)) {
    fail('ERR_ATOOLS_IMAGE_PATH_INVALID');
  }

  let before;
  try { before = fs.lstatSync(filePath, { bigint: true }); }
  catch (_) { fail('ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE'); }
  if (!before.isFile()) fail('ERR_ATOOLS_IMAGE_PATH_INVALID');
  if (before.size < 33n || before.size > BigInt(maxBytes)) fail('ERR_ATOOLS_IMAGE_PATH_LIMIT');

  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
  if (![O_RDONLY, O_NONBLOCK, O_NOFOLLOW].every(Number.isInteger)) {
    fail('ERR_ATOOLS_IMAGE_PATH_UNSUPPORTED');
  }

  let descriptor;
  try {
    try {
      descriptor = fs.openSync(filePath, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
    } catch (_) { fail('ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE'); }

    let opened;
    try { opened = fs.fstatSync(descriptor, { bigint: true }); }
    catch (_) { fail('ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE'); }
    if (!opened.isFile()) fail('ERR_ATOOLS_IMAGE_PATH_INVALID');
    if (opened.size < 33n || opened.size > BigInt(maxBytes)) fail('ERR_ATOOLS_IMAGE_PATH_LIMIT');
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
        || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) {
      fail('ERR_ATOOLS_IMAGE_PATH_CHANGED');
    }

    // One extra byte detects growth without allocating in proportion to a later file size.
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      let count;
      try { count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset); }
      catch (_) { fail('ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE'); }
      if (count === 0) break;
      offset += count;
    }
    let after;
    try { after = fs.fstatSync(descriptor, { bigint: true }); }
    catch (_) { fail('ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE'); }
    if (BigInt(offset) !== opened.size || after.size !== opened.size
        || after.dev !== opened.dev || after.ino !== opened.ino
        || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
      fail('ERR_ATOOLS_IMAGE_PATH_CHANGED');
    }

    const bytes = buffer.subarray(0, offset);
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!signature.every((value, index) => bytes[index] === value)
        || bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13
        || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
      fail('ERR_ATOOLS_IMAGE_PATH_NOT_PNG');
    }
    // The JSON-RPC codec snapshots typed arrays into bounded binary frames.
    return new Uint8Array(bytes);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); }
      catch (_) { fail('ERR_ATOOLS_IMAGE_PATH_CLOSE'); }
    }
  }
}
