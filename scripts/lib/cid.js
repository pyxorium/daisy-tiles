// COPY of web-tile-foundry/src/core/cid.js (tested there), so published Daisy tiles (as Seven-Up's) get exactly the
// addresses the Foundry computes. Keep in step with it.

// File addresses (CIDs) for tile files.
//
// A file's address is a CIDv1 with the "raw" codec and a SHA-256 hash,
// written as lowercase base32 with a "b" prefix (the familiar "bafkrei...").
// This is the same address a PDS gives a blob, so the Foundry can predict
// each file's address before uploading and check the server's answer after.
//
// Uses WebCrypto only, so it runs unchanged in the browser and in Node 20+.
//
// (The manifest's own dag-cbor address is a separate computation, added in
// the publishing step with @atcute/cbor + @atcute/cid; see
// manifest-cid-encoding-finding.md in the project notes.)

const CID_V1 = 0x01;
const CODEC_RAW = 0x55;
const HASH_SHA2_256 = 0x12;
const SHA2_256_LENGTH = 0x20;

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding (the multibase "b" encoding). */
export function base32Lower(bytes) {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** SHA-256 of the given bytes, as a Uint8Array. */
export async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

/** The raw-codec CIDv1 address of a file's bytes, e.g. "bafkrei...". */
export async function rawCid(bytes) {
  const digest = await sha256(bytes);
  const cidBytes = new Uint8Array(4 + digest.length);
  cidBytes.set([CID_V1, CODEC_RAW, HASH_SHA2_256, SHA2_256_LENGTH], 0);
  cidBytes.set(digest, 4);
  return "b" + base32Lower(cidBytes);
}
