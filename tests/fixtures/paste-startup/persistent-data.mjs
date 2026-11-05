import { DatabaseSync } from "node:sqlite";

export class PersistentPluginData {
  constructor(path) {
    this.path = path;
    this.open();
  }

  open() {
    this.database = new DatabaseSync(this.path);
    this.database.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);");
    this.database.exec("CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, body TEXT NOT NULL);");
  }

  seed(documents) {
    const insert = this.database.prepare("INSERT INTO documents (id, body, revision) VALUES (?, ?, 1)");
    for (const document of documents) {
      const stored = { ...structuredClone(document), _rev: "1-sqlite-fixture" };
      insert.run(stored._id, JSON.stringify(stored));
    }
  }

  dispatch(method, args) {
    switch (method) {
      case "db.get": return this.get(args[0]);
      case "db.put": return this.put(args[0]);
      case "db.remove": return this.remove(args[0]);
      case "db.allDocs": return this.allDocs(args[0]);
      case "db.bulkDocs": return args[0].map(document => this.put(document));
      case "startup.get": return this.getSetting("auto-start-plugin") ?? [];
      case "startup.set": this.setSetting("auto-start-plugin", args[0]); return null;
      case "dbStorage.getItem": return this.getSetting(args[0]);
      case "dbStorage.setItem": this.setSetting(args[0], args[1]); return null;
      case "dbStorage.removeItem": this.removeSetting(args[0]); return null;
      default: throw new Error(`Fixture PluginData operation is outside this startup slice: ${method}`);
    }
  }

  get(id) {
    if (typeof id !== "string") throw new TypeError("db.get id must be a string");
    const row = this.database.prepare("SELECT body FROM documents WHERE id = ?").get(id);
    return row ? JSON.parse(row.body) : null;
  }

  put(input) {
    if (!input || typeof input !== "object" || typeof input._id !== "string" || !input._id) {
      throw new TypeError("db.put requires a document id");
    }
    const current = this.database.prepare("SELECT revision FROM documents WHERE id = ?").get(input._id);
    if (current && input._rev !== `${current.revision}-sqlite-fixture`) {
      return { error: true, name: "conflict", status: 409, id: input._id };
    }
    const revision = (current?.revision ?? 0) + 1;
    const stored = { ...structuredClone(input), _rev: `${revision}-sqlite-fixture` };
    this.database.prepare("INSERT INTO documents (id, body, revision) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, revision=excluded.revision")
      .run(stored._id, JSON.stringify(stored), revision);
    return { ok: true, id: stored._id, rev: stored._rev };
  }

  remove(input) {
    const id = typeof input === "string" ? input : input?._id;
    if (typeof id !== "string") throw new TypeError("db.remove requires a document id");
    const current = this.get(id);
    if (!current) return { error: true, name: "not_found", status: 404, id };
    if (typeof input === "object" && input?._rev !== current._rev) {
      return { error: true, name: "conflict", status: 409, id };
    }
    this.database.prepare("DELETE FROM documents WHERE id = ?").run(id);
    return { ok: true, id, rev: current._rev };
  }

  allDocs(options = {}) {
    let documents = this.database.prepare("SELECT body FROM documents ORDER BY id").all().map(row => JSON.parse(row.body));
    if (typeof options === "string") documents = documents.filter(document => document._id.startsWith(options));
    else if (Array.isArray(options)) documents = documents.filter(document => options.includes(document._id));
    else if (Array.isArray(options.keys)) documents = documents.filter(document => options.keys.includes(document._id));
    else {
      if (typeof options.startkey === "string") documents = documents.filter(document => document._id >= options.startkey);
      if (typeof options.endkey === "string") documents = documents.filter(document => document._id <= options.endkey);
    }
    return documents;
  }

  getSetting(id) {
    const row = this.database.prepare("SELECT body FROM settings WHERE id = ?").get(String(id));
    return row ? JSON.parse(row.body) : undefined;
  }

  setSetting(id, value) {
    this.database.prepare("INSERT INTO settings (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(String(id), JSON.stringify(value));
  }

  removeSetting(id) {
    this.database.prepare("DELETE FROM settings WHERE id = ?").run(String(id));
  }

  snapshot(id) { return this.get(id); }

  reopen() {
    this.database.close();
    this.open();
  }

  close() { this.database.close(); }
}
