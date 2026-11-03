/** Test doubles for the isolated browser worker bridge's host browser APIs. */
export function createPluginWorkerFixture() {
  const createdWorkers = [];
  const createdBlobs = [];
  const revokedWorkerUrls = [];
  let failWorkerConstruction = false;

  class NativeWorkerStub {
    constructor(url, options) {
      if (failWorkerConstruction) throw new Error("worker construction failed");
      this.url = url;
      this.options = options;
      this.listeners = new Map();
      this.terminated = false;
      createdWorkers.push(this);
    }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    terminate() { this.terminated = true; }
    dispatch(type) { for (const listener of this.listeners.get(type) || []) listener({ type }); }
  }

  class WorkerBlobStub {
    constructor(parts, options) {
      this.parts = parts;
      this.options = options;
      createdBlobs.push(this);
    }
  }

  class WorkerUrlStub extends URL {
    static createObjectURL(blob) { return `blob:worker-fixture-${createdBlobs.indexOf(blob)}`; }
    static revokeObjectURL(url) { revokedWorkerUrls.push(url); }
  }

  return {
    NativeWorkerStub,
    WorkerBlobStub,
    WorkerUrlStub,
    createdWorkers,
    createdBlobs,
    revokedWorkerUrls,
    failWorkerConstruction(value) { failWorkerConstruction = value; },
  };
}

export function createServiceWorkerContainerFixture() {
  let setterReceiver = null;
  const nativeServiceWorker = {
    register() { throw new Error("native registration should be replaced by explicit unsupported result"); },
    getRegistrations() { return Promise.resolve(["native-registration-query"]); },
    set oncontrollerchange(listener) {
      setterReceiver = this;
      this._oncontrollerchange = listener;
    },
    get oncontrollerchange() { return this._oncontrollerchange; },
  };
  return { nativeServiceWorker, get setterReceiver() { return setterReceiver; } };
}
