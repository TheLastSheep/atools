/** Fixture doubles, installed before the unchanged production Node codec/bootstrap. */
export function bookmarkNodePolicy(config) {
  const Module = require('node:module');
  const fs = require('node:fs');
  const path = require('node:path');
  const { EventEmitter } = require('node:events');
  const load = Module._load;
  const sink = value => fs.appendFileSync(config.sink, JSON.stringify(value) + '\n');
  const applications = new Set(['/Applications/Google Chrome.app', '/Applications/Microsoft Edge.app']);
  function checked(value) {
    const resolved = path.resolve(String(value));
    if (resolved !== config.root && !resolved.startsWith(config.root + path.sep)) throw Error('MAIN_PUSH_FIXTURE_FS_DENIED');
    return resolved;
  }
  const fixtureFs = {
    existsSync(value) { if (applications.has(String(value))) { sink({ type: 'application-existence-double', path: String(value), exists: true }); return true; } return fs.existsSync(checked(value)); },
    readFileSync(value, options) { return fs.readFileSync(checked(value), options); },
  };
  const fixtureProcess = { platform: process.platform, env: { HOME: process.env.HOME, LOCALAPPDATA: process.env.LOCALAPPDATA }, versions: { node: process.versions.node } };
  const fixtureCp = { spawn(command, args, options) {
    if (command !== 'open' || !Array.isArray(args) || args.length !== 3 || args[0] !== '-a' || !applications.has(args[1])
      || !/^https:\/\/fixture\.invalid\//.test(args[2]) || options?.detached !== true) throw Error('MAIN_PUSH_FIXTURE_SPAWN_DENIED');
    sink({ type: 'spawn-sink', command, args, options }); return new EventEmitter();
  } };
  Module._load = function (specifier, parent, isMain) {
    if (specifier === 'fs' || specifier === 'node:fs') return fixtureFs;
    if (specifier === 'child_process' || specifier === 'node:child_process') return fixtureCp;
    if (specifier === 'process' || specifier === 'node:process') return fixtureProcess;
    if (specifier === 'path' || specifier === 'node:path' || specifier === 'buffer' || specifier === 'node:buffer') return Reflect.apply(load, this, [specifier, parent, isMain]);
    // Production bootstrap already loaded module/readline/codec dependencies. Plugin
    // requires can only obtain the fixed surfaces above; no actual shell/network.
    if (parent?.filename === config.preload) throw Error('MAIN_PUSH_FIXTURE_MODULE_DENIED: ' + specifier);
    return Reflect.apply(load, this, [specifier, parent, isMain]);
  };
}

export const bookmarkNodePolicySource = config => `(${bookmarkNodePolicy.toString()})(${JSON.stringify(config)});\n`;
