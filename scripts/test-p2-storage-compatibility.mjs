import fs from 'fs';
import path from 'path';

// Mock browser / iframe environment to test bridge runtime & dbStorage
class MockLocalStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

function createBridgeSandbox(pluginId) {
  const localStorage = new MockLocalStorage();
  const dbStore = new Map(); // simulated SQLite plugin_data for pluginId

  // dbStorage implementation matching PluginPanel.svelte
  const _dbStorageMemory = {};
  function _dbStorageKey(key) {
    return 'atools:dbStorage:' + pluginId + ':' + String(key);
  }
  function _dbStorageSetRaw(key, value) {
    try {
      localStorage.setItem(key, value);
      return;
    } catch (err) {}
    _dbStorageMemory[key] = value;
  }
  function _dbStorageGetRaw(key) {
    try {
      const stored = localStorage.getItem(key);
      if (stored != null) return stored;
    } catch (err) {}
    return Object.prototype.hasOwnProperty.call(_dbStorageMemory, key) ? _dbStorageMemory[key] : null;
  }
  function _dbStorageRemoveRaw(key) {
    try {
      localStorage.removeItem(key);
    } catch (err) {}
    delete _dbStorageMemory[key];
  }
  function _dbStorageEncode(value) {
    return JSON.stringify({ value: value });
  }
  function _dbStorageDecode(value) {
    if (value == null) return null;
    try {
      const parsed = JSON.parse(value);
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'value')) return parsed.value;
      return parsed;
    } catch (err) {
      return value;
    }
  }

  const dbStorage = {
    setItem(key, value) {
      _dbStorageSetRaw(_dbStorageKey(key), _dbStorageEncode(value));
    },
    getItem(key) {
      return _dbStorageDecode(_dbStorageGetRaw(_dbStorageKey(key)));
    },
    removeItem(key) {
      _dbStorageRemoveRaw(_dbStorageKey(key));
    }
  };

  const db = {
    async put(doc) {
      if (!doc || !doc._id) throw new Error('Document must have _id');
      const rev = '1-' + Math.random().toString(36).slice(2, 10);
      const savedDoc = { ...doc, _rev: rev };
      dbStore.set(doc._id, savedDoc);
      return { id: doc._id, ok: true, rev: rev };
    },
    async get(id) {
      return dbStore.get(id) || null;
    },
    async remove(idOrDoc) {
      const id = typeof idOrDoc === 'string' ? idOrDoc : idOrDoc?._id;
      if (!id || !dbStore.has(id)) return { id, ok: false, error: 'not_found' };
      dbStore.delete(id);
      return { id, ok: true };
    },
    async allDocs(opts) {
      const docs = Array.from(dbStore.values());
      if (!opts) return docs;
      if (typeof opts === 'string') {
        return docs.filter(d => d._id.startsWith(opts));
      }
      if (Array.isArray(opts)) {
        return docs.filter(d => opts.includes(d._id));
      }
      return docs;
    },
    async bulkDocs(docs) {
      const results = [];
      for (const d of docs) {
        results.push(await this.put(d));
      }
      return results;
    }
  };

  return { pluginId, dbStorage, db, localStorage };
}

// 1. Test Isolation between multiple plugins
console.log('--- Test 1: Multi-plugin Storage & DB Isolation ---');
const p1 = createBridgeSandbox('plugin-clipboard');
const p2 = createBridgeSandbox('plugin-calculator');

p1.dbStorage.setItem('theme', 'dark');
p1.dbStorage.setItem('config', { autoCopy: true, maxHistory: 100 });

p2.dbStorage.setItem('theme', 'light');
p2.dbStorage.setItem('precision', 4);

if (p1.dbStorage.getItem('theme') !== 'dark' || p2.dbStorage.getItem('theme') !== 'light') {
  throw new Error('dbStorage isolation failed for simple values');
}
if (p1.dbStorage.getItem('precision') !== null || p2.dbStorage.getItem('config') !== null) {
  throw new Error('dbStorage key namespace leak detected');
}
console.log('✓ dbStorage namespace isolation test passed');

// 2. Test Document DB CRUD & Bulk
console.log('\n--- Test 2: DB CRUD & Bulk Operations ---');
async function testDbOperations() {
  const sandbox = createBridgeSandbox('plugin-test-notes');
  
  // Put doc
  const putRes = await sandbox.db.put({ _id: 'note/1', title: 'Hello World', tags: ['work', 'note'] });
  if (!putRes.ok || !putRes.rev) throw new Error('DB Put failed');

  // Get doc
  const note = await sandbox.db.get('note/1');
  if (!note || note.title !== 'Hello World' || note.tags.length !== 2) throw new Error('DB Get mismatch');

  // Bulk put
  const bulkDocs = [
    { _id: 'note/2', title: 'Second Note' },
    { _id: 'note/3', title: 'Third Note' },
    { _id: 'todo/1', title: 'Task One' }
  ];
  await sandbox.db.bulkDocs(bulkDocs);

  // allDocs prefix filter
  const noteDocs = await sandbox.db.allDocs('note/');
  if (noteDocs.length !== 3) throw new Error(`allDocs prefix filter expected 3, got ${noteDocs.length}`);

  const specificDocs = await sandbox.db.allDocs(['note/1', 'todo/1']);
  if (specificDocs.length !== 2) throw new Error(`allDocs array filter expected 2, got ${specificDocs.length}`);

  // Remove
  await sandbox.db.remove('note/1');
  const removed = await sandbox.db.get('note/1');
  if (removed !== null) throw new Error('DB Remove failed');

  console.log('✓ Document DB CRUD, Bulk & Key Filtering passed');
}

await testDbOperations();

// 3. Test High-Frequency Storage Operations (Stress Test)
console.log('\n--- Test 3: High-Frequency dbStorage & DB Performance Stress Test ---');
const stressSandbox = createBridgeSandbox('plugin-stress-test');
const start = performance.now();
const ITERATIONS = 10000;

for (let i = 0; i < ITERATIONS; i++) {
  stressSandbox.dbStorage.setItem(`key_${i % 100}`, { index: i, timestamp: Date.now(), text: `Sample data ${i}` });
  const val = stressSandbox.dbStorage.getItem(`key_${i % 100}`);
  if (val.index !== i) throw new Error(`Data mismatch at iteration ${i}`);
}
const elapsed = performance.now() - start;
console.log(`✓ Completed ${ITERATIONS} setItem/getItem cycles in ${elapsed.toFixed(2)}ms (${(ITERATIONS / (elapsed / 1000)).toFixed(0)} ops/sec)`);

console.log('\n========================================');
console.log('All P2 Storage & DB Compatibility Tests Passed!');
console.log('========================================');
