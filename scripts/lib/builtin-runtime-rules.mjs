export const SOURCE_BINDING = Object.freeze({
  baselineFreeze: { sourceId: 'source-freeze-v32.json', sha256: '9fcd48694044e1dc9d39432f1cc358e644eb20b5a29582afabc3226c6ce5d27a', selectedSourceCount: 1814, compilerClosure: false },
  audit: { sourceId: 'review-v1.json', sha256: '598410dbb6a7cdd526ae63bc7d7317c09f18a0790e6bf9ccbb52c7900f7eb2a6', referencedFreeze: { sourceId: 'source-freeze-v27.json', sha256: '3fe9490080a88c9be6d7f6ac4661e7f7e59834de0466b4dc26e583ba15e88a44', selectedSourceCount: 1811 } },
  resourceTree: { root: 'resources/plugins/builtin', files: 4250, directories: 571, bytes: 55353304, sha256: 'a4c04affdc5406832571fe54691a866b4fd35b1d0f0885ff1c31295720767df2', manifestSourceId: 'source-resource-manifest-v1.json', manifestSha256: '380674ffd01cda67baffaf34543e9a526500cab410e8e2608870511db317bcef' },
  resolverEvidence: [
    { path: 'crates/atools-plugin/src/legacy_node/bootstrap.cjs', bytes: 7044, sha256: '6da3c8149f0c76698e8bdcdd0d49198ec729be8d81a1052d0957acabe964c9bc', finding: 'Module.createRequire(ATOOLS_PRELOAD_ENTRY)' },
    { path: 'crates/atools-plugin/src/legacy_node/mod.rs', bytes: 11004, sha256: '69c8c78df844ffc1e94340ba86a973d6a1750ba9381e264c28f4c2da1cdad394', finding: 'selected entry canonicalized inside plugin package root' },
    { path: 'crates/atools-plugin/src/sidecar/launch.rs', bytes: 5033, sha256: '69f427762dd13837059a0b019c2138f9fec3dbeed265ac273501c1c8d7cb1bfa', finding: 'launches sidecar with ATOOLS_PRELOAD_ENTRY set to selected entry' },
    { path: 'src-tauri/src/legacy_runtime/node_entry.rs', bytes: 10744, sha256: '35add1341e11208327d987678fdff846304412839651ef1ebeec9e42da48aa64', finding: 'Node entry chosen from plugin manifest preload/main inside package' }
  ],
  separateRuntimeEvidence: [
    { path: 'format-converter/preload/runtime-loader.cjs', bytes: 2343, sha256: '79bc15d879df36cf5c68855232e7686c9be9b4bbbb063b665b5109092f1bed87', finding: 'createRequire(anchor) uses separately configured runtimeRoot' },
    { path: 'format-converter/preload/runtime-manifest.json', bytes: 62336, sha256: '74854b02cd793c4e29f49080ee402cae71acd0f08e88481cf91180328ec9b18f', finding: 'pdf-lib package is installed in the appdata runtime group, not bundled node_modules' }
  ]
});
export const expectedSourceTreeSha256 = SOURCE_BINDING.resourceTree.sha256;

export const candidateRules = Object.freeze([
  {
    id: 'pdf-lib-1.17.1-commonjs-formats', kind: 'package-format-prune', enabled: true,
    packageRoot: 'image-batch-studio/preload/node_modules/pdf-lib',
    package: { name: 'pdf-lib', version: '1.17.1', main: 'cjs/index.js', packageJsonSha256: '951726fe11b7376919050c18d2cd9237d6e211d7ee0b01104990cb95105fe182' },
    consumer: { path: 'image-batch-studio/preload/processor.js', sha256: 'a00734e06fd2ce8bd0065cc70ab9e060725b6f1b383e5037e91b38d63a11cf41', scopeRoot: 'image-batch-studio', exactCalls: 1 },
    otherReferences: [
      { path: 'pdf-office-workbench/preload/services.js', sha256: '2b15dc914f5b74a25bea6374291ee0256bd7af961c904c2bb0da16362de07104', mode: 'require', calls: 1, resolution: null, note: 'separate plugin anchor has no bundled pdf-lib package; existing unresolved dependency gap' },
      { path: 'format-converter/preload/pdf-converter.cjs', sha256: 'ad097cc36cba094ad3a0a15204c5889f107d95a1114bb14ff59a5a667f0fac17', mode: 'runtimeRequire', calls: 2, resolution: null, note: 'uses appdata runtime root' },
      { path: 'format-converter/preload/image-converter.cjs', sha256: '861b9b7aeb70132ddbd4f9442e529e19c76f036d8c3fed4976575f06b29530fd', mode: 'runtimeRequire', calls: 1, resolution: null, note: 'uses appdata runtime root' },
      { path: 'format-converter/preload/runtime-installer.cjs', sha256: '92475cac32ecc031947363f26995b0788fd16632b2d8fc32e1ad11fa1042dc16', mode: 'runtimeRequire', calls: 1, resolution: null, note: 'verifies appdata runtime root after install' }
    ],
    otherRelativeReferences: [
      { path: 'pdf-office-workbench/tests/file-operations.test.mjs', sha256: '47b7ffe42e048c2562b1fad59fb041ed878ff32ed391f8654f64dffc491f234d',
        mode: 'relative-require', request: '../preload/node_modules/pdf-lib', calls: 1,
        domain: 'foreign', targetPath: 'pdf-office-workbench/preload/node_modules/pdf-lib', status: 'missing', resolvedModule: null, packageName: null,
        note: 'different plugin anchor; unresolved test dependency remains absent and is not fulfilled by image-batch-studio package' }
    ],
    dropDirectories: ['dist', 'es', 'src', 'ts3.4'],
    retainPaths: ['package.json', 'cjs/index.js', 'LICENSE.md', 'README.md', 'yarn.lock'],
    dependencyClosure: ['@pdf-lib/standard-fonts', '@pdf-lib/upng', 'pako', 'tslib'],
    acceptanceGate: 'candidate-only: require root-run processor PDF positive and malformed-input negative smoke before release integration'
  },
  {
    id: 'cc-switch-darwin-single-arch-sidecar', kind: 'target-file-set', enabled: true, platform: 'darwin',
    loader: { path: 'ztools-cc-switch/preload/sidecarClient.js', sha256: '6063125ada431cc5c969b1ccb083e60901d4405a69fc14a72ed7c133b63abce7' },
    caller: { path: 'ztools-cc-switch/preload/index.js', sha256: 'd853385345beced8fdf5a094de0d6f77980b5669526b125244f87e1644212d57' },
    assets: [
      { platform: 'darwin', arch: 'arm64', path: 'ztools-cc-switch/preload/bin/cc-switch-sidecar-darwin-arm64', bytes: 2413872, sha256: 'baef361d355a8f1ff8f74eeaebef55eb4a3dd9d98d2fb8a840c4de44207321d0' },
      { platform: 'darwin', arch: 'x64', path: 'ztools-cc-switch/preload/bin/cc-switch-sidecar-darwin-x64', bytes: 2493400, sha256: 'b7084b07612abad84714ef63db4ea0ca534be2f802e7d6eefdc5d60793665d83' }
    ],
    universalPolicy: 'preserve-both', unknownTargetPolicy: 'preserve-both'
  }
]);
