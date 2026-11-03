import fs from 'node:fs';
import path from 'node:path';

const pluginRoot = '/Users/harris/Desktop/atools/ZTools-plugins/plugins';
const entries = fs.readdirSync(pluginRoot, { withFileTypes: true });

const results = [];

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const dirName = entry.name;
  const dirPath = path.join(pluginRoot, dirName);
  
  // Find manifest
  let manifestPath = null;
  let manifest = null;
  const directManifest = path.join(dirPath, 'plugin.json');
  const publicManifest = path.join(dirPath, 'public', 'plugin.json');
  
  if (fs.existsSync(directManifest)) {
    manifestPath = directManifest;
  } else if (fs.existsSync(publicManifest)) {
    manifestPath = publicManifest;
  }
  
  if (!manifestPath) {
    results.push({
      id: dirName,
      status: 'missing_manifest',
      manifest_location: null,
      issues: ['No plugin.json found in root or public/']
    });
    continue;
  }
  
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    results.push({
      id: dirName,
      status: 'invalid_json',
      manifest_location: path.relative(dirPath, manifestPath),
      issues: [`JSON parse error: ${err.message}`]
    });
    continue;
  }
  
  const manifestDir = path.dirname(manifestPath);
  const issues = [];
  
  // Check main
  if (!manifest.main) {
    issues.push('Missing "main" field in manifest');
  } else {
    // Check if main file exists relative to manifestDir or dirPath or dist/
    const possibleMainPaths = [
      path.join(manifestDir, manifest.main),
      path.join(dirPath, manifest.main),
      path.join(dirPath, 'dist', manifest.main),
      path.join(dirPath, 'build', manifest.main),
      path.join(dirPath, 'public', manifest.main),
    ];
    const mainFound = possibleMainPaths.some(p => fs.existsSync(p));
    if (!mainFound && !manifest.main.startsWith('http://') && !manifest.main.startsWith('https://')) {
      issues.push(`Main file "${manifest.main}" not found on disk (source repo needs build step)`);
    }
  }
  
  // Check preload
  if (manifest.preload) {
    const possiblePreloadPaths = [
      path.join(manifestDir, manifest.preload),
      path.join(dirPath, manifest.preload),
      path.join(dirPath, 'dist', manifest.preload),
      path.join(dirPath, 'public', manifest.preload),
    ];
    const preloadFound = possiblePreloadPaths.some(p => fs.existsSync(p));
    if (!preloadFound) {
      issues.push(`Preload file "${manifest.preload}" not found`);
    }
  }
  
  // Check logo
  if (manifest.logo) {
    const possibleLogoPaths = [
      path.join(manifestDir, manifest.logo),
      path.join(dirPath, manifest.logo),
      path.join(dirPath, 'public', manifest.logo),
    ];
    const logoFound = possibleLogoPaths.some(p => fs.existsSync(p));
    if (!logoFound && !manifest.logo.startsWith('http://') && !manifest.logo.startsWith('https://') && !manifest.logo.startsWith('data:')) {
      issues.push(`Logo file "${manifest.logo}" not found`);
    }
  }
  
  // Check features and cmds
  let cmdCount = 0;
  if (Array.isArray(manifest.features)) {
    for (const feat of manifest.features) {
      if (Array.isArray(feat.cmds)) {
        cmdCount += feat.cmds.length;
      }
    }
  }
  
  results.push({
    id: manifest.name || dirName,
    title: manifest.title || manifest.pluginName || dirName,
    version: manifest.version || '0.0.0',
    manifest_location: path.relative(dirPath, manifestPath),
    has_package_json: fs.existsSync(path.join(dirPath, 'package.json')),
    has_dist: fs.existsSync(path.join(dirPath, 'dist')),
    has_build: fs.existsSync(path.join(dirPath, 'build')),
    feature_count: (manifest.features || []).length,
    cmd_count: cmdCount,
    status: issues.length === 0 ? 'fully_ready' : (issues.some(i => i.includes('Main file') || i.includes('Missing "main"')) ? 'requires_build' : 'has_warnings'),
    issues
  });
}

const summary = {
  total: results.length,
  fully_ready: results.filter(r => r.status === 'fully_ready').length,
  requires_build: results.filter(r => r.status === 'requires_build').length,
  has_warnings: results.filter(r => r.status === 'has_warnings').length,
  missing_manifest: results.filter(r => r.status === 'missing_manifest').length,
};

fs.writeFileSync('/Users/harris/Desktop/atools/output_ztools_audit.json', JSON.stringify({ summary, results }, null, 2));
console.log('Summary:', summary);
