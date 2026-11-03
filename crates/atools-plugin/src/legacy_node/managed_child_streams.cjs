function createManagedChildStreams(child, state, transport, stdioModes) {
  const managedStreams = require('node:stream');
  const maxWriteBytes = 64 * 1024;
  const maxOutputChunkBytes = 16 * 1024;
  const output = Object.create(null);
  const outputState = Object.create(null);
  const pendingWrites = new Map();
  let nextWriteId = 0;
  let creditFlushScheduled = false;
  let inputEnded = false;

  function makeOutput(name, mode) {
    if (mode !== 'pipe') {
      output[name] = null;
      outputState[name] = { mode, remoteEnded: true, localClosed: true, creditPending: 0, blocked: false };
      return;
    }
    const streamState = { mode, remoteEnded: false, localClosed: false, creditPending: 0, blocked: false, readCalls: 0 };
    const stream = new managedStreams.Readable({
      highWaterMark: 16 * 1024,
      read() {
        streamState.readCalls++;
        streamState.blocked = false;
        scheduleCreditFlush();
      },
    });
    output[name] = stream;
    outputState[name] = streamState;
    stream.once('close', () => {
      streamState.localClosed = true;
      state.checkClose();
    });
  }

  makeOutput('stdout', stdioModes[1]);
  makeOutput('stderr', stdioModes[2]);

  const stdin = stdioModes[0] === 'pipe' ? new managedStreams.Writable({
    highWaterMark: 64 * 1024,
    write(chunk, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      sendWriteBytes(bytes, callback);
    },
    final(callback) { sendEnd(callback); },
    destroy(error, callback) {
      if (state.exitSeen || !state.childId || inputEnded) { callback(error); return; }
      sendEnd((endError) => callback(error || endError));
    },
  }) : null;

  function allocateWriteId() {
    nextWriteId++;
    if (!Number.isSafeInteger(nextWriteId) || nextWriteId <= 0) {
      throw createManagedChildError('ERR_ATOOLS_MANAGED_WRITE_ID', 'managed stdin write id budget exhausted');
    }
    return nextWriteId;
  }

  function sendWriteBytes(bytes, callback) {
    if (state.exitSeen || state.closeSeen || !state.childId) {
      callback(createManagedChildError('EPIPE', 'managed child stdin is closed'));
      return;
    }
    if (bytes.length === 0) { callback(); return; }
    let offset = 0;
    let complete = false;
    function finish(error) {
      if (complete) return;
      complete = true;
      callback(error);
    }
    function sendNext() {
      if (state.exitSeen || state.closeSeen) { finish(createManagedChildError('EPIPE', 'managed child exited during stdin write')); return; }
      if (offset >= bytes.length) { finish(); return; }
      const part = bytes.subarray(offset, Math.min(offset + maxWriteBytes, bytes.length));
      let writeId;
      try { writeId = allocateWriteId(); }
      catch (error) { finish(error); return; }
      pendingWrites.set(writeId, (error) => {
        if (error) { finish(error); return; }
        offset += part.length;
        sendNext();
      });
      try {
        const result = transport.request({ op: 'write', childId: state.childId, writeId, data: part.toString('base64') });
        if (!result || result.accepted !== true) {
          pendingWrites.delete(writeId);
          finish(createManagedChildError('ERR_ATOOLS_MANAGED_WRITE_RESPONSE', 'managed child owner did not accept stdin data'));
        }
      } catch (error) {
        pendingWrites.delete(writeId);
        finish(error);
      }
    }
    sendNext();
  }

  function sendEnd(callback) {
    if (inputEnded || state.exitSeen || state.closeSeen || !state.childId) {
      inputEnded = true;
      callback();
      return;
    }
    inputEnded = true;
    let writeId;
    try { writeId = allocateWriteId(); }
    catch (error) { callback(error); return; }
    pendingWrites.set(writeId, (error) => callback(error));
    try {
      const result = transport.request({ op: 'end', childId: state.childId, writeId });
      if (!result || result.accepted !== true) {
        pendingWrites.delete(writeId);
        callback(createManagedChildError('ERR_ATOOLS_MANAGED_END_RESPONSE', 'managed child owner did not accept stdin end'));
      }
    } catch (error) {
      pendingWrites.delete(writeId);
      callback(error);
    }
  }

  function scheduleCreditFlush() {
    if (creditFlushScheduled || state.closeSeen || !state.childId) return;
    creditFlushScheduled = true;
    setImmediate(() => {
      creditFlushScheduled = false;
      if (state.closeSeen || state.protocolError) return;
      for (const name of ['stdout', 'stderr']) {
        const streamState = outputState[name];
        if (streamState.remoteEnded) { streamState.creditPending = 0; continue; }
        if (streamState.mode !== 'pipe' || streamState.blocked || streamState.creditPending === 0) continue;
        const count = Math.min(streamState.creditPending, 32);
        streamState.creditPending -= count;
        try { transport.request({ op: 'credit', childId: state.childId, stream: name, count }); }
        catch (error) { state.fail(error); return; }
      }
    });
  }

  function acceptData(event) {
    const name = event.stream;
    const stream = output[name];
    const streamState = outputState[name];
    if (!stream || !streamState || streamState.remoteEnded || typeof event.data !== 'string') {
      throw createManagedChildError('ERR_ATOOLS_MANAGED_OUTPUT_EVENT', 'managed child output event is invalid');
    }
    if (event.data.length > Math.ceil(maxOutputChunkBytes * 4 / 3) + 4) {
      throw createManagedChildError('ERR_ATOOLS_MANAGED_OUTPUT_CHUNK', 'managed child output chunk exceeds its byte budget');
    }
    const bytes = Buffer.from(event.data, 'base64');
    if (bytes.length === 0 || bytes.length > maxOutputChunkBytes || bytes.toString('base64') !== event.data) {
      throw createManagedChildError('ERR_ATOOLS_MANAGED_OUTPUT_CHUNK', 'managed child output chunk is not canonical bounded base64');
    }
    streamState.creditPending++;
    const readCalls = streamState.readCalls;
    if (!stream.push(bytes) && streamState.readCalls === readCalls) streamState.blocked = true;
    else scheduleCreditFlush();
  }

  function acceptEnd(event) {
    const stream = output[event.stream];
    const streamState = outputState[event.stream];
    if (!stream || !streamState || streamState.remoteEnded) {
      throw createManagedChildError('ERR_ATOOLS_MANAGED_OUTPUT_END', 'managed child output end event is invalid');
    }
    streamState.remoteEnded = true;
    stream.push(null);
    state.checkClose();
  }

  function acceptWriteAck(event) {
    const pending = pendingWrites.get(event.writeId);
    if (!pending) {
      if (state.exitSeen || state.closeSeen) return;
      throw createManagedChildError('ERR_ATOOLS_MANAGED_WRITE_ACK', 'managed child write acknowledgement has no pending write');
    }
    pendingWrites.delete(event.writeId);
    const ackError = event.error === undefined ? null
      : createManagedChildError(event.error.code || 'ERR_ATOOLS_MANAGED_STDIN_WRITE', event.error.message, event.error.errno);
    process.nextTick(() => pending(ackError));
  }

  function primeCredits() {
    for (const name of ['stdout', 'stderr']) {
      if (outputState[name].mode === 'pipe') transport.request({ op: 'credit', childId: state.childId, stream: name, count: 2 });
    }
  }

  function handleEvent(event) {
    switch (event.event) {
      case 'data': return acceptData(event);
      case 'end': return acceptEnd(event);
      case 'writeAck': return acceptWriteAck(event);
      default: throw createManagedChildError('ERR_ATOOLS_MANAGED_CHILD_EVENT', `unsupported managed child stream event ${event.event}`);
    }
  }

  function closeStdinAfterExit(error) {
    for (const [writeId, pending] of pendingWrites) {
      pendingWrites.delete(writeId);
      process.nextTick(() => pending(error || createManagedChildError('EPIPE', 'managed child exited before stdin write acknowledgement')));
    }
    if (stdin && !stdin.destroyed) stdin.destroy();
  }

  function fail(error) {
    closeStdinAfterExit(error);
    for (const name of ['stdout', 'stderr']) {
      if (output[name] && !output[name].destroyed) output[name].destroy();
    }
  }

  function flushUnusedOutputs() {
    process.nextTick(() => {
      for (const name of ['stdout', 'stderr']) if (output[name] && !output[name].destroyed) output[name].resume();
    });
  }

  return {
    stdin,
    stdout: output.stdout,
    stderr: output.stderr,
    stdio: [stdin, output.stdout, output.stderr],
    primeCredits,
    handleEvent,
    fail,
    flushUnusedOutputs,
    closeStdinAfterExit,
    allOutputsClosed() {
      return ['stdout', 'stderr'].every((name) => outputState[name].mode !== 'pipe'
        || (outputState[name].remoteEnded && outputState[name].localClosed));
    },
    allOutputsLocallyClosed() {
      return ['stdout', 'stderr'].every((name) => outputState[name].mode !== 'pipe' || outputState[name].localClosed);
    },
    remoteOutputEnded(name) { return Boolean(outputState[name] && outputState[name].remoteEnded); },
    destroy() {
      closeStdinAfterExit();
      for (const name of ['stdout', 'stderr']) if (output[name] && !output[name].destroyed) output[name].destroy();
    },
  };
}
