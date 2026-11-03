import fs from 'node:fs';
import path from 'node:path';

const pluginRoot = '/Users/harris/Desktop/atools/ZTools-plugins/plugins';

// Read all subdirectories
const dirs = fs.readdirSync(pluginRoot, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

console.log(`Total plugin directories found: ${dirs.length}`);

// We will inspect each plugin
const fullReport = [];

for (const dirName of dirs) {
  const dirPath = path.join(pluginRoot, dirName);
  
  // Find manifest
  let manifestPath = null;
  let manifestRel = null;
  
  if (fs.existsSync(path.join(dirPath, 'plugin.json'))) {
    manifestPath = path.join(dirPath, 'plugin.json');
    manifestRel = 'plugin.json';
  } else if (fs.existsSync(path.join(dirPath, 'public', 'plugin.json'))) {
    manifestPath = path.join(dirPath, 'public', 'plugin.json');
    manifestRel = 'public/plugin.json';
  } else if (fs.existsSync(path.join(dirPath, 'dist', 'plugin.json'))) {
    manifestPath = path.join(dirPath, 'dist', 'plugin.json');
    manifestRel = 'dist/plugin.json';
  }

  const result = {
    id: dirName,
    has_manifest: !!manifestPath,
    manifest_location: manifestRel,
    title: null,
    name: null,
    version: null,
    main: null,
    main_resolved_path: null,
    main_exists: false,
    preload: null,
    preload_resolved_path: null,
    preload_exists: false,
    logo: null,
    logo_resolved_path: null,
    logo_exists: false,
    platform: null,
    platform_supported: true,
    features_count: 0,
    commands_count: 0,
    features: [],
    apis_used: [],
    compatibility_status: 'unknown',
    notes: []
  };

  if (!manifestPath) {
    result.compatibility_status = 'missing_manifest_unbuilt';
    result.notes.push('No plugin.json found in root, public/, or dist/');
    fullReport.push(result);
    continue;
  }

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    result.compatibility_status = 'invalid_json_manifest';
    result.notes.push(`JSON parse error: ${err.message}`);
    fullReport.push(result);
    continue;
  }

  result.name = manifest.name || dirName;
  result.title = manifest.pluginName || manifest.title || manifest.name || dirName;
  result.version = manifest.version || '0.0.0';
  result.main = manifest.main || null;
  result.preload = manifest.preload || null;
  result.logo = manifest.logo || null;
  result.platform = manifest.platform || ['darwin', 'win32', 'linux'];

  // Check platform
  if (Array.isArray(result.platform) && result.platform.length > 0) {
    result.platform_supported = result.platform.includes('darwin') || result.platform.includes('win32') || result.platform.includes('linux');
  }

  // Resolve files relative to manifest directory or plugin directory
  const manifestDir = path.dirname(manifestPath);

  // Check main
  if (result.main) {
    if (result.main.startsWith('http://') || result.main.startsWith('https://')) {
      result.main_exists = true;
      result.main_resolved_path = result.main;
    } else {
      const cleanMain = result.main.replace(/^\//, '');
      const candidates = [
        path.join(manifestDir, cleanMain),
        path.join(dirPath, cleanMain),
        path.join(dirPath, 'dist', cleanMain),
        path.join(dirPath, 'public', cleanMain),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          result.main_exists = true;
          result.main_resolved_path = path.relative(dirPath, c);
          break;
        }
      }
    }
  }

  // Check preload
  if (result.preload) {
    const cleanPreload = result.preload.replace(/^\//, '');
    const candidates = [
      path.join(manifestDir, cleanPreload),
      path.join(dirPath, cleanPreload),
      path.join(dirPath, 'dist', cleanPreload),
      path.join(dirPath, 'public', cleanPreload),
      path.join(dirPath, 'preload.cjs'),
      path.join(dirPath, 'preload.js')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        result.preload_exists = true;
        result.preload_resolved_path = path.relative(dirPath, c);
        break;
      }
    }
  } else {
    result.preload_exists = true; // Not required if not defined
  }

  // Check logo
  if (result.logo) {
    const cleanLogo = result.logo.replace(/^\//, '');
    const candidates = [
      path.join(manifestDir, cleanLogo),
      path.join(dirPath, cleanLogo),
      path.join(dirPath, 'public', cleanLogo),
      path.join(dirPath, 'logo.png'),
      path.join(dirPath, 'logo.svg')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        result.logo_exists = true;
        result.logo_resolved_path = path.relative(dirPath, c);
        break;
      }
    }
  } else {
    result.logo_exists = true;
  }

  // Parse features
  if (Array.isArray(manifest.features)) {
    result.features_count = manifest.features.length;
    for (const f of manifest.features) {
      const cmds = f.cmds || [];
      result.commands_count += cmds.length;
      result.features.push({
        code: f.code,
        explain: f.explain,
        cmds_count: cmds.length
      });
    }
  }

  // Status judgement
  if (result.main_exists && result.preload_exists && result.logo_exists) {
    result.compatibility_status = '100%_COMPATIBLE_READY';
  } else if (!result.main_exists || !result.preload_exists) {
    result.compatibility_status = 'REQUIRES_BUILD_OR_DEV_SETUP';
    if (!result.main_exists) result.notes.push(`Main entry not found: ${result.main}`);
    if (!result.preload_exists) result.notes.push(`Preload entry not found: ${result.preload}`);
  }

  fullReport.push(result);
}

fs.writeFileSync('/Users/harris/Desktop/atools/ztools_plugin_full_detailed_audit.json', JSON.stringify(fullReport, null, 2));

const summary = {
  total: fullReport.length,
  ready: fullReport.filter(r => r.compatibility_status === '100%_COMPATIBLE_READY').length,
  requires_build: fullReport.filter(r => r.compatibility_status === 'REQUIRES_BUILD_OR_DEV_SETUP').length,
  missing_manifest: fullReport.filter(r => r.compatibility_status === 'missing_manifest_unbuilt').length
};

console.log('AUDIT COMPLETED:', summary);
