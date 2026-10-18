import test from 'node:test';
import assert from 'node:assert/strict';
import { quat, restFor, showing, isView, IDLE, Z_HOME, Z_MIN, Z_MAX, lightingFor, SHIMMER_CAP } from '../player/die3d.js';
import { GLAZES } from '../shared/dice.js';

test('the die rests showing the value it was given, whatever its quarter-turn twist', () => {
  for (let v = 1; v <= 6; v++) for (let spin = 0; spin < 4; spin++) assert.equal(showing(restFor(v, spin)), v, `value ${v}, twist ${spin}`);
});

test('opposite faces add up to 7', () => {
  const FACE_VALUES = [3, 4, 2, 5, 1, 6];                       // faces +X, -X, +Y, -Y, +Z, -Z
  for (let i = 0; i < 6; i += 2) assert.equal(FACE_VALUES[i] + FACE_VALUES[i + 1], 7);
});

test('quaternion helpers: slerp ends where it should, rotations are unit, between maps vectors', () => {
  const a = quat.axisAngle([0, 1, 0], 0.3), b = quat.axisAngle([1, 1, 0], 2.1);
  assert.deepEqual(quat.slerp(a, b, 0).map((x) => +x.toFixed(6)), a.map((x) => +x.toFixed(6)));
  assert.deepEqual(quat.slerp(a, b, 1).map((x) => +x.toFixed(6)), b.map((x) => +x.toFixed(6)));
  for (const t of [0.1, 0.5, 0.9]) assert.ok(Math.abs(Math.hypot(...quat.slerp(a, b, t)) - 1) < 1e-9);
  for (const [u, v] of [[[1, 0, 0], [0, 0, 1]], [[0, 0, -1], [0, 0, 1]], [[0, 1, 0], [0, 0, 1]]]) {
    const r = quat.rotate(quat.between(u, v), u);
    assert.ok(Math.hypot(r[0] - v[0], r[1] - v[1], r[2] - v[2]) < 1e-9, `${u} → ${v}`);
  }
});

test('a shared view is checked before it is shown (unit orientation, zoom in range)', () => {
  assert.ok(isView({ q: restFor(3, 1), z: Z_HOME }));
  assert.ok(!isView({ q: [0, 0, 0, 2], z: Z_HOME }));
  assert.ok(!isView({ q: restFor(3, 1), z: Z_MAX + 1 }));
  assert.ok(!isView({ q: restFor(3, 1), z: Z_MIN - 1 }));
  assert.ok(!isView({ q: [NaN, 0, 0, 1], z: Z_HOME }));
  assert.ok(!isView(null));
});

test('before any roll the die shows a corner: three faces turned equally toward the viewer, none clearly in front', () => {
  const N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const zs = N.map((n) => quat.rotate(IDLE, n)[2]).sort((a, b) => b - a);
  assert.ok(Math.abs(zs[0] - zs[2]) < 0.01, zs.join(','));
  // At rest after a roll, the face that counts is well in front of the others.
  for (let v = 1; v <= 6; v++) {
    const z = N.map((n) => quat.rotate(restFor(v, 1), n)[2]).sort((a, b) => b - a);
    assert.ok(z[0] > 0.9 && z[1] < 0.35, `value ${v}: ${z.slice(0, 2)}`);
  }
});

test('each glaze is lit by its lightness: dark glazes brighter with a stronger shimmer, light ones never dimmed', () => {
  const L = Object.fromEntries(GLAZES.map((g) => [g.id, lightingFor(g)]));
  for (const g of GLAZES) {
    assert.ok(L[g.id].gain >= 1 && L[g.id].gain <= 1.5, g.id);
    assert.ok(L[g.id].shimmerStrength >= 0.45 && L[g.id].shimmerStrength <= SHIMMER_CAP, g.id);
  }
  assert.equal(L.midnight.gain, 1.5);
  assert.ok(L.midnight.gain > L.brick.gain && L.brick.gain > L.jade.gain && L.jade.gain > 1);
  for (const id of ['bone', 'glow', 'marigold']) assert.ok(L[id].gain < 1.01, id);   // about as before
  assert.ok(L.bone.shimmerStrength < L.marigold.shimmerStrength && L.marigold.shimmerStrength < L.brick.shimmerStrength);
  assert.equal(L.brick.shimmerStrength, SHIMMER_CAP);
});
