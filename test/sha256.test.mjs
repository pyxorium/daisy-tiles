import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha256, sha256Hex, toHex, fromHex, utf8, isHex } from '../shared/sha256.js';

// The standard test values (FIPS 180-2 examples and the NIST short/long messages).
const VECTORS = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ['abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu', 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'],
  ['a'.repeat(1000000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
];

test('sha256 gives the standard test values', () => {
  for (const [text, want] of VECTORS) assert.equal(sha256Hex(utf8(text)), want, `${text.slice(0, 20)}… (${text.length})`);
});

test('sha256 matches Node\'s own hash at every length around the block edges, and on random input', () => {
  for (let len = 0; len <= 200; len++) {
    const b = randomBytes(len);
    assert.equal(toHex(sha256(new Uint8Array(b))), createHash('sha256').update(b).digest('hex'), `length ${len}`);
  }
  for (let k = 0; k < 300; k++) {
    const b = randomBytes(Math.floor(Math.random() * 5000));
    assert.equal(sha256Hex(new Uint8Array(b)), createHash('sha256').update(b).digest('hex'));
  }
});

test('hex helpers', () => {
  const b = new Uint8Array([0, 1, 15, 16, 255]);
  assert.equal(toHex(b), '00010f10ff');
  assert.deepEqual(fromHex('00010f10ff'), b);
  assert.throws(() => fromHex('ABCD'));
  assert.throws(() => fromHex('abc'));
  assert.ok(isHex('ab'.repeat(32), 64));
  assert.ok(!isHex('AB'.repeat(32), 64));
  assert.throws(() => sha256('abc'));
});
