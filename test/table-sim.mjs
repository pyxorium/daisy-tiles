// table-sim.mjs: two houses joined by a stand-in for the relay, for the Node tests. Messages between
// the houses queue up in each direction (in order, as through the relay) and are delivered when the
// test says, or in a random interleaving with the players' moves; the clock only moves when told.
import { createTable, step, viewOf, resultOf } from '../house/referee.js';
import { newTid } from '../house/tid.js';

// A small seeded random generator (mulberry32), so every run of a test is the same.
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ACCOUNTS = [
  { did: 'did:plc:rqbqpaaluty5v47jwciowpik', handle: 'pyxorium.com' },
  { did: 'did:plc:joer5rzmwgec3dkr4srfmq45', handle: 'thunderbirdwine.bsky.social' },
];
export const BOT = { did: 'did:plc:hd2efebmfhpqcusfya4lguce', handle: 'dicesprite.thunderbird.cafe', bot: true };

export function makeSim({ seed = 1, chainLength = 1000, timers = {}, start = Date.UTC(2026, 9, 18, 12), players = ACCOUNTS } = {}) {
  const rand = prng(seed);
  const sim = {
    rand, now: start,
    houses: [createTable({ me: 1, chainLength, timers }), createTable({ me: 2, chainLength, timers })],
    queues: [[], []],                 // messages waiting for house 1, for house 2
    events: [[], []], results: [[], []], ignored: [[], []],
    lost: false,                      // while true, messages between the houses vanish (a dropped connection)
  };
  const fill = (b) => { for (let i = 0; i < b.length; i++) b[i] = Math.floor(rand() * 256); return b; };
  const ctx = {
    now: () => sim.now,
    randomBytes: (n) => fill(new Uint8Array(n)),
    newId: () => newTid(sim.now, { getRandomValues: fill }),
  };
  sim.ctx = ctx;
  // Give house i (0 or 1) a message.
  sim.deliver = (i, msg) => {
    const r = step(sim.houses[i], msg, ctx);
    sim.houses[i] = r.state;
    if (r.ignored) sim.ignored[i].push({ why: r.ignored, msg });
    for (const o of r.out) {
      if (o.to === 'peer') { if (!sim.lost) sim.queues[1 - i].push({ ...o.msg, from: 'peer' }); }
      else if (o.to === 'player') sim.events[i].push(o.msg);
      else if (o.to === 'page') sim.results[i].push(o.msg.result);
    }
    return r;
  };
  // Deliver the next waiting message for house i.
  sim.next = (i) => sim.deliver(i, sim.queues[i].shift());
  // Deliver everything waiting, both ways, until quiet.
  sim.flush = () => {
    for (let k = 0; k < 100000; k++) {
      if (sim.queues[0].length) sim.next(0);
      else if (sim.queues[1].length) sim.next(1);
      else return;
    }
    throw new Error('flush did not settle');
  };
  sim.act = (i, move) => sim.deliver(i, { from: 'player', ...move });
  sim.view = (i) => viewOf(sim.houses[i]);
  sim.result = (i) => resultOf(sim.houses[i]);
  sim.shared = (i) => sim.houses[i].shared;
  sim.tick = (ms = 0) => { sim.now += ms; sim.deliver(0, { from: 'page', kind: 'tick' }); sim.deliver(1, { from: 'page', kind: 'tick' }); };
  sim.seat = () => {
    for (const i of [0, 1]) players.forEach((p, k) => sim.deliver(i, { from: 'page', kind: 'seated', seat: k + 1, ...p }));
  };
  return sim;
}

// Players that roll until a turn is worth `bankAt` (or at random), choosing glazes at random from those
// that look free on their own screen.
export function randomPlayer(sim, { bankAt = null } = {}) {
  return (view) => {
    if (view.canPick) {
      const free = view.glazes.filter((g) => g.free);
      return { kind: 'pick', glaze: free[Math.floor(sim.rand() * free.length)].id };
    }
    if (view.canBank && (bankAt !== null ? view.turnTotal >= bankAt : sim.rand() < 0.3)) return { kind: 'bank' };
    if (view.canRoll) return { kind: 'roll' };
    return null;
  };
}

// Run a table to the end of the match: at each step, at random, one house takes its next message or
// one player makes a move (when it has one). Returns the number of steps.
export function playOut(sim, strategies, { maxSteps = 200000, stepMs = 50 } = {}) {
  for (let k = 0; k < maxSteps; k++) {
    const choices = [];
    for (const i of [0, 1]) {
      if (sim.queues[i].length) choices.push(() => sim.next(i));
      const move = strategies[i](sim.view(i));
      if (move) choices.push(() => sim.act(i, move));
    }
    if (!choices.length) return k;
    choices[Math.floor(sim.rand() * choices.length)]();
    sim.now += stepMs;
  }
  throw new Error('playOut did not finish');
}
