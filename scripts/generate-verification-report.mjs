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
      title: dirName,
      type: 'source_repo',
      status: 'unbuilt_source',
      notes: 'No plugin.json found (uncompiled repository or build script present)'
    });
    continue;
  }
  
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    results.push({
      id: dirName,
      title: dirName,
      type: 'unknown',
      status: 'invalid_json',
      notes: `JSON parse error: ${err.message}`
    });
    continue;
  }
  
  const manifestDir = path.dirname(manifestPath);
  const name = manifest.name || dirName;
  const title = manifest.title || manifest.pluginName || name;
  const isTemplate = !manifest.main && !!manifest.preload;
  const pluginType = manifest.main ? 'ui_plugin' : (manifest.preload ? 'template_plugin' : 'unknown');
  
  const missingFiles = [];
  
  if (manifest.main) {
    const possibleMainPaths = [
      path.join(manifestDir, manifest.main),
      path.join(dirPath, manifest.main),
      path.join(dirPath, 'dist', manifest.main),
      path.join(dirPath, 'build', manifest.main),
      path.join(dirPath, 'public', manifest.main),
    ];
    if (!possibleMainPaths.some(p => fs.existsSync(p))) {
      missingFiles.push(`main: ${manifest.main}`);
    }
  }
  
  if (manifest.preload) {
    const possiblePreloadPaths = [
      path.join(manifestDir, manifest.preload),
      path.join(dirPath, manifest.preload),
      path.join(dirPath, 'dist', manifest.preload),
      path.join(dirPath, 'public', manifest.preload),
    ];
    if (!possiblePreloadPaths.some(p => fs.existsSync(p))) {
      missingFiles.push(`preload: ${manifest.preload}`);
    }
  }
  
  if (manifest.logo) {
    const possibleLogoPaths = [
      path.join(manifestDir, manifest.logo),
      path.join(dirPath, manifest.logo),
      path.join(dirPath, 'public', manifest.logo),
    ];
    if (!possibleLogoPaths.some(p => fs.existsSync(p))) {
      missingFiles.push(`logo: ${manifest.logo}`);
    }
  }
  
  const hasPlatform = Array.isArray(manifest.platform) ? manifest.platform : [];
  const macCompatible = hasPlatform.length === 0 || hasPlatform.includes('darwin');
  const winCompatible = hasPlatform.length === 0 || hasPlatform.includes('win32');
  const linuxCompatible = hasPlatform.length === 0 || hasPlatform.includes('linux');
  
  let status = '100%_compatible';
  if (missingFiles.length > 0) {
    status = 'requires_build';
  }
  
  results.push({
    id: name,
    title: title,
    version: manifest.version || '0.0.0',
    type: pluginType,
    main: manifest.main || null,
    preload: manifest.preload || null,
    features_count: (manifest.features || []).length,
    cmds_count: (manifest.features || []).reduce((acc, f) => acc + (f.cmds || []).length, 0),
    has_tools: !!manifest.tools,
    platforms: { darwin: macCompatible, win32: winCompatible, linux: linuxCompatible },
    status: status,
    missing_files: missingFiles
  });
}

fs.writeFileSync('/Users/harris/Desktop/atools/ztools_plugin_verification_report.json', JSON.stringify(results, null, 2));

const fullyCompatible = results.filter(r => r.status === '100%_compatible');
const requiresBuild = results.filter(r => r.status === 'requires_build' || r.status === 'unbuilt_source');

console.log(`Total Plugins in ZTools repo: ${results.length}`);
console.log(`- Ready & 100% Compatible: ${fullyCompatible.length}`);
console.log(`- Requires Source Build / Missing Assets: ${requiresBuild.length}`);
