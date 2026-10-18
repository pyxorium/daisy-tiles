// A stand-in for an account's PDS and plc.directory, as a fetch function, for checking publish.mjs.
// It does what a real one does for these calls: stores blobs under their raw CID (with the type of the
// FIRST upload, like a real PDS), creates records with a fresh key, gives each record a CID, and can be
// told to insist on another stored type (InvalidMimeType), to check the retry.
import { rawCid } from '../scripts/lib/cid.js';
import { dagCborCid } from '../scripts/lib/dagcbor.js';

export const PDS = 'https://pds.test';

export function createFakePds({ did, handle, password = 'right-password', storedTypes = {} } = {}) {
  const blobs = new Map();          // cid → { bytes, mimeType }
  const records = new Map();        // `${collection}/${rkey}` → { value, cid }
  let n = 0;
  const calls = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    calls.push(`${init.method || 'GET'} ${url.pathname}`);
    if (url.origin === 'https://plc.directory') {
      return json(200, { id: did, alsoKnownAs: [`at://${handle}`], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] });
    }
    if (url.origin !== PDS) return json(404, { error: 'NotFound' });
    const nsid = url.pathname.replace('/xrpc/', '');
    const authed = (init.headers || {}).Authorization === 'Bearer fake-jwt';
    switch (nsid) {
      case 'com.atproto.server.createSession': {
        const b = JSON.parse(init.body);
        return b.password === password ? json(200, { did, handle, accessJwt: 'fake-jwt' }) : json(401, { error: 'AuthenticationRequired', message: 'Invalid identifier or password' });
      }
      case 'com.atproto.repo.uploadBlob': {
        if (!authed) return json(401, { error: 'AuthRequired' });
        const bytes = new Uint8Array(init.body);
        const cid = await rawCid(bytes);
        if (!blobs.has(cid)) blobs.set(cid, { bytes, mimeType: storedTypes[cid] || init.headers['Content-Type'] });
        return json(200, { blob: { $type: 'blob', ref: { $link: cid }, mimeType: init.headers['Content-Type'], size: bytes.length } });
      }
      case 'com.atproto.repo.createRecord':
      case 'com.atproto.repo.putRecord': {
        if (!authed) return json(401, { error: 'AuthRequired' });
        const b = JSON.parse(init.body);
        // Like a real PDS: a blob referenced with another type than it was first stored with is refused.
        for (const ref of findBlobs(b.record)) {
          const kept = blobs.get(ref.ref.$link);
          if (kept && kept.mimeType !== ref.mimeType) return json(400, { error: 'InvalidMimeType', message: `Referenced Mimetype does not match stored blob. Expected: ${kept.mimeType}, Got: ${ref.mimeType}` });
        }
        const rkey = b.rkey || `3m${String(++n).padStart(11, 'a')}`;
        const cid = await dagCborCid({ record: b.record, n: ++n });
        records.set(`${b.collection}/${rkey}`, { value: b.record, cid });
        return json(200, { uri: `at://${did}/${b.collection}/${rkey}`, cid });
      }
      case 'com.atproto.repo.getRecord': {
        const r = records.get(`${url.searchParams.get('collection')}/${url.searchParams.get('rkey')}`);
        return r ? json(200, { uri: `at://${did}/${url.searchParams.get('collection')}/${url.searchParams.get('rkey')}`, cid: r.cid, value: r.value }) : json(400, { error: 'RecordNotFound' });
      }
      case 'com.atproto.sync.getBlob': {
        const b = blobs.get(url.searchParams.get('cid'));
        return b ? new Response(b.bytes, { status: 200, headers: { 'content-type': b.mimeType } }) : json(400, { error: 'BlobNotFound' });
      }
    }
    return json(400, { error: 'MethodNotImplemented' });
  }

  function findBlobs(v, out = []) {
    if (v && typeof v === 'object') {
      if (v.$type === 'blob' && v.ref) out.push(v);
      else for (const x of Object.values(v)) findBlobs(x, out);
    }
    return out;
  }

  // Everything stored, as plain JSON (blobs as base64), for the browser checks to serve.
  function dump() {
    return {
      did, handle,
      blobs: Object.fromEntries([...blobs].map(([cid, b]) => [cid, { mimeType: b.mimeType, base64: Buffer.from(b.bytes).toString('base64') }])),
      records: Object.fromEntries([...records].map(([k, r]) => [k, r])),
    };
  }

  return { fetchImpl, blobs, records, calls, dump };
}
