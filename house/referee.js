// referee.js: the house's referee for one seat of a Daisy table, as plain functions with no screen.
//
// Both players' pages run the same pinned house. Each house holds the rules (rules.js), its own secret
// chain for the dice (dice.js), and talks to the other house through the relay. Neither house decides
// the dice alone: every roll combines a link from each player's chain. The two houses must always come
// to the same table: everything both can see lives in state.shared and is tested to match; state.local
// holds this house's secret seeds, its clock-based timers and its message bookkeeping.
//
//   step(state, message, ctx) -> { state, out, ignored? }
//   message.from: "player" (this seat's own player tile), "peer" (the other house, through the relay),
//                 "page" (seating, presence, the clock tick)
//   ctx: { now() -> ms, randomBytes(n) -> Uint8Array, newId() -> a TID }  (only seat 1 makes match ids)
//   out: [ { to: "peer" | "player" | "page", msg: { kind, … } } ]
//
// Messages between the houses carry a sequence number per sender. A house ignores repeats, asks for a
// resend when one is missing ({ kind: "resend", after }), and can resend everything it sent: so a page
// that reconnects only has to ask (step 2 wires this to the relay).
//
// Order of a match: seating → picking (glazes; commitments exchanged) → flipping (the coin, roll 0)
// → playing → over; or abandoned when a player leaves before play. Rematch starts again at picking with
// the same seats and glazes, a new match id and fresh chains.
import {
  newGame, roll as ruleRoll, bank as ruleBank, forfeit as ruleForfeit, replay, turnTotal, isOver,
  otherSeat, TARGETS, DEFAULT_TARGET, FORFEIT_REASONS,
} from './rules.js';
import {
  GLAZES, GLAZE_IDS, CHAIN_LENGTH, newSeed, commitmentOf, revealAt, checkReveal, dieFrom, coinFrom, isLink,
} from './dice.js';
import { isTid } from './tid.js';
import { COIN_TIMINGS, tossSeed } from './coin.js';

export const GAME = 'daisy';
export const VERSION = 1;
// Timers (owner, Oct 17): a nudge after 1 minute of a turn, a forfeit after 3; a player away 2 minutes
// forfeits; a roll left unrevealed 2 minutes forfeits. Shorter or off while testing (createTable option).
export const TIMERS = { nudgeMs: 60000, turnMs: 180000, awayMs: 120000, revealMs: 120000 };
// A short set for testing (owner, Oct 18: option A): offered only by a page on the owner's own computer
// (?timers=short). Seat 1's house names its set in its first commitment and seat 2's house refuses a
// table whose set differs from its own, so one page can't speed up the other player's timers.
// Against the bot (step 7, owner Oct 18: option A) there are no timers at all: nobody is waiting, so no
// nudge and no forfeit; a match left alone simply waits. Both houses on the one page use this set.
export const TIMER_SETS = {
  real: TIMERS,
  short: { nudgeMs: 10000, turnMs: 30000, awayMs: 20000, revealMs: 20000 },
  bot: { off: true, nudgeMs: 0, turnMs: 0, awayMs: 0, revealMs: 0 },
};

const clone = (x) => JSON.parse(JSON.stringify(x));
const isText = (x, max = 200) => typeof x === 'string' && x.length > 0 && x.length <= max;

export function createTable({ me, target = DEFAULT_TARGET, chainLength = CHAIN_LENGTH, timerSet = 'real', timers = {} }) {
  if (me !== 1 && me !== 2) throw new Error('me must be seat 1 or 2');
  if (!TIMER_SETS[timerSet]) throw new Error('timerSet must be real, short or bot');
  if (!TARGETS.includes(target)) throw new Error(`target must be one of ${TARGETS.join(', ')}`);
  if (!Number.isInteger(chainLength) || chainLength < 2) throw new Error('chainLength');
  return {
    game: GAME, v: VERSION, me,
    shared: freshMatch({ matchNo: 1, seats: [null, null], glazes: [null, null], chainLength }),
    local: {
      target, timerSet, timers: { ...TIMER_SETS[timerSet], ...timers },
      seeds: [],              // this house's secret seed for each chain of this match
      seq: 0, sent: [],       // messages sent to the other house (kept for resends)
      peerSeq: 0,             // the last message taken from the other house
      turnSince: null, nudged: false, pendingSince: null, awaySince: null,
      coinAt: null,           // when this house flipped the coin, by this computer's clock (step 5c: a late tile joins the toss)
    },
  };
}

function freshMatch({ matchNo, seats, glazes, chainLength }) {
  return {
    phase: 'seating',
    matchNo, matchId: null, target: null, timerSet: null, chainLength,
    seats, glazes,
    chains: [],            // [{ fromRoll, commitments: [seat1's | null, seat2's | null] }]
    coin: null,            // { reveals: [ , ], first, seed } (seed: the toss's look, from the reveals; step 5c)
    history: [],           // resolved: { type: "roll", seat, n, value, reveals: [ , ] } | { type: "bank", seat }
    pending: null,         // a roll under way: { n, by, reveals: [ , ] }
    play: null,            // the rules' game (rules.js), kept in step with history
    claim: null,           // a forfeit: { by, loser, reason, at }
    rematch: [],
  };
}

// ---- small helpers on the shared state ----
const rollsDone = (sh) => sh.history.filter((h) => h.type === 'roll').length;
const nextRoll = (sh) => rollsDone(sh) + 1;
function chainIndexFor(sh, n) {
  return sh.chains.findIndex((c) => n >= c.fromRoll && n < c.fromRoll + sh.chainLength);
}
// The link a reveal for roll n by seat must hash to.
function revealBefore(sh, seat, n) {
  const c = sh.chains[chainIndexFor(sh, n)];
  if (!c) return null;
  if (n === c.fromRoll) return c.commitments[seat - 1];
  if (n - 1 === 0) return sh.coin && sh.coin.reveals[seat - 1];
  const prev = sh.history.find((h) => h.type === 'roll' && h.n === n - 1);
  return prev ? prev.reveals[seat - 1] : null;
}
const bothCommitted = (sh, n) => { const c = sh.chains[chainIndexFor(sh, n)]; return !!c && c.commitments.every(isLink); };
function myReveal(state, n) {
  const sh = state.shared, e = chainIndexFor(sh, n);
  return revealAt(state.local.seeds[e], sh.chainLength, n - sh.chains[e].fromRoll);
}

function sendPeer(state, out, msg) {
  const m = { ...msg, matchNo: state.shared.matchNo, seq: ++state.local.seq };
  state.local.sent.push(m);
  out.push({ to: 'peer', msg: m });
}
const toPlayer = (out, msg) => out.push({ to: 'player', msg });

// ---- the step ----
export function step(prev, message, ctx) {
  if (!message || typeof message !== 'object' || typeof message.kind !== 'string') return { state: prev, out: [], ignored: 'bad message' };
  let base = prev;
  if (message.from === 'peer' && message.kind !== 'resend') {
    const seq = message.seq;
    if (!Number.isInteger(seq) || seq < 1) return { state: prev, out: [], ignored: 'no sequence number' };
    if (seq <= prev.local.peerSeq) return { state: prev, out: [], ignored: 'already had it' };
    if (seq > prev.local.peerSeq + 1) return { state: prev, out: [{ to: 'peer', msg: { kind: 'resend', after: prev.local.peerSeq } }], ignored: 'one is missing' };
    base = clone(prev);
    base.local.peerSeq = seq;
    if (message.matchNo !== base.shared.matchNo) return { state: base, out: [], ignored: 'another match' };
  }
  const s = clone(base);
  const out = [];
  const why = handle(s, message, ctx, out);
  if (why) return { state: base, out: [], ignored: why };
  follow(s, out, ctx);
  return { state: s, out };
}

function handle(s, m, ctx, out) {
  const sh = s.shared, me = s.me, other = otherSeat(me);
  const from = m.from;
  switch (`${from}:${m.kind}`) {
    // ---------- from the page ----------
    case 'page:seated': {
      const i = Number(m.seat) - 1;
      if (i !== 0 && i !== 1) return 'no such seat';
      if (!isText(m.handle, 253) || !isText(m.did, 2048)) return 'seated needs a handle and a did';
      if (sh.phase !== 'seating') return 'seats are taken';
      if (sh.seats[1 - i] && sh.seats[1 - i].did === m.did) return 'one account, one seat';
      sh.seats[i] = { did: m.did, handle: m.handle, ...(m.bot === true ? { bot: true } : {}) };
      return null;
    }
    case 'page:presence': {
      if (Number(m.seat) !== other) return 'presence is about the other seat';
      if (m.state === 'gone') { if (s.local.awaySince === null) s.local.awaySince = ctx.now(); }
      else if (m.state === 'back') s.local.awaySince = null;
      else return 'presence state must be gone or back';
      return null;
    }
    case 'page:tick':
      return tick(s, ctx, out);
    case 'page:reconnected':
      // This page (re)joined the relay, or the other page came back: ask for anything missed.
      out.push({ to: 'peer', msg: { kind: 'resend', after: s.local.peerSeq } });
      return null;

    // ---------- from this seat's player ----------
    case 'player:pick': {
      if (sh.phase !== 'picking') return 'not choosing glazes now';
      if (sh.glazes[me - 1]) return 'glaze already chosen';
      if (!GLAZE_IDS.includes(m.glaze)) return 'no such glaze';
      if (sh.glazes[other - 1] === m.glaze) return 'taken';
      sh.glazes[me - 1] = m.glaze;
      sendPeer(s, out, { kind: 'pick', glaze: m.glaze });
      return null;
    }
    case 'player:roll': {
      if (sh.phase !== 'playing') return 'not playing';
      if (sh.pending) return 'a roll is under way';
      if (sh.play.turn !== me) return 'not your turn';
      const n = nextRoll(sh);
      if (!bothCommitted(sh, n)) return 'waiting for fresh commitments';
      const reveal = myReveal(s, n);
      sh.pending = { n, by: me, reveals: [null, null] };
      sh.pending.reveals[me - 1] = reveal;
      s.local.pendingSince = ctx.now();
      sendPeer(s, out, { kind: 'roll', n, reveal });
      toPlayer(out, { kind: 'rolling', seat: me, n });
      return null;
    }
    case 'player:bank': {
      if (sh.phase !== 'playing') return 'not playing';
      if (sh.pending) return 'a roll is under way';
      const r = ruleBank(sh.play, me);
      if (r.error) return r.error;
      const h = sh.history.length;
      sh.history.push({ type: 'bank', seat: me });
      sh.play = r.game;
      afterAction(s, ctx);
      sendPeer(s, out, { kind: 'bank', h });
      for (const e of r.events) toPlayer(out, e);
      return null;
    }
    case 'player:rematch': {
      if (sh.phase !== 'over') return 'the match isn\'t over';
      if (sh.rematch.includes(me)) return 'already asked';
      sh.rematch.push(me);
      sendPeer(s, out, { kind: 'rematch' });
      return null;
    }

    // ---------- from the other house ----------
    case 'peer:commit': {
      if (!['seating', 'picking', 'flipping', 'playing'].includes(sh.phase)) return 'not taking commitments';
      if (m.chainLength !== sh.chainLength) return 'a different chain length';
      if (!isLink(m.commitment)) return 'commitment';
      if (sh.seats[other - 1] && m.did !== sh.seats[other - 1].did) return 'commitment from another account';
      const e = m.chain;
      if (!Number.isInteger(e) || e < 0 || e > sh.chains.length) return 'chain number';
      if (e === 0 && other === 1) {
        if (!isTid(m.matchId)) return 'match id';
        if (!TARGETS.includes(m.target)) return 'target';
        if (m.timers !== s.local.timerSet) return 'different timers';
      }
      const fromRoll = e === 0 ? 0 : sh.chains[e - 1].fromRoll + sh.chainLength;
      if (m.fromRoll !== fromRoll) return 'chain start';
      if (e === sh.chains.length) sh.chains.push({ fromRoll, commitments: [null, null] });
      if (sh.chains[e].commitments[other - 1]) {
        // A different commitment for a chain already set: the other page started over without its kept
        // state (and its seed). The game can't go on; the page says so, and the timers end it.
        return sh.chains[e].commitments[other - 1] === m.commitment ? 'already committed' : 'the other page started over';
      }
      sh.chains[e].commitments[other - 1] = m.commitment;
      if (e === 0 && other === 1) { sh.matchId = m.matchId; sh.target = m.target; sh.timerSet = m.timers; }
      return null;
    }
    case 'peer:pick': {
      if (sh.phase !== 'picking' && sh.phase !== 'seating') return 'not choosing glazes now';
      if (sh.glazes[other - 1]) return 'glaze already chosen';
      if (!GLAZE_IDS.includes(m.glaze)) return 'no such glaze';
      if (m.glaze === sh.glazes[me - 1]) {
        // A clash: both picked the same glaze before seeing the other's pick. Seat 1 keeps it (Oct 18).
        if (me === 1) return 'taken: seat 1 keeps it';
        sh.glazes = [m.glaze, null];
        toPlayer(out, { kind: 'taken', seat: me, glaze: m.glaze });
        return null;
      }
      sh.glazes[other - 1] = m.glaze;
      return null;
    }
    case 'peer:reveal': {
      const n = m.n;
      if (!isLink(m.reveal)) return 'reveal';
      if (n === 0) {
        const c = sh.chains[0];
        if (!c || !c.commitments[other - 1]) return 'no commitment yet';
        if (sh.coin && sh.coin.reveals[other - 1]) return 'already revealed';
        if (!checkReveal(c.commitments[other - 1], m.reveal)) return 'reveal doesn\'t match the commitment';
        if (!sh.coin) sh.coin = { reveals: [null, null], first: null };
        sh.coin.reveals[other - 1] = m.reveal;
        return null;
      }
      const p = sh.pending;
      if (!p || p.n !== n || p.by !== me) return 'no roll waiting for that reveal';
      if (p.reveals[other - 1]) return 'already revealed';
      if (!checkReveal(revealBefore(sh, other, n), m.reveal)) return 'reveal doesn\'t match';
      p.reveals[other - 1] = m.reveal;
      return null;
    }
    case 'peer:roll': {
      if (sh.phase !== 'playing') return 'not playing';
      if (sh.pending) return 'a roll is under way';
      if (sh.play.turn !== other) return 'not their turn';
      const n = m.n;
      if (n !== nextRoll(sh)) return 'roll number';
      if (!bothCommitted(sh, n)) return 'waiting for fresh commitments';
      if (!checkReveal(revealBefore(sh, other, n), m.reveal)) return 'reveal doesn\'t match';
      sh.pending = { n, by: other, reveals: [null, null] };
      sh.pending.reveals[other - 1] = m.reveal;
      const mine = myReveal(s, n);
      sh.pending.reveals[me - 1] = mine;
      sendPeer(s, out, { kind: 'reveal', n, reveal: mine });
      toPlayer(out, { kind: 'rolling', seat: other, n });
      return null;
    }
    case 'peer:bank': {
      if (sh.phase !== 'playing') return 'not playing';
      if (sh.pending) return 'a roll is under way';
      if (m.h !== sh.history.length) return 'out of step';
      const r = ruleBank(sh.play, other);
      if (r.error) return r.error;
      sh.history.push({ type: 'bank', seat: other });
      sh.play = r.game;
      afterAction(s, ctx);
      for (const e of r.events) toPlayer(out, e);
      return null;
    }
    case 'peer:rematch': {
      if (sh.phase !== 'over') return 'the match isn\'t over';
      if (sh.rematch.includes(other)) return 'already asked';
      sh.rematch.push(other);
      toPlayer(out, { kind: 'rematch-asked', seat: other });
      return null;
    }
    case 'peer:forfeit': {
      if (m.loser !== me) return 'a claim must be against this seat';
      if (!FORFEIT_REASONS.includes(m.reason)) return 'reason';
      if (!Number.isInteger(m.at) || m.at < 0 || m.at > sh.history.length) return 'claim point';
      if (sh.phase === 'over') {
        if (sh.claim) {
          // Both claimed: the earlier claim stands; at the same point, seat 1's (as with glazes).
          if (sh.claim.at < m.at || (sh.claim.at === m.at && sh.claim.by === 1)) return 'our claim stands';
        } else if (m.at >= sh.history.length) return 'the match was already won';
      } else if (sh.phase !== 'playing') return 'not playing';
      // The claim stands from the point the other house saw: anything after it is undone.
      applyForfeit(s, { by: other, loser: me, reason: m.reason, at: m.at }, out);
      return null;
    }
    case 'peer:abandon': {
      if (!['seating', 'picking', 'flipping'].includes(sh.phase)) return 'already playing';
      sh.phase = 'abandoned';
      toPlayer(out, { kind: 'abandoned', seat: other });
      return null;
    }
    case 'peer:resend': {
      if (!Number.isInteger(m.after) || m.after < 0) return 'resend after';
      for (const x of s.local.sent) if (x.seq > m.after) out.push({ to: 'peer', msg: x });
      return null;
    }
  }
  return `unknown message ${from}:${m.kind}`;
}

// After a roll or a bank: the turn clock starts again.
function afterAction(s, ctx) {
  s.local.turnSince = ctx.now();
  s.local.nudged = false;
  if (isOver(s.shared.play)) s.shared.phase = 'over';
}

// What follows by itself from the shared state, the same way in both houses.
function follow(s, out, ctx) {
  const sh = s.shared, me = s.me;
  for (let guard = 0; guard < 20; guard++) {
    if (sh.phase === 'seating' && sh.seats.every(Boolean)) { sh.phase = 'picking'; toPlayer(out, { kind: 'picking' }); continue; }

    // This house's commitment for the chain that the next roll needs (chain 0 holds the coin).
    if (['picking', 'flipping', 'playing'].includes(sh.phase)) {
      const n = sh.phase === 'playing' ? nextRoll(sh) : 0;
      let e = chainIndexFor(sh, n);
      if (e < 0 && sh.phase === 'playing' && isOver(sh.play)) e = -2;            // no more rolls needed
      if (e === -1) {
        const fromRoll = sh.chains.length ? sh.chains[sh.chains.length - 1].fromRoll + sh.chainLength : 0;
        sh.chains.push({ fromRoll, commitments: [null, null] });
        e = sh.chains.length - 1;
      }
      if (e >= 0 && !sh.chains[e].commitments[me - 1]) {
        const seed = newSeed(ctx.randomBytes);
        s.local.seeds[e] = seed;
        const commitment = commitmentOf(seed, sh.chainLength);
        sh.chains[e].commitments[me - 1] = commitment;
        const msg = { kind: 'commit', chain: e, fromRoll: sh.chains[e].fromRoll, commitment, chainLength: sh.chainLength, did: sh.seats[me - 1].did };
        if (e === 0 && me === 1) {
          sh.matchId = ctx.newId();
          sh.target = s.local.target;
          sh.timerSet = s.local.timerSet;
          Object.assign(msg, { matchId: sh.matchId, target: sh.target, timers: sh.timerSet });
        }
        sendPeer(s, out, msg);
        continue;
      }
    }

    // Glazes chosen and both chains committed: flip the coin (roll 0).
    if (sh.phase === 'picking' && sh.glazes.every(Boolean) && sh.matchId && sh.chains[0] && sh.chains[0].commitments.every(isLink)) {
      sh.phase = 'flipping';
      if (!sh.coin) sh.coin = { reveals: [null, null], first: null };
      const reveal = revealAt(s.local.seeds[0], sh.chainLength, 0);
      sh.coin.reveals[me - 1] = reveal;
      sendPeer(s, out, { kind: 'reveal', n: 0, reveal });
      toPlayer(out, { kind: 'flipping' });
      continue;
    }
    if (sh.phase === 'flipping' && sh.coin.reveals.every(Boolean)) {
      sh.coin.first = coinFrom(sh.matchId, sh.coin.reveals[0], sh.coin.reveals[1]);
      sh.coin.seed = tossSeed(sh.matchId, sh.coin.reveals[0], sh.coin.reveals[1]);
      sh.play = newGame({ target: sh.target, first: sh.coin.first });
      sh.phase = 'playing';
      s.local.turnSince = ctx.now();
      s.local.nudged = false;
      s.local.coinAt = ctx.now();
      // The player tiles toss the coin with this seed and these timings, from this moment (step 5c).
      toPlayer(out, { kind: 'flip', first: sh.coin.first, matchId: sh.matchId, seed: sh.coin.seed, at: s.local.coinAt, timings: { ...COIN_TIMINGS } });
      toPlayer(out, { kind: 'turn', seat: sh.coin.first });
      continue;
    }

    // Both reveals in: the die.
    if (sh.phase === 'playing' && sh.pending && sh.pending.reveals.every(Boolean)) {
      const p = sh.pending;
      const value = dieFrom(sh.matchId, p.n, p.reveals[0], p.reveals[1]);
      const r = ruleRoll(sh.play, p.by, value);
      if (r.error) throw new Error(`referee: the rules refused a resolved roll: ${r.error}`);
      sh.history.push({ type: 'roll', seat: p.by, n: p.n, value, reveals: p.reveals });
      sh.play = r.game;
      sh.pending = null;
      s.local.pendingSince = null;
      afterAction(s, ctx);
      for (const e of r.events) toPlayer(out, { ...e, n: p.n });
      if (sh.phase === 'over') finish(s, out);
      continue;
    }

    // Both asked for a rematch: same seats and glazes, a new match.
    if (sh.phase === 'over' && sh.rematch.length === 2) {
      s.shared = freshMatch({ matchNo: sh.matchNo + 1, seats: sh.seats, glazes: sh.glazes, chainLength: sh.chainLength });
      s.shared.timerSet = sh.timerSet;
      s.shared.phase = 'picking';
      s.local.seeds = [];
      s.local.pendingSince = null;
      s.local.coinAt = null;
      toPlayer(out, { kind: 'rematch', matchNo: s.shared.matchNo });
      follow(s, out, ctx);
      return;
    }
    return;
  }
  throw new Error('referee: follow did not settle');
}

function finish(s, out) {
  s.shared.phase = 'over';
  toPlayer(out, { kind: 'match-over', winner: s.shared.play.winner, ending: s.shared.play.ending });
  out.push({ to: 'page', msg: { kind: 'result', result: resultOf(s) } });
}

function applyForfeit(s, claim, out) {
  const sh = s.shared;
  sh.history = sh.history.slice(0, claim.at);
  sh.pending = null;
  s.local.pendingSince = null;
  const r = replay({ target: sh.target, first: sh.coin.first }, sh.history.map((h) => ({ type: h.type, seat: h.seat, value: h.value })));
  if (r.error) throw new Error(`referee: history no longer replays: ${r.error}`);
  const f = ruleForfeit(r.game, claim.loser, claim.reason);
  if (f.error) throw new Error(`referee: forfeit refused: ${f.error}`);
  sh.play = f.game;
  sh.claim = claim;
  sh.rematch = [];
  for (const e of f.events) toPlayer(out, e);
  finish(s, out);
}

// The page's clock tick (every second or so): the nudge, and the forfeits this house may claim.
function tick(s, ctx, out) {
  const sh = s.shared, L = s.local, me = s.me, other = otherSeat(me), now = ctx.now();
  if (L.timers.off) return null;                         // against the bot: no timers
  if (['seating', 'picking', 'flipping'].includes(sh.phase)) {
    if (L.awaySince !== null && now - L.awaySince >= L.timers.awayMs) {
      sh.phase = 'abandoned';
      sendPeer(s, out, { kind: 'abandon' });
      toPlayer(out, { kind: 'abandoned', seat: other });
    }
    return null;
  }
  if (sh.phase !== 'playing') return null;
  const claim = (reason) => {
    const c = { by: me, loser: other, reason, at: sh.history.length };
    applyForfeit(s, c, out);
    sendPeer(s, out, { kind: 'forfeit', loser: other, reason, at: c.at });
  };
  if (L.awaySince !== null && now - L.awaySince >= L.timers.awayMs) return claim('away'), null;
  if (sh.pending && sh.pending.by === me && !sh.pending.reveals[other - 1] && now - L.pendingSince >= L.timers.revealMs) return claim('no-reveal'), null;
  if (!sh.pending && sh.play.turn === other && now - L.turnSince >= L.timers.turnMs) return claim('turn-timeout'), null;
  if (!L.nudged && !sh.pending && now - L.turnSince >= L.timers.nudgeMs) {
    L.nudged = true;
    toPlayer(out, { kind: 'nudge', seat: sh.play.turn, msLeft: Math.max(0, L.timers.turnMs - (now - L.turnSince)) });
  }
  return null;
}

// ---- what the outside sees ----

// The finished match, for the page to save (record.js) and anyone to check (verify.js).
export function resultOf(state) {
  const sh = state.shared;
  if (sh.phase !== 'over') return null;
  const revealOf = (n) => (n === 0 ? sh.coin.reveals : sh.history.find((h) => h.type === 'roll' && h.n === n).reveals);
  const lastN = rollsDone(sh);
  const chains = [];
  for (const c of sh.chains) {
    const top = Math.min(lastN, c.fromRoll + sh.chainLength - 1);
    if (top < c.fromRoll) continue;                        // a chain no resolved roll used
    chains.push({ fromRoll: c.fromRoll, commitments: [...c.commitments], lastReveals: [...revealOf(top)] });
  }
  const result = {
    matchId: sh.matchId,
    target: sh.target,
    players: sh.seats.map((p, i) => ({ did: p.did, handle: p.handle, glaze: sh.glazes[i], ...(p.bot ? { bot: true } : {}) })),
    firstPlayer: sh.coin.first,
    commitments: chains[0].commitments,
    lastReveals: chains[0].lastReveals,
    turns: sh.play.turns.map((t) => ({ player: t.player, rolls: [...t.rolls], end: t.end })),
    winner: sh.play.winner,
    ending: sh.play.ending,
  };
  if (chains.length > 1) result.rechains = chains.slice(1);
  if (sh.play.ending === 'forfeit') result.forfeitReason = sh.play.forfeitReason;
  return result;
}

// What this seat's player tile shows.
export function viewOf(state) {
  const sh = state.shared, me = state.me, other = otherSeat(me);
  const play = sh.play;
  const lastRoll = [...sh.history].reverse().find((h) => h.type === 'roll') || null;
  const taken = (id) => sh.glazes.includes(id);
  return {
    me, phase: sh.phase, matchNo: sh.matchNo, matchId: sh.matchId, target: sh.target,
    seats: sh.seats.map((p, i) => ({
      seat: i + 1, you: i + 1 === me, handle: p ? p.handle : null, did: p ? p.did : null, bot: !!(p && p.bot),
      glaze: sh.glazes[i], score: play ? play.scores[i] : 0,
    })),
    glazes: GLAZES.map((g) => ({ ...g, free: !taken(g.id), mine: sh.glazes[me - 1] === g.id })),
    canPick: sh.phase === 'picking' && !sh.glazes[me - 1],
    first: sh.coin ? sh.coin.first : null,
    // The toss, for a tile that starts or reloads in the middle of it (step 5c, Q77).
    coin: sh.coin && sh.coin.first ? { first: sh.coin.first, seed: Number.isInteger(sh.coin.seed) ? sh.coin.seed : null,
      at: Number.isFinite(state.local.coinAt) ? state.local.coinAt : null, timings: { ...COIN_TIMINGS } } : null,
    turn: play ? play.turn : null,
    turnRolls: play ? [...play.turnRolls] : [],
    turnTotal: play ? turnTotal(play) : 0,
    rolling: sh.pending ? { seat: sh.pending.by, n: sh.pending.n } : null,
    canRoll: sh.phase === 'playing' && !sh.pending && play.turn === me && bothCommitted(sh, nextRoll(sh)),
    canBank: sh.phase === 'playing' && !sh.pending && play.turn === me && play.turnRolls.length > 0,
    lastRoll: lastRoll ? { seat: lastRoll.seat, value: lastRoll.value, n: lastRoll.n } : null,
    winner: play ? play.winner : null,
    ending: play ? play.ending : null,
    forfeitReason: play ? play.forfeitReason : null,
    rematch: [...sh.rematch],
    canRematch: sh.phase === 'over' && !sh.rematch.includes(me),
    otherAsked: sh.rematch.includes(other),
  };
}

// ---- picking up after a page reload ----
// The page keeps this house's latest state (its secret seeds included) in its own browser, for this
// table only, so a reload doesn't lose the seed: without it, this player couldn't reveal another link
// and would forfeit. A fresh house takes the state back with resumeFrom; the page then asks the other
// house for anything it missed ({ from: "page", kind: "reconnected" }).
export function checkSnapshot(st) {
  if (!st || typeof st !== 'object') return 'not an object';
  if (st.game !== GAME || st.v !== VERSION) return 'wrong game or version';
  if (st.me !== 1 && st.me !== 2) return 'seat';
  const sh = st.shared, L = st.local;
  if (!sh || !L || typeof sh !== 'object' || typeof L !== 'object') return 'parts';
  if (!['seating', 'picking', 'flipping', 'playing', 'over', 'abandoned'].includes(sh.phase)) return 'phase';
  if (!Array.isArray(sh.chains) || !Array.isArray(L.seeds) || !Array.isArray(L.sent) || !Array.isArray(sh.history)) return 'lists';
  for (const [e, c] of sh.chains.entries()) {
    const mine = c && c.commitments && c.commitments[st.me - 1];
    if (mine && (!isLink(L.seeds[e]) || commitmentOf(L.seeds[e], sh.chainLength) !== mine)) return 'a seed doesn\'t match its commitment';
  }
  if (!TIMER_SETS[L.timerSet]) return 'timers';
  if (sh.phase === 'playing' || sh.phase === 'over') {
    if (!sh.coin || !(sh.coin.first === 1 || sh.coin.first === 2)) return 'coin';
    const r = replay({ target: sh.target, first: sh.coin.first }, sh.history.map((h) => ({ type: h.type, seat: h.seat, value: h.value })));
    if (r.error) return 'history';
  }
  return null;
}
export function resumeFrom(snapshot) {
  const problem = checkSnapshot(snapshot);
  if (problem) return { problem };
  return { state: clone(snapshot) };
}
