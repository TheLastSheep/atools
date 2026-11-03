import fs from 'fs';
import path from 'path';

const pluginsDir = path.resolve('ZTools-plugins/plugins');
const targetBuiltinDir = path.resolve('resources/plugins/builtin');

if (!fs.existsSync(targetBuiltinDir)) {
  fs.mkdirSync(targetBuiltinDir, { recursive: true });
}

const entries = fs.readdirSync(pluginsDir).filter(f => fs.statSync(path.join(pluginsDir, f)).isDirectory());

let mounted = 0;
let skipped = [];

for (const name of entries) {
  const pluginDir = path.join(pluginsDir, name);
  
  // Find manifest
  let manifestSub = null;
  let manifestPath = null;
  for (const sub of ['', 'public', 'dist', 'src', 'plugin', 'app']) {
    const candidate = path.join(pluginDir, sub, 'plugin.json');
    if (fs.existsSync(candidate)) {
      manifestPath = candidate;
      manifestSub = sub;
      break;
    }
  }

  if (!manifestPath) {
    skipped.push({ name, reason: 'no manifest found' });
    continue;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    skipped.push({ name, reason: `manifest json parse error: ${e.message}` });
    continue;
  }

  const mainHtml = manifest.main || 'index.html';
  // Locate mainHtml relative to plugin directory
  let htmlSub = null;
  for (const sub of ['', 'dist', 'public', 'src', 'plugin', 'app']) {
    if (fs.existsSync(path.join(pluginDir, sub, mainHtml))) {
      htmlSub = sub;
      break;
    }
  }

  if (!htmlSub && !fs.existsSync(path.join(pluginDir, mainHtml))) {
    skipped.push({ name, reason: `main html "${mainHtml}" not found` });
    continue;
  }

  // Determine standard base dir to link or create
  // If manifest is in public/ and main is in dist/ or root, or manifest in root...
  // Let's create a normalized plugin directory in resources/plugins/builtin/<name>
  const targetDir = path.join(targetBuiltinDir, name);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Let's create or update the root plugin.json in targetDir
  // We normalize the main / preload / logo paths so ATools runtime can find them seamlessly!
  const normalizedManifest = { ...manifest };
  
  // Find preload file
  let preloadPath = manifest.preload || 'preload.js';
  let resolvedPreload = null;
  for (const sub of ['', 'public', 'dist', 'src', 'plugin', 'app', 'preload']) {
    const p = path.join(pluginDir, sub, preloadPath);
    if (fs.existsSync(p)) {
      resolvedPreload = path.relative(pluginDir, p);
      break;
    }
    const p2 = path.join(pluginDir, preloadPath);
    if (fs.existsSync(p2)) {
      resolvedPreload = preloadPath;
      break;
    }
  }

  // Find logo file
  let logoPath = manifest.logo || 'logo.png';
  let resolvedLogo = null;
  for (const sub of ['', 'public', 'dist', 'src', 'plugin', 'app', 'assets']) {
    const p = path.join(pluginDir, sub, logoPath);
    if (fs.existsSync(p)) {
      resolvedLogo = path.relative(pluginDir, p);
      break;
    }
    const p2 = path.join(pluginDir, logoPath);
    if (fs.existsSync(p2)) {
      resolvedLogo = logoPath;
      break;
    }
  }

  let resolvedMain = null;
  if (htmlSub) {
    resolvedMain = htmlSub ? path.join(htmlSub, mainHtml) : mainHtml;
  } else {
    resolvedMain = mainHtml;
  }

  // Clean relative path formatting
  if (resolvedMain) normalizedManifest.main = resolvedMain.replace(/^\.\//, '');
  if (resolvedPreload) normalizedManifest.preload = resolvedPreload.replace(/^\.\//, '');
  if (resolvedLogo) normalizedManifest.logo = resolvedLogo.replace(/^\.\//, '');

  // Write normalized plugin.json to targetDir
  fs.writeFileSync(path.join(targetDir, 'plugin.json'), JSON.stringify(normalizedManifest, null, 2), 'utf-8');

  // Symlink all entries from pluginDir to targetDir if not already existing
  const pluginEntries = fs.readdirSync(pluginDir);
  for (const item of pluginEntries) {
    if (item === 'plugin.json') continue; // keep normalized one
    const srcItem = path.join(pluginDir, item);
    const dstItem = path.join(targetDir, item);
    if (!fs.existsSync(dstItem)) {
      try {
        fs.symlinkSync(srcItem, dstItem);
      } catch (e) {
        // if symlink fails, copy or ignore
      }
    }
  }

  mounted++;
}

console.log(`Successfully mounted ${mounted} plugins to ${targetBuiltinDir}`);
console.log(`Skipped ${skipped.length} plugins:`);
skipped.forEach(s => console.log(` - ${s.name}: ${s.reason}`));
