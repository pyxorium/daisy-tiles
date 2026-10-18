// tid.js: match ids are TIDs (atproto's timestamp ids, also the saved record's key).
// COPY of newId / isTid / tidTime from C:\thunderbird-cafe\sevenup-tiles\house\rules.js (Oct 17 2026).
// 64 bits, the top one 0, then the time in microseconds since 1970 (53 bits), then a random 10-bit
// clock id; written as 13 base32-sortable characters (the first one 2 to j).

export const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';
export const isTid = (x) => typeof x === 'string' && /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(x);

export function newTid(nowMs = Date.now(), cryptoImpl = globalThis.crypto) {
  const r = new Uint16Array(1);
  cryptoImpl.getRandomValues(r);
  const micros = BigInt(Math.floor(nowMs * 1000)) & ((1n << 53n) - 1n);
  let n = (micros << 10n) | BigInt(r[0] & 1023);
  let out = '';
  for (let i = 0; i < 13; i++) { out = TID_ALPHABET[Number(n & 31n)] + out; n >>= 5n; }
  return out;
}

// When a TID was made (ms since 1970), or null.
export function tidTime(id) {
  if (!isTid(id)) return null;
  let n = 0n;
  for (const ch of id) n = (n << 5n) | BigInt(TID_ALPHABET.indexOf(ch));
  return Number(n >> 10n) / 1000;
}
