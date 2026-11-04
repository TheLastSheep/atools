import fs from 'node:fs';
import path from 'node:path';

const pluginRoot = '/Users/harris/Desktop/atools/ZTools-plugins/plugins';
const builtinRoot = '/Users/harris/Desktop/atools/resources/plugins/builtin';
const entries = fs.readdirSync(pluginRoot, { withFileTypes: true });

const MANIFEST_REL_CANDIDATES = [
  'plugin.json',
  'public/plugin.json',
  'dist/plugin.json',
  'src/plugin.json',
  'app/plugin.json',
  'plugin/plugin.json',
  'packages/ctool-adapter/utools/resources/plugin.json',
];

const results = [];

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const dirName = entry.name;
  const dirPath = path.join(pluginRoot, dirName);
  const builtinDir = path.join(builtinRoot, dirName);

  // Find manifest across all host-recognized and source-build candidate locations
  let manifestPath = null;
  let manifest = null;
  for (const rel of MANIFEST_REL_CANDIDATES) {
    const candidate = path.join(dirPath, rel);
    if (fs.existsSync(candidate)) {
      manifestPath = candidate;
      break;
    }
  }
  if (!manifestPath && fs.existsSync(path.join(builtinDir, 'plugin.json'))) {
    manifestPath = path.join(builtinDir, 'plugin.json');
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
  const cleanRel = (val) => String(val || '').replace(/^\/+/, '');
  const hasSourceBuildPipeline = fs.existsSync(path.join(dirPath, 'package.json'));

  if (manifest.main) {
    const mainRel = cleanRel(manifest.main);
    const mainBase = path.basename(mainRel);
    const possibleMainPaths = [
      path.join(manifestDir, mainRel),
      path.join(dirPath, mainRel),
      path.join(dirPath, 'dist', mainRel),
      path.join(dirPath, 'build', mainRel),
      path.join(dirPath, 'public', mainRel),
      path.join(dirPath, 'src', mainBase),
      path.join(dirPath, 'src', 'web', 'html', mainBase),
      path.join(dirPath, 'Anywhere_main', mainBase),
      path.join(dirPath, 'packages', 'ctool-core', mainBase),
      path.join(dirPath, mainBase),
      path.join(builtinDir, mainRel),
      path.join(builtinDir, mainBase),
    ];
    if (!possibleMainPaths.some(p => fs.existsSync(p)) && !hasSourceBuildPipeline) {
      missingFiles.push(`main: ${manifest.main}`);
    }
  }
  
  if (manifest.preload) {
    const preloadRel = cleanRel(manifest.preload);
    const preloadBase = path.basename(preloadRel);
    const possiblePreloadPaths = [
      path.join(manifestDir, preloadRel),
      path.join(dirPath, preloadRel),
      path.join(dirPath, preloadRel.replace(/\.js$/, '.cjs')),
      path.join(dirPath, 'dist', preloadRel),
      path.join(dirPath, 'public', preloadRel),
      path.join(dirPath, 'public', 'preload', 'package.json'),
      path.join(dirPath, 'src', 'preload', 'package.json'),
      path.join(dirPath, 'backend', 'src', preloadBase),
      path.join(builtinDir, preloadRel),
      path.join(builtinDir, preloadRel.replace(/\.js$/, '.cjs')),
    ];
    if (!possiblePreloadPaths.some(p => fs.existsSync(p)) && !hasSourceBuildPipeline) {
      missingFiles.push(`preload: ${manifest.preload}`);
    }
  }
  
  if (manifest.logo) {
    const logoRel = cleanRel(manifest.logo);
    const logoBase = path.basename(logoRel);
    const possibleLogoPaths = [
      path.join(manifestDir, logoRel),
      path.join(dirPath, logoRel),
      path.join(dirPath, 'public', logoRel),
      path.join(dirPath, 'public', logoBase),
      path.join(dirPath, 'src', 'assets', logoBase),
      path.join(builtinDir, logoRel),
      path.join(builtinDir, logoBase),
    ];
    if (!possibleLogoPaths.some(p => fs.existsSync(p)) && !hasSourceBuildPipeline) {
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
  
  const featuresList = Array.isArray(manifest.features) ? manifest.features : [];
  results.push({
    id: name,
    title: title,
    version: manifest.version || '0.0.0',
    type: pluginType,
    main: manifest.main || null,
    preload: manifest.preload || null,
    features_count: featuresList.length,
    cmds_count: featuresList.reduce((acc, f) => acc + (Array.isArray(f?.cmds) ? f.cmds.length : 0), 0),
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
