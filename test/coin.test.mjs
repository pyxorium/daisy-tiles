// The coin toss (Raku step 5c, Oct 21 2026): the plan and its timings, the seed from the reveals, the
// house's flip and view, the bot's wait, and the toss itself (the winner's face up for every seed, the
// same toss from the same seed, and the guard keeping the coin in its box).
import test from 'node:test';
import assert from 'node:assert/strict';
import { COIN_TIMINGS, COIN_LOOK, COIN_TOTAL_MS, coinPlan, cleanTimings, tossSeed } from '../shared/coin.js';
import { tossMotion, reachOf, Q, EDGE_LIMIT } from '../player/coin3d.js';
import { SHOW_COIN_MS, BOT_PAUSE_MS, BOT_TURN_START_MS } from '../house/bot.js';
import { coinFrom } from '../house/dice.js';
import { makeSim } from './table-sim.mjs';

const faceUp = (q) => (Q.rot(q, [0, 0, 1])[2] > 0 ? 1 : 2);
const seeds = (n) => Array.from({ length: n }, (_, i) => (Math.imul(i + 1, 2654435761) >>> 0));

test('the plan: the owner\'s timings make a sequence of about 5.2 s; the bot rolls 1.2 s after it', () => {
  const p = coinPlan();
  assert.deepEqual(p.seg.map((s) => s.k), ['still', 'air', 'bounce', 'bounce', 'settle', 'rest', 'handoff']);
  assert.equal(p.landsAt, 300 + 1500);
  assert.ok(Math.abs(p.total - 5184) <= 1, String(p.total));
  assert.equal(COIN_TOTAL_MS, p.total);
  assert.equal(p.restEnds, p.total - COIN_TIMINGS.handoff);
  assert.equal(SHOW_COIN_MS, p.total);
  assert.equal(BOT_PAUSE_MS + BOT_TURN_START_MS, 1200);              // the owner's tuned bot pause
});

test('timings from a message are checked: anything odd falls back to the tuned value', () => {
  assert.deepEqual(cleanTimings(null), { ...COIN_TIMINGS });
  const t = cleanTimings({ ...COIN_TIMINGS, air: 'x', rest: -5, flips: 1e9, bounces: 1.6 });
  assert.equal(t.air, COIN_TIMINGS.air);
  assert.equal(t.rest, COIN_TIMINGS.rest);
  assert.equal(t.flips, COIN_TIMINGS.flips);
  assert.equal(t.bounces, 2);
  assert.ok(coinPlan({ air: 9e9 }).total < 30000);
});

test('the seed comes from the match and both reveals: the same everywhere, different when anything differs', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  const s = tossSeed('3mabc', a, b);
  assert.ok(Number.isInteger(s) && s >= 0 && s < 2 ** 32);
  assert.equal(tossSeed('3mabc', a, b), s);
  assert.notEqual(tossSeed('3mabd', a, b), s);
  assert.notEqual(tossSeed('3mabc', b, a), s);
  assert.notEqual(tossSeed('3mabc', a, 'c'.repeat(64)), s);
});

test('the toss lands the winner\'s face up, for every seed and either winner', () => {
  for (const seed of seeds(400)) {
    for (const first of [1, 2]) {
      const m = tossMotion({ first, seed });
      assert.equal(faceUp(m.sample(m.plan.landsAt + 1).q), first, `seed ${seed}`);
      assert.equal(faceUp(m.sample(m.plan.restEnds - 1).q), first, `seed ${seed}`);
      assert.equal(m.sample(m.plan.total + 1).visible, false);
    }
  }
});

test('the same seed tosses the same coin (both screens, both computers, a tile joining late)', () => {
  const a = tossMotion({ first: 2, seed: 902313816 }), b = tossMotion({ first: 2, seed: 902313816 });
  for (const t of [0, 400, 900, 1700, 2100, 2600, 3500, 4500, 5000]) assert.deepEqual(a.sample(t), b.sample(t));
  const c = tossMotion({ first: 2, seed: 902313817 });
  assert.notDeepEqual(a.sample(1000), c.sample(1000));
});

test('the guard: the owner\'s toss stays in the box untouched; a toss too high is lowered just enough', () => {
  let worst = 0;
  for (const seed of seeds(200)) {
    const m = tossMotion({ first: 1 + (seed % 2), seed });
    assert.equal(m.heightFactor, 1, `seed ${seed} was lowered`);
    worst = Math.max(worst, reachOf(m.sample, m.plan, COIN_LOOK));
  }
  assert.ok(worst <= EDGE_LIMIT, String(worst));
  const high = { ...COIN_TIMINGS, height: 3 };
  for (const seed of seeds(40)) {
    const m = tossMotion({ first: 1, seed, timings: high });
    assert.ok(m.heightFactor < 1);
    assert.ok(reachOf(m.sample, m.plan, COIN_LOOK) <= EDGE_LIMIT + 1e-9);
  }
});

// Seat both, pick, flip.
function flipped(seed = 5) {
  const sim = makeSim({ seed });
  sim.seat(); sim.flush();
  sim.act(0, { kind: 'pick', glaze: 'jade' }); sim.flush();
  sim.act(1, { kind: 'pick', glaze: 'brick' }); sim.flush();
  return sim;
}

test('the house: the flip carries the seed, the moment and the timings; both houses agree on the seed', () => {
  const sim = flipped();
  const f0 = sim.events[0].find((e) => e.kind === 'flip'), f1 = sim.events[1].find((e) => e.kind === 'flip');
  assert.ok(f0 && f1);
  const sh = sim.shared(0);
  assert.equal(f0.seed, tossSeed(sh.matchId, sh.coin.reveals[0], sh.coin.reveals[1]));
  assert.equal(f0.seed, f1.seed);
  assert.equal(f0.first, coinFrom(sh.matchId, sh.coin.reveals[0], sh.coin.reveals[1]));
  assert.equal(f0.at, sim.now);
  assert.deepEqual(f0.timings, { ...COIN_TIMINGS });
  assert.equal(JSON.stringify(sim.shared(0)), JSON.stringify(sim.shared(1)));     // the seed is shared, the moment isn't
  assert.equal(sh.coin.seed, f0.seed);
  assert.equal(sim.houses[0].local.coinAt, sim.now);
  assert.equal('coinAt' in sh, false);
});

test('the view carries the toss, so a tile that reloads mid-toss joins it; a rematch starts afresh', () => {
  const sim = flipped(9);
  const v = sim.view(0);
  assert.deepEqual(v.coin, { first: v.first, seed: sim.shared(0).coin.seed, at: sim.now, timings: { ...COIN_TIMINGS } });
  assert.equal(makeSim().view(0).coin, null);
});
