import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchChrome, connectToTarget, cdpSend } from './chrome-cdp-smoke-utils.mjs';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.wasm', 'application/wasm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
]);

function createPluginServer(pluginsRoot, port = 18888) {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const parsed = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const decodedPath = decodeURIComponent(parsed.pathname || '/');
      const cleanPath = decodedPath.replace(/^\/+/, '');
      const filePath = path.resolve(pluginsRoot, cleanPath);

      if (!filePath.startsWith(path.resolve(pluginsRoot))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      let stat = fs.statSync(filePath);
      let targetFile = filePath;
      if (stat.isDirectory()) {
        targetFile = path.join(filePath, 'index.html');
        if (!fs.existsSync(targetFile)) {
          res.writeHead(404);
          res.end('Index Not Found');
          return;
        }
        stat = fs.statSync(targetFile);
      }

      const ext = path.extname(targetFile).toLowerCase();
      const mime = MIME_TYPES.get(ext) || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
      });
      fs.createReadStream(targetFile).pipe(res);
    } catch (err) {
      res.writeHead(500);
      res.end(err.message);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

export { createPluginServer };
