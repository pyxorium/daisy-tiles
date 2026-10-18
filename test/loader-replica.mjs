// COPY of C:\thunderbird-cafe\sevenup-tiles\test\loader-replica.mjs (Oct 18 2026), for Daisy's browser checks.
// A local stand-in for the tile loading server, for the browser checks. It serves the real server's own
// files (shuttle.js, worker.js, data.js, index.html from a copy of tiles-loading-server/public) with the
// same headers as its index.js, and sends load.<base> to a fresh random name <name>.<base>, as
// load.tiles.lexicographer.space does. Here <base> is tiles.lex.localhost, so names are on *.localhost,
// which browsers treat as secure (service workers need that) and resolve to this computer.
//
// Usage: node test/loader-replica.mjs <tiles-loading-server folder> [port, default 80]
// (Port 80 because the real server's redirect leaves the port out, as it should on the internet.)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const serverDir = process.argv[2];
const port = Number(process.argv[3]) || 80;
if (!serverDir) { console.error('Usage: node test/loader-replica.mjs <tiles-loading-server folder> [port]'); process.exit(1); }
const { randomName } = await import(pathToFileURL(join(serverDir, 'hosts.js')).href);   // the real name maker
const BASE = 'tiles.lex.localhost';
const PUBLIC = join(serverDir, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

// Copied from tiles-loading-server/index.js (keep in step with it).
const HEADERS = {
  'service-worker-allowed': '/',
  'origin-agent-cluster': '?1',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'interest-cohort=(), browsing-topics=()',
  'cross-origin-resource-policy': 'cross-origin',
  'cross-origin-opener-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-dns-prefetch-control': 'off',
  'content-security-policy': [
    `default-src 'self' blob: data:`,
    `script-src 'self' blob: data: 'unsafe-inline' 'wasm-unsafe-eval'`,
    `script-src-attr 'none'`,
    `style-src 'self' blob: data: 'unsafe-inline'`,
    `form-src 'self'`,
    `manifest-src 'none'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `sandbox allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts`,
  ].join('; '),
  'tk': 'N',
  'x-robots-tag': 'noai, noimageai',
};

export const counts = { redirects: 0, files: 0 };
createServer(async (req, res) => {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (host === `load.${BASE}`) {
    counts.redirects++;
    res.writeHead(303, { Location: `http://${randomName()}.${BASE}${req.url}` });
    return res.end();
  }
  const path = new URL(req.url, 'http://x').pathname;
  const PREFIX = '/.well-known/web-tiles/';
  if (!host.endsWith(`.${BASE}`) || !path.startsWith(PREFIX)) { res.writeHead(404); return res.end(); }
  let rel = path.slice(PREFIX.length) || 'index.html';
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    counts.files++;
    res.writeHead(200, { ...HEADERS, 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
}).listen(port, '127.0.0.1', () => console.log(`loader replica on http://load.${BASE}:${port}/`));
