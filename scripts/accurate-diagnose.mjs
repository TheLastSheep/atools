import fs from 'node:fs';
import path from 'node:path';

const pluginRoot = '/Users/harris/Desktop/atools/ZTools-plugins/plugins';
const dirs = fs.readdirSync(pluginRoot).filter(d => fs.statSync(path.join(pluginRoot, d)).isDirectory());

const unsupported = [];
const supported = [];

for (const d of dirs) {
  const dirPath = path.join(pluginRoot, d);
  
  // Look for all possible manifests
  const candidateManifests = [
    path.join(dirPath, 'plugin.json'),
    path.join(dirPath, 'public', 'plugin.json'),
    path.join(dirPath, 'dist', 'plugin.json'),
  ];
  
  let mPath = null;
  for (const c of candidateManifests) {
    if (fs.existsSync(c)) {
      mPath = c;
      break;
    }
  }

  if (!mPath) {
    unsupported.push({
      id: d,
      category: 'MISSING_MANIFEST',
      description: '插件目录中不存在 plugin.json 清单文件（属于未打包或子模块源码工程）',
      files: fs.readdirSync(dirPath)
    });
    continue;
  }

  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  } catch (e) {
    unsupported.push({
      id: d,
      category: 'INVALID_JSON',
      description: `Manifest 解析失败: ${e.message}`,
      manifestPath: mPath
    });
    continue;
  }

  // ATools loader resolution logic:
  // Check relative to manifest dir, AND relative to plugin dir, AND in dist/public
  const manifestDir = path.dirname(mPath);
  
  function resolveFile(fileRel) {
    if (!fileRel) return null;
    const candidates = [
      path.resolve(manifestDir, fileRel),
      path.resolve(dirPath, fileRel),
      path.resolve(dirPath, 'dist', fileRel),
      path.resolve(dirPath, 'public', fileRel),
      path.resolve(dirPath, 'dist', path.basename(fileRel)),
      path.resolve(dirPath, 'public', path.basename(fileRel)),
      path.resolve(dirPath, path.basename(fileRel)),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  const issues = [];
  const mainResolved = manifest.main ? resolveFile(manifest.main) : null;
  if (!mainResolved) {
    issues.push(`主入口 main 文件不存在: "${manifest.main}"`);
  }

  let preloadResolved = null;
  if (manifest.preload) {
    preloadResolved = resolveFile(manifest.preload);
    if (!preloadResolved) {
      issues.push(`Preload 脚本不存在: "${manifest.preload}"`);
    }
  }

  if (issues.length > 0) {
    unsupported.push({
      id: d,
      title: manifest.title || manifest.name || d,
      version: manifest.version || 'unknown',
      category: 'MISSING_BUILD_ASSETS',
      description: '缺少构建产物（如 dist/ 目录、打包后的 JS/HTML），属于 TypeScript/Vue/Vite 源码开发态',
      main: manifest.main,
      preload: manifest.preload,
      issues,
      manifestPath: mPath,
      dirFiles: fs.readdirSync(dirPath)
    });
  } else {
    supported.push({
      id: d,
      title: manifest.title || manifest.name || d,
      main: mainResolved,
      preload: preloadResolved
    });
  }
}

console.log(`=== AUDIT SUMMARY ===`);
console.log(`Total Plugins: ${dirs.length}`);
console.log(`Fully Supported & Ready: ${supported.length}`);
console.log(`Unsupported / Not Ready: ${unsupported.length}`);

fs.writeFileSync('/Users/harris/Desktop/atools/unsupported_plugins_final.json', JSON.stringify(unsupported, null, 2), 'utf8');
