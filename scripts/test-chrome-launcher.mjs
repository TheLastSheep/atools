import { launchChrome } from './chrome-cdp-smoke-utils.mjs';

async function test() {
  console.log('Launching headless Chrome via CDP...');
  const chrome = await launchChrome();
  console.log('Chrome launched successfully! WS URL:', chrome.webSocketUrl);
  await chrome.close();
  console.log('Chrome closed.');
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
