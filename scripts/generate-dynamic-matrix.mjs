import fs from 'node:fs';
import path from 'node:path';

const pluginsRoot = '/Users/harris/Desktop/atools/ZTools-plugins/plugins';

const allDirs = fs.readdirSync(pluginsRoot).filter(f => {
  return fs.statSync(path.join(pluginsRoot, f)).isDirectory();
}).sort();

const results = [];
let verified100 = 0;
let requiresBuild = 0;
let missingManifest = 0;

for (const dir of allDirs) {
  const pluginDir = path.join(pluginsRoot, dir);

  let manifestPath = path.join(pluginDir, 'plugin.json');
  let manifestLoc = 'root';
  if (!fs.existsSync(manifestPath)) {
    if (fs.existsSync(path.join(pluginDir, 'public', 'plugin.json'))) {
      manifestPath = path.join(pluginDir, 'public', 'plugin.json');
      manifestLoc = 'public';
    } else if (fs.existsSync(path.join(pluginDir, 'dist', 'plugin.json'))) {
      manifestPath = path.join(pluginDir, 'dist', 'plugin.json');
      manifestLoc = 'dist';
    } else {
      results.push({
        id: dir,
        name: dir,
        status: 'UNSUPPORTED_NO_MANIFEST',
        dynamic_compatible: false,
        reason: 'Missing plugin.json manifest in root/public/dist',
      });
      missingManifest++;
      continue;
    }
  }

  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    results.push({
      id: dir,
      status: 'INVALID_JSON',
      dynamic_compatible: false,
      reason: `JSON parse error: ${e.message}`,
    });
    missingManifest++;
    continue;
  }

  let main = manifest.main || 'index.html';
  if (main.startsWith('http')) main = 'index.html';

  let htmlPath = path.join(pluginDir, main);
  let htmlLoc = 'root';
  if (!fs.existsSync(htmlPath)) {
    if (fs.existsSync(path.join(pluginDir, 'public', main))) {
      htmlPath = path.join(pluginDir, 'public', main);
      htmlLoc = 'public';
    } else if (fs.existsSync(path.join(pluginDir, 'dist', main))) {
      htmlPath = path.join(pluginDir, 'dist', main);
      htmlLoc = 'dist';
    } else {
      results.push({
        id: dir,
        title: manifest.title || manifest.name || dir,
        version: manifest.version || '1.0.0',
        status: 'REQUIRES_SOURCE_BUILD',
        dynamic_compatible: false,
        reason: `Main entry ${main} not compiled yet (needs npm run build)`,
      });
      requiresBuild++;
      continue;
    }
  }

  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const htmlDir = path.dirname(htmlPath);

  // Check script and css bundles referenced in html
  const scriptMatches = Array.from(htmlContent.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)).map(m => m[1]);
  const cssMatches = Array.from(htmlContent.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)).map(m => m[1]);

  const missingAssets = [];
  for (const src of scriptMatches) {
    if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//') || src.startsWith('data:')) continue;
    const clean = src.split('?')[0].split('#')[0];
    const resolved = path.resolve(htmlDir, clean);
    if (!fs.existsSync(resolved)) {
      missingAssets.push(`Script: ${src}`);
    }
  }
  for (const href of cssMatches) {
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//') || href.startsWith('data:')) continue;
    const clean = href.split('?')[0].split('#')[0];
    const resolved = path.resolve(htmlDir, clean);
    if (!fs.existsSync(resolved)) {
      missingAssets.push(`CSS: ${href}`);
    }
  }

  // Preload script check
  let preloadOk = true;
  if (manifest.preload) {
    const p1 = path.join(pluginDir, manifest.preload);
    const p2 = path.join(pluginDir, 'public', manifest.preload);
    const p3 = path.join(pluginDir, 'dist', manifest.preload);
    if (!fs.existsSync(p1) && !fs.existsSync(p2) && !fs.existsSync(p3)) {
      preloadOk = false;
      missingAssets.push(`Preload: ${manifest.preload}`);
    }
  }

  // Logo check
  let logoOk = true;
  if (manifest.logo) {
    const l1 = path.join(pluginDir, manifest.logo);
    const l2 = path.join(pluginDir, 'public', manifest.logo);
    const l3 = path.join(pluginDir, 'dist', manifest.logo);
    if (!fs.existsSync(l1) && !fs.existsSync(l2) && !fs.existsSync(l3)) {
      logoOk = false;
    }
  }

  const is100Percent = missingAssets.length === 0;

  results.push({
    id: dir,
    title: manifest.title || manifest.name || dir,
    version: manifest.version || '1.0.0',
    status: is100Percent ? '100%_DYNAMIC_COMPATIBLE' : 'ASSET_MISSING',
    dynamic_compatible: is100Percent,
    entry_html: path.relative(pluginsRoot, htmlPath),
    html_size_bytes: htmlContent.length,
    referenced_scripts: scriptMatches.length,
    referenced_stylesheets: cssMatches.length,
    preload: manifest.preload || null,
    preload_ready: preloadOk,
    logo_ready: logoOk,
    features_count: manifest.features?.length || 0,
    features: (manifest.features || []).map(f => ({
      code: f.code,
      explain: f.explain,
      cmds_count: (f.cmds || []).length,
    })),
    issues: missingAssets,
  });

  if (is100Percent) verified100++;
  else requiresBuild++;
}

const finalReport = {
  summary: {
    total_plugins_scanned: allDirs.length,
    fully_100_percent_dynamic_compatible: verified100,
    requires_build_or_uncompiled: requiresBuild,
    missing_manifest_or_uninitialized: missingManifest,
    compatibility_rate: `${((verified100 / allDirs.length) * 100).toFixed(1)}%`,
  },
  plugins: results,
};

fs.writeFileSync('/Users/harris/Desktop/atools/ztools_dynamic_compatibility_matrix.json', JSON.stringify(finalReport, null, 2), 'utf8');
console.log('Matrix generated successfully.');
