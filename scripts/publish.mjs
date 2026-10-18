// Publishes the two Daisy tiles (house and player) and the match record's lexicon from the
// thunderbird.cafe account. Run once from the daisy-tiles folder (Node 22, no packages needed):
//
//   node scripts/publish.mjs              publish whatever isn't published yet
//   node scripts/publish.mjs --dry-run    show what would be published; ask nothing, write nothing
//   node scripts/publish.mjs --again      publish the tiles again, as new records (new addresses)
//
// It shows what will be published, asks for the account's app password (hidden as you type) and once
// more before writing. Tiles are always created as new records (never overwriting); the lexicon is put
// under its own name. What was published is written to published.json, which copy-to-site.mjs reads.
import readline from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, TILES, publishFiles, cspOf } from './tiles.mjs';
import { rawCid } from './lib/cid.js';
import { publishTile, publishLexicon } from './lib/tile-record.js';

export const ACCOUNT = 'did:plc:6vxjigxrqizmbo56gojxico3';     // thunderbird.cafe
export const LEXICON_FILE = join(ROOT, 'lexicons', 'cafe.thunderbird.daisy.match.json');
export const PUBLISHED_FILE = join(ROOT, 'published.json');
const GENERATOR = 'Daisy';

async function getJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const err = new Error((body && (body.message || body.error)) || `Request failed (${res.status})`);
    err.status = res.status; err.error = body && body.error;
    throw err;
  }
  return body;
}

export async function tileToPublish(id) {
  const files = publishFiles(id);
  for (const f of files) f.cid = await rawCid(f.bytes);
  const page = new TextDecoder().decode(files.find((f) => f.path === '/').bytes);
  const t = TILES[id];
  return { id, name: t.name, description: t.description, sizing: t.sizing, generator: GENERATOR, csp: cspOf(page), files };
}

export async function runPublish({ fetchImpl = fetch, ask, askHidden, log = console.log, dryRun = false, again = false,
  readPublished = () => (existsSync(PUBLISHED_FILE) ? JSON.parse(readFileSync(PUBLISHED_FILE, 'utf8')) : {}),
  writePublished = (o) => writeFileSync(PUBLISHED_FILE, JSON.stringify(o, null, 2) + '\n'),
  lexicon = JSON.parse(readFileSync(LEXICON_FILE, 'utf8')), now = () => new Date().toISOString() }) {
  const doc = await getJson(fetchImpl, `https://plc.directory/${ACCOUNT}`);
  const svc = (doc.service || []).find((s) => s.type === 'AtprotoPersonalDataServer' || String(s.id).endsWith('#atproto_pds'));
  if (!svc) throw new Error('Could not find the account\'s server.');
  const pds = String(svc.serviceEndpoint).replace(/\/+$/, '');
  const aka = (doc.alsoKnownAs || []).find((a) => a.startsWith('at://'));
  const handle = aka ? aka.slice(5) : ACCOUNT;

  const published = readPublished() || {};
  const todo = [];
  for (const id of ['house', 'player']) if (again || !published[id]) todo.push(await tileToPublish(id));
  const lexiconDue = !published.lexicon || published.lexicon.text !== JSON.stringify(lexicon);

  log(`\nAccount: @${handle} (${ACCOUNT}), server ${pds}`);
  if (!todo.length && !lexiconDue) { log('\nEverything is already published (see published.json). Use --again to publish the tiles as new records.'); return { changed: false, published }; }
  log('\nThis will publish:');
  for (const t of todo) {
    const kb = t.files.reduce((n, f) => n + f.bytes.length, 0) / 1024;
    log(`  - a new tile "${t.name}": ${t.files.length} files, ${kb.toFixed(1)} KB (${t.files.map((f) => f.path).join(' ')})`);
  }
  if (lexiconDue) log(`  - the lexicon ${lexicon.id} (record type definition), as com.atproto.lexicon.schema/${lexicon.id}`);
  log('All of it is public. Nothing else in the account is touched.');
  if (dryRun) { log('\nDry run: nothing was written.'); return { changed: false, plan: todo, lexiconDue }; }

  const password = await askHidden(`\nApp password for @${handle} (hidden): `);
  if (!password) throw new Error('No app password given; nothing was published.');
  const session = await getJson(fetchImpl, `${pds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: ACCOUNT, password }),
  });
  if (session.did !== ACCOUNT) throw new Error('That app password belongs to a different account; nothing was published.');
  const auth = { Authorization: `Bearer ${session.accessJwt}` };
  const ok = (await ask('Publish now? [y/N] ')).trim().toLowerCase();
  if (ok !== 'y' && ok !== 'yes') { log('Stopped; nothing was published.'); return { changed: false }; }

  const xrpc = async (nsid, { method, params, body, contentType }) => {
    const url = new URL(`${pds}/xrpc/${nsid}`);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    const bytes = body instanceof Uint8Array;
    return getJson(fetchImpl, url.toString(), {
      method, headers: { ...auth, ...(body !== undefined ? { 'Content-Type': bytes ? contentType : 'application/json' } : {}) },
      body: body === undefined ? undefined : bytes ? body : JSON.stringify(body),
    });
  };
  const fetchBlob = async (cid) => {
    const res = await fetchImpl(`${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(ACCOUNT)}&cid=${encodeURIComponent(cid)}`);
    if (!res.ok) throw new Error(`Reading back ${cid} failed (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  };

  const out = { ...published, account: ACCOUNT, handle };
  for (const t of todo) {
    log(`\nPublishing "${t.name}"…`);
    const r = await publishTile({ xrpc, fetchBlob, did: ACCOUNT, tile: t, now, log });
    out[t.id] = { uri: r.uri, cid: r.cid, manifestCid: r.manifestCid, publishedAt: r.record.createdAt };
    writePublished(out);                                 // kept after each tile, in case a later step fails
    log(`  done: ${r.uri}`);
  }
  if (lexiconDue) {
    log(`\nPublishing the lexicon ${lexicon.id}…`);
    const r = await publishLexicon({ xrpc, did: ACCOUNT, lexicon });
    out.lexicon = { uri: r.uri, cid: r.cid, text: JSON.stringify(lexicon) };
    writePublished(out);
    log(`  done: ${r.uri}`);
  }
  log('\nAll published, and read back to check. Next:');
  log('  1. node scripts/copy-to-site.mjs C:\\thunderbird-cafe\\pyxorium.github.io   (points the table at these tiles)');
  log(`  2. At Wix, add a TXT record: host _lexicon.daisy  value did=${ACCOUNT}`);
  log('  3. Delete this app password (Bluesky: Settings > Privacy and security > App passwords).');
  return { changed: true, published: out };
}

function makeAsk() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => { if (!muted || s.includes('\n')) write(muted ? '\n' : s); };
  const ask = (q) => new Promise((r) => rl.question(q, r));
  const askHidden = (q) => new Promise((r) => { process.stdout.write(q); muted = true; rl.question('', (a) => { muted = false; r(a.trim()); }); });
  return { ask, askHidden, close: () => rl.close() };
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const args = process.argv.slice(2);
  const io = makeAsk();
  runPublish({ ask: io.ask, askHidden: io.askHidden, dryRun: args.includes('--dry-run'), again: args.includes('--again') })
    .catch((err) => { console.error(`\n${err.message}`); process.exitCode = 1; })
    .finally(() => io.close());
}
