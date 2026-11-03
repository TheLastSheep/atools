import fs from 'node:fs';
import path from 'node:path';

const pluginRoot = '/Users/harris/Desktop/atools/ZTools-plugins/plugins';
const dirs = fs.readdirSync(pluginRoot).filter(d => fs.statSync(path.join(pluginRoot, d)).isDirectory());

const unsupported = [];

for (const d of dirs) {
  const dirPath = path.join(pluginRoot, d);
  const manifestPath = path.join(dirPath, 'plugin.json');
  const publicManifestPath = path.join(dirPath, 'public', 'plugin.json');
  const distManifestPath = path.join(dirPath, 'dist', 'plugin.json');
  
  let manifest = null;
  let mPath = null;
  if (fs.existsSync(manifestPath)) {
    mPath = manifestPath;
  } else if (fs.existsSync(publicManifestPath)) {
    mPath = publicManifestPath;
  } else if (fs.existsSync(distManifestPath)) {
    mPath = distManifestPath;
  }

  if (!mPath) {
    unsupported.push({
      id: d,
      type: 'MISSING_MANIFEST',
      dir: dirPath,
      files: fs.readdirSync(dirPath)
    });
    continue;
  }

  try {
    manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  } catch (e) {
    unsupported.push({
      id: d,
      type: 'INVALID_MANIFEST_JSON',
      dir: dirPath,
      error: e.message
    });
    continue;
  }

  const baseDir = path.dirname(mPath);
  const mainPath = manifest.main ? path.resolve(baseDir, manifest.main) : null;
  const preloadPath = manifest.preload ? path.resolve(baseDir, manifest.preload) : null;

  const issues = [];
  if (!mainPath || !fs.existsSync(mainPath)) {
    issues.push(`Main entry missing: ${manifest.main} (resolved: ${mainPath})`);
  }
  if (manifest.preload && (!preloadPath || !fs.existsSync(preloadPath))) {
    issues.push(`Preload missing: ${manifest.preload} (resolved: ${preloadPath})`);
  }

  if (issues.length > 0) {
    unsupported.push({
      id: d,
      title: manifest.title || manifest.name || d,
      version: manifest.version,
      type: 'MISSING_ENTRY_OR_PRELOAD',
      manifestPath: mPath,
      main: manifest.main,
      preload: manifest.preload,
      issues,
      dirFiles: fs.readdirSync(dirPath)
    });
  }
}

fs.writeFileSync('/Users/harris/Desktop/atools/unsupported_plugins_detailed.json', JSON.stringify(unsupported, null, 2), 'utf8');
console.log(`Total unsupported/not-ready plugins found: ${unsupported.length}`);
