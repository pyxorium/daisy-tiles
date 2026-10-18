// COPY of web-tile-foundry/src/core/dagcbor.js (tested there), so published Daisy tiles (as Seven-Up's) get exactly the
// addresses the Foundry computes. Keep in step with it.

import { base32Lower, sha256 } from "./cid.js";

// DAG-CBOR encoding and the manifest's address.
//
// A Web Tile record carries a `cid` field: the address of its `tile` object
// (the manifest), as a CIDv1 with the dag-cbor codec and a SHA-256 hash.
//
// This follows atile, the official tool (dasl-tiles, @atcute/cbor +
// @atcute/cid): any object of the form { "$link": "<cid>" } is encoded as a
// real CID link (CBOR tag 42), not as a map. See the project note
// manifest-cid-encoding-finding.md; the test suite checks this against the
// known values for the published alice-palette tile.
//
// Kept deliberately small: it handles exactly what manifests contain
// (maps, arrays, strings, whole numbers, booleans, null, CID links).

const CID_V1 = 0x01;
const CODEC_DAG_CBOR = 0x71;
const HASH_SHA2_256 = 0x12;
const SHA2_256_LENGTH = 0x20;

const encoder = new TextEncoder();

export function base32LowerDecode(text) {
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`Not base32: ${JSON.stringify(ch)}`);
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** The bytes of a "b..." CIDv1 string. */
export function cidBytes(cid) {
  if (typeof cid !== "string" || cid[0] !== "b") throw new Error(`Expected a base32 CIDv1 ("b..."), got ${JSON.stringify(cid)}`);
  return base32LowerDecode(cid.slice(1));
}

function head(major, n, out) {
  const m = major << 5;
  if (n < 24) out.push(m | n);
  else if (n < 0x100) out.push(m | 24, n);
  else if (n < 0x10000) out.push(m | 25, n >> 8, n & 0xff);
  else if (n < 0x100000000) out.push(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  else {
    const hi = Math.floor(n / 0x100000000);
    const lo = n >>> 0;
    out.push(m | 27, (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
      (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
  }
}

function pushBytes(out, bytes) {
  for (const b of bytes) out.push(b);
}

function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function encodeValue(value, out, opts) {
  if (value === null) return out.push(0xf6);
  if (value === true) return out.push(0xf5);
  if (value === false) return out.push(0xf4);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`DAG-CBOR here only takes whole numbers, got ${value}`);
    return value >= 0 ? head(0, value, out) : head(1, -1 - value, out);
  }
  if (typeof value === "string") {
    const bytes = encoder.encode(value);
    head(3, bytes.length, out);
    return pushBytes(out, bytes);
  }
  if (value instanceof Uint8Array) {
    head(2, value.length, out);
    return pushBytes(out, value);
  }
  if (Array.isArray(value)) {
    head(4, value.length, out);
    for (const v of value) encodeValue(v, out, opts);
    return undefined;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    // A CID link: exactly { "$link": "<cid>" } becomes CBOR tag 42.
    if (!opts.linksAsMaps && keys.length === 1 && keys[0] === "$link" && typeof value.$link === "string") {
      const link = new Uint8Array([0x00, ...cidBytes(value.$link)]); // multibase identity prefix
      head(6, 42, out);
      head(2, link.length, out);
      return pushBytes(out, link);
    }
    // Map keys in canonical order: shorter encoded key first, then bytewise.
    const entries = keys.map((k) => [encoder.encode(k), value[k]]);
    entries.sort((a, b) => a[0].length - b[0].length || compareBytes(a[0], b[0]));
    head(5, entries.length, out);
    for (const [k, v] of entries) {
      head(3, k.length, out);
      pushBytes(out, k);
      encodeValue(v, out, opts);
    }
    return undefined;
  }
  throw new Error(`Can't encode ${typeof value} as DAG-CBOR.`);
}

// opts.linksAsMaps: encode { "$link" } as an ordinary map instead of a CID
// link. Only for checking against older records made by the project's Python
// scripts (libipld on a JSON dict); new tiles always use real links, like atile.
export function encodeDagCbor(value, opts = {}) {
  const out = [];
  encodeValue(value, out, opts);
  return new Uint8Array(out);
}

/** The dag-cbor CIDv1 address of a value, e.g. a tile's manifest ("bafyrei..."). */
export async function dagCborCid(value, opts = {}) {
  const digest = await sha256(encodeDagCbor(value, opts));
  const bytes = new Uint8Array(4 + digest.length);
  bytes.set([CID_V1, CODEC_DAG_CBOR, HASH_SHA2_256, SHA2_256_LENGTH], 0);
  bytes.set(digest, 4);
  return "b" + base32Lower(bytes);
}
