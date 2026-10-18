// Copied from sevenup-tiles/scripts/lib/tile-record.js (Oct 18), unchanged.
// Building and publishing a Web Tile record, the way the Foundry does it
// (web-tile-foundry/src/core/publish.js: buildManifest, buildRecord, parseMimeMismatch, and its rules).
//   - Always CREATE a new record (server-assigned key); never overwrite one. validate: false (the PDS
//     doesn't know ing.dasl.masl).
//   - Upload each file, check the address the server reports against the one computed here.
//   - Use the file type the server reports in each blob reference; compute the manifest's address only
//     after uploading.
//   - If the same bytes were once stored under another type, createRecord fails with InvalidMimeType
//     ("Expected: X, Got: Y"): adopt X for those files, recompute, retry once.
//   - Read the record and every file back and check them.
import { rawCid } from './cid.js';
import { dagCborCid } from './dagcbor.js';

export const TILE_COLLECTION = 'ing.dasl.masl';

export function parseMimeMismatch(message) {
  const m = /Expected:\s*([^,\s]+)\s*,\s*Got:\s*([^\s,]+)/i.exec(message || '');
  return m ? { expected: m[1], got: m[2] } : null;
}

// The manifest. `tile`: { name, description, sizing, generator, csp, files }; blobRefs by path.
export function buildManifest(tile, blobRefs) {
  const resources = {};
  for (const f of tile.files) {
    const entry = { src: blobRefs[f.path], 'content-type': f.contentType };
    if (f.path === '/') entry['content-security-policy'] = tile.csp;
    resources[f.path] = entry;
  }
  const manifest = { name: tile.name };
  if (tile.description) manifest.description = tile.description;
  manifest.icons = [{ src: '/icon.png' }];
  manifest.screenshots = [{ src: '/banner.png' }];
  if (tile.sizing) manifest.sizing = tile.sizing;
  if (tile.generator) manifest.generator = tile.generator;
  manifest.resources = resources;
  return manifest;
}

export async function buildRecord(manifest, createdAt) {
  return { $type: TILE_COLLECTION, cid: await dagCborCid(manifest), tile: manifest, createdAt };
}

function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJson(a[k], b[k]));
}

// xrpc(nsid, { method, params, body, contentType }) → parsed JSON or throws { status, error, message }.
// fetchBlob(cid) → bytes. Returns { uri, rkey, cid (the record's), manifestCid, record }.
export async function publishTile({ xrpc, fetchBlob, did, tile, now = () => new Date().toISOString(), log = () => {} }) {
  const blobRefs = {};
  for (const f of tile.files) {
    f.cid = f.cid || await rawCid(f.bytes);
    const res = await xrpc('com.atproto.repo.uploadBlob', { method: 'POST', body: f.bytes, contentType: f.contentType });
    const blob = res && res.blob;
    const link = blob && blob.ref && blob.ref.$link;
    if (link !== f.cid) throw new Error(`The server stored ${f.path} under a different address than expected (${link || 'none'} instead of ${f.cid}).`);
    blobRefs[f.path] = { $type: 'blob', ref: { $link: link }, mimeType: blob.mimeType, size: blob.size ?? f.bytes.length };
    log(`  uploaded ${f.path} (${(f.bytes.length / 1024).toFixed(1)} KB)`);
  }
  const createdAt = now();
  let manifest = buildManifest(tile, blobRefs);
  let record = await buildRecord(manifest, createdAt);
  let created;
  for (let attempt = 1; ; attempt++) {
    try {
      created = await xrpc('com.atproto.repo.createRecord', { method: 'POST', body: { repo: did, collection: TILE_COLLECTION, record, validate: false } });
      break;
    } catch (err) {
      const mismatch = err && err.error === 'InvalidMimeType' ? parseMimeMismatch(err.message) : null;
      if (attempt === 1 && mismatch) {
        let changed = 0;
        for (const ref of Object.values(blobRefs)) if (ref.mimeType === mismatch.got) { ref.mimeType = mismatch.expected; changed++; }
        if (changed) { manifest = buildManifest(tile, blobRefs); record = await buildRecord(manifest, createdAt); continue; }
      }
      throw new Error(`Creating the tile record failed: ${err.message}`);
    }
  }
  const rkey = created.uri.split('/').pop();
  const back = await xrpc('com.atproto.repo.getRecord', { method: 'GET', params: { repo: did, collection: TILE_COLLECTION, rkey } });
  if (!sameJson(back.value, record)) throw new Error("The tile was created, but what the server returned doesn't match what was sent.");
  if (back.cid !== created.cid) throw new Error('The tile was created, but its record address changed on reading it back.');
  for (const f of tile.files) {
    if ((await rawCid(await fetchBlob(f.cid))) !== f.cid) throw new Error(`The tile was created, but ${f.path} didn't come back intact.`);
  }
  return { uri: created.uri, rkey, cid: created.cid, manifestCid: record.cid, record };
}

// The record type's definition (lexicon), published as com.atproto.lexicon.schema with its id as key.
export async function publishLexicon({ xrpc, did, lexicon }) {
  const record = { $type: 'com.atproto.lexicon.schema', ...lexicon };
  const put = await xrpc('com.atproto.repo.putRecord', { method: 'POST', body: { repo: did, collection: 'com.atproto.lexicon.schema', rkey: lexicon.id, record } });
  return { uri: put.uri, cid: put.cid };
}
