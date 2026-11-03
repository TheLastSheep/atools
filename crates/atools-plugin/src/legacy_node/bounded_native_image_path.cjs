'use strict';

// This reader transports bounded source bytes only. The Rust image engine owns
// format decoding, dimensions, and pixel-allocation limits.
const imagePathFs = require('node:fs');
const imagePathModule = require('node:path');
const lstatSync = imagePathFs.lstatSync.bind(imagePathFs);
const fstatSync = imagePathFs.fstatSync.bind(imagePathFs);
const openSync = imagePathFs.openSync.bind(imagePathFs);
const readSync = imagePathFs.readSync.bind(imagePathFs);
const closeSync = imagePathFs.closeSync.bind(imagePathFs);
const isAbsolute = imagePathModule.isAbsolute.bind(imagePathModule);
const isRegularFile = imagePathFs.Stats.prototype.isFile;
const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = imagePathFs.constants;
const nativeBufferFrom = Buffer.from.bind(Buffer);
const nativeBufferByteLength = Buffer.byteLength.bind(Buffer);
const nativeBufferToString = Buffer.prototype.toString;
const MAX_NATIVE_IMAGE_SOURCE_BYTES = 4 * 1024 * 1024;

function failNativeImagePath(code) {
  const messages = {
    ERR_ATOOLS_IMAGE_PATH_INVALID: 'Invalid local image path',
    ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE: 'Image source is unavailable',
    ERR_ATOOLS_IMAGE_PATH_UNSUPPORTED: 'Bounded image path reads are unavailable on this platform',
    ERR_ATOOLS_IMAGE_PATH_LIMIT: 'Image source exceeds the supported limit',
    ERR_ATOOLS_IMAGE_PATH_CHANGED: 'Image source changed during the read',
    ERR_ATOOLS_IMAGE_PATH_CLOSE: 'Could not close the image source handle',
  };
  const error = new Error(messages[code] || 'Image source read failed');
  error.code = code;
  throw error;
}

function readBoundedNativeImagePath(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)
      || Object.keys(params).length !== 2 || typeof params.path !== 'string'
      || !Number.isSafeInteger(params.maxBytes) || params.maxBytes < 1
      || params.maxBytes > MAX_NATIVE_IMAGE_SOURCE_BYTES) {
    failNativeImagePath('ERR_ATOOLS_IMAGE_PATH_INVALID');
  }
  const filePath = params.path;
  const maxBytes = BigInt(params.maxBytes);
  if (!filePath || filePath.includes('\0') || nativeBufferByteLength(filePath, 'utf8') > 8192
      || !isAbsolute(filePath)) {
    failNativeImagePath('ERR_ATOOLS_IMAGE_PATH_INVALID');
  }

  let before;
  try { before = lstatSync(filePath, { bigint: true }); }
  catch (_) { failNativeImagePath('ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE'); }
  if (!Reflect.apply(isRegularFile, before, [])) failNativeImagePath('ERR_ATOOLS_IMAGE_PATH_INVALID');
  if (before.size < 1n || before.size > maxBytes) {
    failNativeImagePath('ERR_ATOOLS_IMAGE_PATH_LIMIT');
  }

  if (![O_RDONLY, O_NONBLOCK, O_NOFOLLOW].every(Number.isInteger)) {
    failNativeImagePath('ERR_ATOOLS_IMAGE_PATH_UNSUPPORTED');
  }

  let descriptor;
  try {
    try { descriptor = openSync(filePath, O_RDONLY | O_NONBLOCK | O_NOFOLLOW); }
    catch (_) { failNativeImagePath('ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE'); }

    let opened;
    try { opened = fstatSync(descriptor, { bigint: true }); }
    catch (_) { failNativeImagePath('ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE'); }
    if (!Reflect.apply(isRegularFile, opened, [])) failNativeImagePath('ERR_ATOOLS_IMAGE_PATH_INVALID');
    if (opened.size < 1n || opened.size > maxBytes) {
      failNativeImagePath('ERR_ATOOLS_IMAGE_PATH_LIMIT');
    }
    if (!sameFileIdentity(before, opened)) failNativeImagePath('ERR_ATOOLS_IMAGE_PATH_CHANGED');

    const buffer = nativeBufferFrom(new Uint8Array(Number(opened.size) + 1));
    let offset = 0;
    while (offset < buffer.length) {
      let count;
      try { count = readSync(descriptor, buffer, offset, buffer.length - offset, offset); }
      catch (_) { failNativeImagePath('ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE'); }
      if (count === 0) break;
      offset += count;
    }
    let after;
    try { after = fstatSync(descriptor, { bigint: true }); }
    catch (_) { failNativeImagePath('ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE'); }
    if (BigInt(offset) !== opened.size || !sameFileIdentity(opened, after)) {
      failNativeImagePath('ERR_ATOOLS_IMAGE_PATH_CHANGED');
    }
    // The extra read slot detects file growth without allocating from a later size.
    return new Uint8Array(buffer.subarray(0, offset));
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); }
      catch (_) { failNativeImagePath('ERR_ATOOLS_IMAGE_PATH_CLOSE'); }
    }
  }
}

function sameFileIdentity(left, right) {
  return Reflect.apply(isRegularFile, right, []) && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function nativeImageBytesToBase64(bytes) {
  const buffer = nativeBufferFrom(bytes);
  return Reflect.apply(nativeBufferToString, buffer, ['base64']);
}
