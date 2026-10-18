// dice.js: Daisy's glazes and its commit-reveal dice (a hash chain).
//
// How the dice work (decided Oct 18 2026; claude/daisy-plan.md section 13):
// - Each house makes a secret random seed and hashes it CHAIN_LENGTH times: h0 = seed, h1 = H(h0), …,
//   hL = H(hL-1). It shares only hL, its commitment.
// - Roll n (the coin is roll 0, the die rolls are 1, 2, …) reveals one link from each player, walking
//   back down the chain: the first roll of a chain reveals hL-1, the next hL-2, and so on. Anyone checks
//   a reveal by hashing it once: it must give the commitment, or the same player's previous reveal.
// - The value is SHA-256 over the match id, the roll number and both reveals, read fairly as 1 to 6 (or
//   as heads/tails for the coin). Once both commitments are out, every roll is fixed but unknown to both.
// - A chain that runs out is followed by a fresh pair of commitments, exchanged before either new link
//   is revealed (rechaining; not expected at a target of 25).
import { sha256, toHex, fromHex, isHex, utf8 } from './sha256.js';

export const CHAIN_LENGTH = 1000;         // links per chain: far more rolls than a game to 25 needs
export const MAX_WALK = 100000;           // a record checker walks at most this far along a chain

// The six glazes: Seven-Up's set with Casino dropped and Marigold added (owner, Oct 17). Starting
// colours from the Oct 17 mockup; tuned under real lighting in step 3.
export const GLAZES = [
  { id: 'bone', name: 'Bone', face: '#EFE6D2', pip: '#2B2622' },
  { id: 'jade', name: 'Jade', face: '#5E9C86', pip: '#F4F1E6' },
  { id: 'midnight', name: 'Midnight', face: '#1E2340', pip: '#E8E4D4' },
  { id: 'glow', name: 'Glow', face: '#D9F26A', pip: '#2F3A12' },
  { id: 'brick', name: 'Brick', face: '#A8432E', pip: '#F6E9D8' },
  { id: 'marigold', name: 'Marigold', face: '#F2B233', pip: '#3B2A10' },
];
export const GLAZE_IDS = GLAZES.map((g) => g.id);
export const glazeById = (id) => GLAZES.find((g) => g.id === id) || null;

export const isLink = (x) => isHex(x, 64);

// One step up a chain.
export const link = (hex) => toHex(sha256(fromHex(hex)));

// A fresh 32-byte seed, as hex. randomBytes(n) gives n strong random bytes (the browser's
// crypto.getRandomValues in a tile; tests may pass their own).
export function newSeed(randomBytes = defaultRandomBytes) {
  const b = randomBytes(32);
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error('randomBytes must give 32 bytes');
  return toHex(b);
}
export function defaultRandomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

// The whole chain [h0 … hL] for a seed. Kept for the few seeds in use (a house holds one or two).
const memo = new Map();
export function chainOf(seed, length = CHAIN_LENGTH) {
  const key = `${length}:${seed}`;
  let chain = memo.get(key);
  if (!chain) {
    if (!isLink(seed)) throw new Error('a seed is 64 hex characters');
    chain = [seed];
    for (let i = 0; i < length; i++) chain.push(link(chain[i]));
    if (memo.size >= 8) memo.delete(memo.keys().next().value);
    memo.set(key, chain);
  }
  return chain;
}
export const commitmentOf = (seed, length = CHAIN_LENGTH) => chainOf(seed, length)[length];

// The link revealed for the j-th roll of a chain (j = 0 for its first roll). null once it has run out.
export function revealAt(seed, length, j) {
  if (!Number.isInteger(j) || j < 0 || j >= length) return null;
  return chainOf(seed, length)[length - 1 - j];
}

// A reveal is good when hashing it once gives the link before it (the commitment, or that player's
// previous reveal on the same chain).
export const checkReveal = (before, reveal) => isLink(before) && isLink(reveal) && link(reveal) === before;

// ---- turning reveals into a die or a coin ----

// A fair 1 to 6 from some bytes: the first byte under 252 (= 42 × 6), mod 6. Bytes of 252 and over are
// skipped so every face is exactly equally likely. null if every byte is 252 or over.
export function fairFace(bytes) {
  for (const b of bytes) if (b < 252) return (b % 6) + 1;
  return null;
}

function hashOf(parts) {
  return sha256(utf8(parts.join('|')));
}

// The die for roll n (n ≥ 1). r1, r2: seat 1's and seat 2's reveals for this roll.
export function dieFrom(matchId, n, r1, r2) {
  let bytes = hashOf(['daisy', 'roll', matchId, String(n), r1, r2]);
  for (;;) {                                        // all 32 bytes ≥ 252: odds about 1 in 10^57
    const face = fairFace(bytes);
    if (face) return face;
    bytes = sha256(bytes);
  }
}

// The coin (roll 0): which seat starts, 1 or 2.
export function coinFrom(matchId, r1, r2) {
  return (hashOf(['daisy', 'coin', matchId, r1, r2])[0] & 1) + 1;
}

// For a record checker: starting from the last link a player revealed on a chain, hash forward until
// the commitment. Returns the reveals in roll order (first roll's link first), or null if the
// commitment isn't reached within max steps.
export function revealsFrom(lastReveal, commitment, max = MAX_WALK) {
  if (!isLink(lastReveal) || !isLink(commitment)) return null;
  const walk = [lastReveal];
  let x = lastReveal;
  for (let i = 0; i < max; i++) {
    x = link(x);
    if (x === commitment) return walk.reverse();
    walk.push(x);
  }
  return null;
}
