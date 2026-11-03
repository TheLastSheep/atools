import fs from 'node:fs';
import path from 'node:path';

// Let's create a runnable server for Pasteboard shelf preview
const builtinClipboardDir = '/Users/harris/Desktop/atools/resources/plugins/builtin/clipboard';
console.log('Builtin clipboard files:', fs.readdirSync(builtinClipboardDir));
