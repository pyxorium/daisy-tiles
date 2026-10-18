import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  GLAZES, GLAZE_IDS, glazeById, link, newSeed, chainOf, commitmentOf, revealAt, checkReveal,
  fairFace, dieFrom, coinFrom, revealsFrom, isLink,
} from '../shared/dice.js';
import { prng } from './table-sim.mjs';

const r = prng(7);
const seedFrom = () => newSeed((n) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256)));

// Chi-square for six equally likely faces: 5 degrees of freedom; 20.5 is the 0.1% point.
function chi(counts) {
  const n = counts.reduce((a, b) => a + b, 0), e = n / counts.length;
  return counts.reduce((a, c) => a + (c - e) ** 2 / e, 0);
}

test('six glazes: Bone, Jade, Midnight, Glow, Brick, Marigold (no Casino), each with a face and pips', () => {
  assert.deepEqual(GLAZE_IDS, ['bone', 'jade', 'midnight', 'glow', 'brick', 'marigold']);
  for (const g of GLAZES) { assert.match(g.face, /^#[0-9A-F]{6}$/); assert.match(g.pip, /^#[0-9A-F]{6}$/); }
  assert.equal(glazeById('marigold').pip, '#3B2A10');
  assert.equal(glazeById('casino'), null);
});

test('a chain: each link is the SHA-256 of the one below; the commitment is the top', () => {
  const seed = seedFrom();
  const chain = chainOf(seed, 10);
  assert.equal(chain.length, 11);
  assert.equal(chain[0], seed);
  for (let i = 1; i <= 10; i++) assert.equal(chain[i], createHash('sha256').update(Buffer.from(chain[i - 1], 'hex')).digest('hex'));
  assert.equal(commitmentOf(seed, 10), chain[10]);
  // Reveals walk down: the first roll reveals the link just below the commitment.
  assert.equal(revealAt(seed, 10, 0), chain[9]);
  assert.equal(revealAt(seed, 10, 9), chain[0]);
  assert.equal(revealAt(seed, 10, 10), null);                     // the chain has run out
  assert.ok(checkReveal(chain[10], chain[9]));
  assert.ok(checkReveal(chain[9], chain[8]));
  assert.ok(!checkReveal(chain[10], chain[8]));                   // skipping a link doesn't check
  assert.ok(!checkReveal(chain[9], chain[10]));                   // nor going up
  assert.ok(!checkReveal(chain[10], 'zz'));
  assert.equal(link(chain[3]), chain[4]);
});

test('from a last reveal, hashing forward rebuilds every reveal up to the commitment', () => {
  const seed = seedFrom();
  const L = 50, c = commitmentOf(seed, L);
  const used = 7;                                                 // rolls 0..6 revealed
  const walk = revealsFrom(revealAt(seed, L, used - 1), c);
  assert.equal(walk.length, used);
  for (let j = 0; j < used; j++) assert.equal(walk[j], revealAt(seed, L, j));
  assert.equal(revealsFrom(seedFrom(), c, 1000), null);          // a link from another chain never gets there
  assert.equal(revealsFrom(c, c), null);                          // the commitment itself isn't a reveal
});

test('a fair face: every first byte under 252 gives each face exactly 42 times; 252 and over are skipped', () => {
  const counts = [0, 0, 0, 0, 0, 0];
  for (let b = 0; b < 256; b++) {
    const f = fairFace([b]);
    if (b >= 252) assert.equal(f, null);
    else counts[f - 1]++;
  }
  assert.deepEqual(counts, [42, 42, 42, 42, 42, 42]);
  assert.equal(fairFace([255, 253, 6]), 1);                       // skips to the next byte
});

test('the die is even across 1 to 6, and the coin across both seats', () => {
  const counts = [0, 0, 0, 0, 0, 0];
  let seat1 = 0;
  const N = 60000;
  for (let n = 1; n <= N; n++) {
    const a = seedFrom(), b = seedFrom();
    counts[dieFrom('3my5klkhg227s', n, a, b) - 1]++;
    if (coinFrom('3my5klkhg227s', a, b) === 1) seat1++;
  }
  assert.ok(chi(counts) < 20.5, `chi-square ${chi(counts).toFixed(1)} for ${counts}`);
  assert.ok(Math.abs(seat1 - N / 2) < 4 * Math.sqrt(N / 4), `coin ${seat1} of ${N}`);
});

test('the die depends on the match, the roll number and both reveals', () => {
  const a = seedFrom(), b = seedFrom();
  const base = [];
  for (let n = 1; n <= 40; n++) base.push(dieFrom('3my5klkhg227s', n, a, b));
  const differs = (f) => base.some((v, i) => f(i + 1) !== v);
  assert.ok(differs((n) => dieFrom('3my5klkhg222h', n, a, b)), 'match id');
  assert.ok(differs((n) => dieFrom('3my5klkhg227s', n + 1, a, b)), 'roll number');
  assert.ok(differs((n) => dieFrom('3my5klkhg227s', n, b, a)), 'whose reveal is whose');
  assert.ok(differs((n) => dieFrom('3my5klkhg227s', n, a, seedFrom())), 'the other reveal');
  assert.equal(dieFrom('3my5klkhg227s', 5, a, b), base[4]);       // and nothing else
});

test('seeds are 32 random bytes as hex', () => {
  const s = newSeed();
  assert.ok(isLink(s));
  assert.notEqual(newSeed(), s);
  assert.throws(() => newSeed(() => new Uint8Array(16)));
});
