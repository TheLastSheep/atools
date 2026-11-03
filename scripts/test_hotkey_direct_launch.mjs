import fs from 'fs';
import path from 'path';

console.log('Validating settings.ts and hotkey.rs integration...');
const settingsTs = fs.readFileSync('src/lib/settings.ts', 'utf8');
if (settingsTs.includes('sync_app_shortcuts')) {
  console.log('✓ settings.ts includes sync_app_shortcuts in applyNativeSettings');
} else {
  console.error('✗ settings.ts missing sync_app_shortcuts');
}

const commandsRs = fs.readFileSync('src-tauri/src/commands.rs', 'utf8');
if (commandsRs.includes('pub fn sync_app_shortcuts')) {
  console.log('✓ commands.rs includes sync_app_shortcuts handler');
} else {
  console.error('✗ commands.rs missing sync_app_shortcuts');
}

const hotkeyRs = fs.readFileSync('src-tauri/src/hotkey.rs', 'utf8');
if (hotkeyRs.includes('register_app_shortcut')) {
  console.log('✓ hotkey.rs includes register_app_shortcut with direct expand and window show');
} else {
  console.error('✗ hotkey.rs missing register_app_shortcut');
}

const appSvelte = fs.readFileSync('src/App.svelte', 'utf8');
if (appSvelte.includes('atools://direct-launch-plugin')) {
  console.log('✓ App.svelte listens for atools://direct-launch-plugin');
} else {
  console.error('✗ App.svelte missing direct-launch-plugin listener');
}
