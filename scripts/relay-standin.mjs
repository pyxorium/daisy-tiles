// A stand-in for Daisy's relay, for testing on this computer: two pages (two browser windows) play
// through it. It speaks plain WebSockets, like the real relay will (step 5, on Fly.io), so the page's
// connection code doesn't change. The rules are in relay/tables.js; this file is only the network.
// No packages needed: the WebSocket handshake and frames are done here by hand (text frames only).
//
// Usage:  node scripts/relay-standin.mjs [port, default 8787]
// Then the page on http://127.0.0.1:4321/webtiles/daisy/ finds it at ws://127.0.0.1:8787/.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../relay/tables.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function startRelay({ port = 8787, host = '127.0.0.1', log = () => {} } = {}) {
  const relay = createRelay();
  const sockets = new Set();
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
    res.end(`Daisy stand-in relay: ${JSON.stringify(relay.stats())}\n`);
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    sockets.add(socket);
    relay.open(socket);
    log('open');
    let buf = Buffer.alloc(0), parts = [];
    const deliver = (out) => { for (const { conn, msg } of out) sendText(conn, JSON.stringify(msg)); };
    const done = () => {
      if (!sockets.delete(socket)) return;
      deliver(relay.close(socket));
      log('close');
    };
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const f = readFrame(buf);
        if (!f) break;
        buf = buf.subarray(f.length);
        if (f.op === 8) { try { socket.end(Buffer.from([0x88, 0])); } catch {} done(); return; }
        if (f.op === 9) { writeFrame(socket, 10, f.payload); continue; }      // ping → pong
        if (f.op === 10) continue;
        if (f.op === 1 || f.op === 0) {
          parts.push(f.payload);
          if (!f.fin) continue;
          const text = Buffer.concat(parts).toString('utf8');
          parts = [];
          deliver(relay.receive(socket, text));
        } else { socket.destroy(); done(); return; }
        if (buf.length > 1024 * 1024) { socket.destroy(); done(); return; }
      }
    });
    socket.on('close', done);
    socket.on('error', done);
  });
  const sweeper = setInterval(() => relay.sweep(), 60 * 1000);
  return new Promise((resolve) => server.listen(port, host, () => resolve({
    port: server.address().port,
    relay,
    // Stop: drop every connection (as a crash would) and stop listening.
    close: () => new Promise((r) => { clearInterval(sweeper); for (const s of sockets) s.destroy(); server.close(() => r()); }),
  })));
}

function readFrame(buf) {
  if (buf.length < 2) return null;
  const fin = !!(buf[0] & 0x80), op = buf[0] & 0x0f, masked = !!(buf[1] & 0x80);
  let len = buf[1] & 0x7f, at = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); at = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); at = 10; }
  const maskAt = at;
  if (masked) at += 4;
  if (buf.length < at + len) return null;
  const payload = Buffer.from(buf.subarray(at, at + len));
  if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i % 4)];
  return { fin, op, payload, length: at + len };
}
function writeFrame(socket, op, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | op, len])
    : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
  try { socket.write(Buffer.concat([head, payload])); } catch {}
}
const sendText = (socket, text) => writeFrame(socket, 1, Buffer.from(text, 'utf8'));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 8787;
  const verbose = process.argv.includes('--verbose');
  const r = await startRelay({ port, log: verbose ? (w) => console.log(new Date().toISOString(), w) : () => {} });
  console.log(`Daisy stand-in relay on ws://127.0.0.1:${r.port}/  (Ctrl+C stops it)`);
}
