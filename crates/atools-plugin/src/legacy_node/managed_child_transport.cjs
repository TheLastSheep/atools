function createManagedChildError(code, message, errno) {
  const error = new Error(typeof message === 'string' && message ? message : code);
  error.code = code;
  if (Number.isInteger(errno)) error.errno = errno;
  return error;
}

function markManagedChildTransportFatal(error) {
  error.transportFatal = true;
  return error;
}

function encodeManagedChildFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length < 2 || payload.length > 1024 * 1024) {
    throw createManagedChildError('ERR_ATOOLS_MANAGED_FRAME_LENGTH', 'managed child frame is outside the 1 MiB limit');
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function readManagedChildFrameSync(managedFs, fd) {
  const maxFrameBytes = 1024 * 1024;
  function readExactly(size) {
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      try {
        const read = managedFs.readSync(fd, buffer, offset, size - offset);
        if (read === 0) throw createManagedChildError(
          'ERR_ATOOLS_MANAGED_CONTROL_EOF', 'managed child control owner closed the channel');
        offset += read;
      } catch (error) {
        if (error && error.code === 'EINTR') continue;
        throw markManagedChildTransportFatal(error);
      }
    }
    return buffer;
  }
  const header = readExactly(4);
  const length = header.readUInt32BE(0);
  if (length < 2 || length > maxFrameBytes) throw markManagedChildTransportFatal(createManagedChildError(
    'ERR_ATOOLS_MANAGED_FRAME_LENGTH', 'managed child control frame length is invalid'));
  try { return JSON.parse(readExactly(length).toString('utf8')); }
  catch (error) {
    if (error && error.transportFatal) throw error;
    throw markManagedChildTransportFatal(createManagedChildError(
      'ERR_ATOOLS_MANAGED_FRAME_JSON', 'managed child control response is not valid JSON'));
  }
}

function waitForManagedSocketConnect(socket) {
  return new Promise((resolve, reject) => {
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (error) reject(error);
      else resolve();
    }
    function onConnect() { finish(); }
    function onError(error) { finish(error); }
    function onClose() { finish(createManagedChildError(
      'ERR_ATOOLS_MANAGED_SOCKET_CLOSED', 'managed child socket closed before authentication')); }
    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function writeManagedChildFrame(socket, value) {
  let frame;
  try { frame = encodeManagedChildFrame(value); }
  catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      socket.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    }
    function onError(error) { finish(error); }
    socket.once('error', onError);
    try { socket.write(frame, (error) => finish(error)); }
    catch (error) { finish(error); }
  });
}

function createManagedChildTransport(controlSocketPath, eventSocketPath, token, dependencies) {
  const managedNet = dependencies && dependencies.net ? dependencies.net : require('node:net');
  const managedFs = dependencies && dependencies.fs ? dependencies.fs : require('node:fs');
  if (typeof controlSocketPath !== 'string' || !controlSocketPath.startsWith('/')
    || Buffer.byteLength(controlSocketPath, 'utf8') > 100
    || typeof eventSocketPath !== 'string' || !eventSocketPath.startsWith('/')
    || Buffer.byteLength(eventSocketPath, 'utf8') > 100 || controlSocketPath === eventSocketPath
    || typeof token !== 'string' || token.length < 32 || token.length > 256) {
    return Promise.reject(createManagedChildError(
      'ERR_ATOOLS_MANAGED_SOCKET_CONFIG', 'managed child socket configuration is incomplete or invalid'));
  }
  let controlSocket;
  let eventSocket;
  try {
    controlSocket = managedNet.createConnection({ path: controlSocketPath });
    eventSocket = managedNet.createConnection({ path: eventSocketPath });
    controlSocket.pause();
  } catch (error) {
    controlSocket?.destroy();
    eventSocket?.destroy();
    return Promise.reject(error);
  }
  return Promise.all([waitForManagedSocketConnect(controlSocket), waitForManagedSocketConnect(eventSocket)])
    .then(() => Promise.all([
      writeManagedChildFrame(controlSocket, { schemaVersion: 1, role: 'control', token }),
      writeManagedChildFrame(eventSocket, { schemaVersion: 1, role: 'events', token }),
    ]))
    .then(() => {
      const handle = controlSocket._handle;
      if (!handle || !Number.isInteger(handle.fd) || handle.fd < 0 || typeof handle.setBlocking !== 'function') {
        throw createManagedChildError('ERR_ATOOLS_MANAGED_CONTROL_HANDLE', 'Node control socket does not expose the required blocking handle');
      }
      controlSocket.pause();
      handle.setBlocking(true);
      const ready = readManagedChildFrameSync(managedFs, handle.fd);
      if (!ready || ready.schemaVersion !== 1 || ready.ready !== true) throw markManagedChildTransportFatal(
        createManagedChildError('ERR_ATOOLS_MANAGED_CONTROL_READY', 'managed child owner did not acknowledge transport readiness'));
      return createManagedChildTransportFromSockets(controlSocket, eventSocket, handle.fd, managedFs);
    })
    .catch((error) => {
      controlSocket.destroy();
      eventSocket.destroy();
      throw error;
    });
}

function createManagedChildTransportFromSockets(controlSocket, eventSocket, controlFd, managedFs) {
  const maxFrameBytes = 1024 * 1024;
  const eventListeners = new Set();
  let requestId = 0;
  let input = Buffer.alloc(0);
  let requestActive = false;
  let closed = false;
  let terminalError = null;
  let referenceCount = 0;

  eventSocket.on('data', acceptBytes);
  eventSocket.on('error', (error) => failTransport(createManagedChildError(
    'ERR_ATOOLS_MANAGED_EVENT_CHANNEL', error.message || 'managed child event channel failed')));
  eventSocket.on('close', () => {
    if (!closed) failTransport(createManagedChildError(
      'ERR_ATOOLS_MANAGED_EVENT_CHANNEL_CLOSED', 'managed child event channel closed unexpectedly'));
  });
  controlSocket.on('error', (error) => failTransport(createManagedChildError(
    'ERR_ATOOLS_MANAGED_CONTROL_CHANNEL', error.message || 'managed child control channel failed')));
  controlSocket.on('close', () => {
    if (!closed) failTransport(createManagedChildError(
      'ERR_ATOOLS_MANAGED_CONTROL_CHANNEL_CLOSED', 'managed child control channel closed unexpectedly'));
  });
  eventSocket.unref();
  controlSocket.unref();

  function writeAllSync(buffer) {
    let offset = 0;
    while (offset < buffer.length) {
      try {
        const written = managedFs.writeSync(controlFd, buffer, offset, buffer.length - offset);
        if (written <= 0) throw createManagedChildError(
          'ERR_ATOOLS_MANAGED_CONTROL_WRITE', 'managed child control write made no progress');
        offset += written;
      } catch (error) {
        if (error && error.code === 'EINTR') continue;
        throw markManagedChildTransportFatal(error);
      }
    }
  }

  function request(message) {
    if (closed || terminalError) throw terminalError || createManagedChildError(
      'ERR_ATOOLS_MANAGED_CONTROL_CLOSED', 'managed child control channel is closed');
    if (requestActive) throw createManagedChildError(
      'ERR_ATOOLS_MANAGED_CONTROL_REENTRANT', 'nested managed child control requests are unsupported');
    requestActive = true;
    try {
      requestId++;
      if (!Number.isSafeInteger(requestId) || requestId <= 0) throw createManagedChildError(
        'ERR_ATOOLS_MANAGED_REQUEST_ID', 'managed child request id budget exhausted');
      const bytes = Buffer.from(JSON.stringify({ ...message, id: requestId }), 'utf8');
      if (bytes.length > maxFrameBytes) throw createManagedChildError(
        'ERR_ATOOLS_MANAGED_FRAME_LENGTH', 'managed child control request exceeds the frame budget');
      const frame = Buffer.allocUnsafe(bytes.length + 4);
      frame.writeUInt32BE(bytes.length, 0);
      bytes.copy(frame, 4);
      writeAllSync(frame);
      const response = readManagedChildFrameSync(managedFs, controlFd);
      if (!response || response.id !== requestId || typeof response.ok !== 'boolean') {
        throw markManagedChildTransportFatal(createManagedChildError(
          'ERR_ATOOLS_MANAGED_RESPONSE_ID', 'managed child control response does not match its request'));
      }
      if (!response.ok) {
        const detail = response.error && typeof response.error === 'object' ? response.error : {};
        const code = typeof detail.code === 'string' ? detail.code : 'ERR_ATOOLS_MANAGED_REMOTE';
        const messageText = typeof detail.message === 'string' ? detail.message : 'managed child owner rejected the request';
        throw createManagedChildError(code, messageText, detail.errno);
      }
      return response.result;
    } catch (error) {
      if (error && error.transportFatal === true) failTransport(error);
      throw error;
    } finally {
      requestActive = false;
    }
  }

  function acceptBytes(chunk) {
    if (closed || terminalError) return;
    if (input.length + chunk.length > maxFrameBytes + 4) {
      failTransport(markManagedChildTransportFatal(createManagedChildError(
        'ERR_ATOOLS_MANAGED_EVENT_BUFFER', 'managed child event buffer exceeded its frame budget')));
      return;
    }
    input = input.length ? Buffer.concat([input, chunk]) : Buffer.from(chunk);
    while (input.length >= 4) {
      const length = input.readUInt32BE(0);
      if (length < 2 || length > maxFrameBytes) {
        failTransport(markManagedChildTransportFatal(createManagedChildError(
          'ERR_ATOOLS_MANAGED_FRAME_LENGTH', 'managed child event frame length is invalid')));
        return;
      }
      if (input.length < length + 4) return;
      let event;
      try { event = JSON.parse(input.toString('utf8', 4, length + 4)); }
      catch (_) {
        failTransport(markManagedChildTransportFatal(createManagedChildError(
          'ERR_ATOOLS_MANAGED_FRAME_JSON', 'managed child event is not valid JSON')));
        return;
      }
      input = input.subarray(length + 4);
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        failTransport(markManagedChildTransportFatal(createManagedChildError(
          'ERR_ATOOLS_MANAGED_EVENT_SHAPE', 'managed child event has an invalid shape')));
        return;
      }
      for (const listener of eventListeners) {
        try { listener(event); }
        catch (error) { failTransport(error); return; }
      }
    }
  }

  function failTransport(error) {
    if (terminalError) return;
    terminalError = error;
    for (const listener of eventListeners) {
      try { listener({ event: 'transportError', error }); } catch (_) {}
    }
  }

  function onEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('managed child event listener must be a function');
    eventListeners.add(listener);
    if (terminalError) listener({ event: 'transportError', error: terminalError });
    return () => eventListeners.delete(listener);
  }

  function ref() {
    referenceCount++;
    if (referenceCount === 1 && !closed) {
      eventSocket.ref();
      controlSocket.ref();
    }
  }

  function unref() {
    if (referenceCount > 0) referenceCount--;
    if (referenceCount === 0 && !closed) {
      eventSocket.unref();
      controlSocket.unref();
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    referenceCount = 0;
    eventSocket.destroy();
    controlSocket.destroy();
  }

  return { request, onEvent, ref, unref, close };
}
