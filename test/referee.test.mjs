import test from 'node:test';
import assert from 'node:assert/strict';
import { createTable, step, viewOf, resumeFrom, TIMERS, TIMER_SETS } from '../house/referee.js';
import { verifyMatch } from '../house/verify.js';
import { isTid } from '../house/tid.js';
import { botMove } from '../house/bot.js';
import { makeSim, randomPlayer, playOut, BOT, ACCOUNTS } from './table-sim.mjs';

const same = (sim) => assert.equal(JSON.stringify(sim.shared(0)), JSON.stringify(sim.shared(1)), 'the two houses disagree');

// Seat both, pick glazes in order, flip the coin: a table ready to play.
function ready(opts = {}, glazes = ['jade', 'marigold']) {
  const sim = makeSim(opts);
  sim.seat();
  sim.flush();
  sim.act(0, { kind: 'pick', glaze: glazes[0] });
  sim.flush();
  sim.act(1, { kind: 'pick', glaze: glazes[1] });
  sim.flush();
  return sim;
}
const turnHouse = (sim) => sim.view(0).turn - 1;                   // the house whose player's turn it is

test('a whole match, one step at a time: commitments, glazes, the coin, rolls, banks, the win', () => {
  const sim = makeSim({ seed: 3 });
  sim.seat();
  // Both seated: each house moves to picking and sends its commitment; seat 1's carries the match id and target.
  const c1 = sim.queues[1][0], c2 = sim.queues[0][0];
  assert.equal(c1.kind, 'commit');
  assert.ok(isTid(c1.matchId));
  assert.equal(c1.target, 25);
  assert.equal(c2.kind, 'commit');
  assert.equal(c2.matchId, undefined);
  sim.flush();
  assert.equal(sim.view(1).matchId, sim.view(0).matchId);
  assert.equal(sim.view(0).phase, 'picking');
  sim.act(0, { kind: 'pick', glaze: 'jade' });
  sim.flush();
  assert.equal(sim.view(1).glazes.find((g) => g.id === 'jade').free, false);   // greys out on the other screen
  assert.equal(sim.act(1, { kind: 'pick', glaze: 'jade' }).ignored, 'taken');
  sim.act(1, { kind: 'pick', glaze: 'glow' });
  // Seat 2's house has both glazes and both commitments: it reveals its coin link at once.
  assert.equal(sim.view(1).phase, 'flipping');
  sim.flush();
  same(sim);
  const v = sim.view(0);
  assert.equal(v.phase, 'playing');
  assert.ok(v.first === 1 || v.first === 2);
  assert.equal(v.turn, v.first);
  // The player whose turn it isn't can't roll or bank; whoever's turn it is can't bank before a roll.
  const t = turnHouse(sim), o = 1 - t;
  assert.equal(sim.act(o, { kind: 'roll' }).ignored, 'not your turn');
  assert.equal(sim.act(t, { kind: 'bank' }).ignored, 'roll at least once before banking');
  // Play it out: each player rolls until the turn is worth 8 or more.
  const until = playOut(sim, [randomPlayer(sim, { bankAt: 8 }), randomPlayer(sim, { bankAt: 8 })]);
  assert.ok(until > 0);
  same(sim);
  const r0 = sim.result(0), r1 = sim.result(1);
  assert.deepEqual(r0, r1);
  assert.deepEqual(sim.results[0][0], r0);                         // the page was given the result
  assert.equal(r0.ending, 'won');
  assert.equal(r0.turns.at(-1).end, 'win');
  assert.deepEqual(r0.players.map((p) => p.glaze), ['jade', 'glow']);
  assert.ok(verifyMatch(r0).ok);
});

test('two houses fed the same messages in any order always agree (300 random tables)', () => {
  let clashes = 0, rechained = 0, banks = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const sim = makeSim({ seed, chainLength: seed % 4 === 0 ? 5 : 1000 });
    sim.seat();
    playOut(sim, [randomPlayer(sim), randomPlayer(sim)]);
    same(sim);
    const r = sim.result(0);
    assert.ok(r, `seed ${seed}: no result (${sim.shared(0).phase})`);
    assert.deepEqual(sim.result(1), r);
    const v = verifyMatch(r);
    assert.ok(v.ok, `seed ${seed}: ${v.problem}`);
    assert.notEqual(r.players[0].glaze, r.players[1].glaze);
    if (sim.events[1].some((e) => e.kind === 'taken')) clashes++;
    if (r.rechains) rechained++;
    banks += r.turns.filter((t) => t.end === 'bank').length;
    // Nothing either house ignored, except glaze picks that lost a clash.
    for (const i of [0, 1]) for (const x of sim.ignored[i]) assert.match(x.why, /taken/, `seed ${seed}: ${x.why}`);
  }
  assert.ok(clashes > 0, 'some tables had a glaze clash');
  assert.ok(rechained > 0, 'some tables ran out of chain');
  assert.ok(banks > 0);
});

test('a glaze clash goes to seat 1; seat 2 hears "taken" and picks again', () => {
  const sim = makeSim({ seed: 5 });
  sim.seat();
  sim.flush();
  sim.act(0, { kind: 'pick', glaze: 'brick' });                    // both pick Brick before either hears
  sim.act(1, { kind: 'pick', glaze: 'brick' });
  sim.flush();
  same(sim);
  assert.deepEqual(sim.shared(0).glazes, ['brick', null]);
  assert.deepEqual(sim.events[1].filter((e) => e.kind === 'taken'), [{ kind: 'taken', seat: 2, glaze: 'brick' }]);
  assert.equal(sim.events[0].filter((e) => e.kind === 'taken').length, 0);
  assert.equal(sim.view(1).canPick, true);
  sim.act(1, { kind: 'pick', glaze: 'bone' });
  sim.flush();
  same(sim);
  assert.equal(sim.view(0).phase, 'playing');
  assert.deepEqual(sim.shared(0).glazes, ['brick', 'bone']);
});

test('a reveal that doesn\'t match its commitment is refused, and so is a roll out of turn from the other house', () => {
  const sim = ready({ seed: 11 });
  const t = turnHouse(sim), o = 1 - t;
  sim.act(t, { kind: 'roll' });
  const msg = sim.queues[o].shift();
  assert.equal(msg.kind, 'roll');
  const forged = { ...msg, reveal: 'ab'.repeat(32) };
  assert.equal(sim.deliver(o, forged).ignored, 'reveal doesn\'t match');
  // The house refuses a roll from the other house when it isn't their turn.
  const sim2 = ready({ seed: 11 });
  const t2 = turnHouse(sim2);
  const fake = { from: 'peer', kind: 'roll', n: 1, reveal: 'cd'.repeat(32), matchNo: 1, seq: sim2.houses[t2].local.peerSeq + 1 };
  assert.equal(sim2.deliver(t2, fake).ignored, 'not their turn');
});

test('messages between the houses: repeats are ignored, a gap asks for a resend, and a resend catches up', () => {
  const sim = makeSim({ seed: 21 });
  sim.seat();
  sim.act(0, { kind: 'pick', glaze: 'jade' });
  // Seat 1's commitment (seq 1) and pick (seq 2) are waiting for house 2: deliver the pick first.
  const [commit, pick] = sim.queues[1].splice(0, 2);
  assert.deepEqual([commit.seq, pick.seq], [1, 2]);
  assert.equal(sim.deliver(1, pick).ignored, 'one is missing');
  assert.deepEqual(sim.queues[0].at(-1), { kind: 'resend', after: 0, from: 'peer' });
  sim.flush();                                                      // the resend brings 1 and 2 again
  assert.equal(sim.view(1).glazes.find((g) => g.id === 'jade').free, false);
  assert.equal(sim.deliver(1, commit).ignored, 'already had it');
  sim.act(1, { kind: 'pick', glaze: 'glow' });
  sim.flush();
  same(sim);
  assert.equal(sim.view(0).phase, 'playing');
  // A dropped connection mid-roll: the roll vanishes; when the page reconnects it asks for a resend.
  const t = turnHouse(sim), o = 1 - t;
  sim.lost = true;
  sim.act(t, { kind: 'roll' });
  sim.lost = false;
  assert.equal(sim.queues[o].length, 0);
  assert.equal(sim.view(t).canRoll, false);                         // still waiting for the other reveal
  sim.deliver(t, { from: 'peer', kind: 'resend', after: sim.houses[o].local.peerSeq });
  sim.flush();
  same(sim);
  assert.equal(sim.shared(0).history.length, 1);
});

test('the turn timer: a nudge after a minute, a forfeit after three, claimed by the waiting house', () => {
  const sim = ready({ seed: 31 });
  const t = turnHouse(sim), o = 1 - t, loser = t + 1;
  sim.tick(TIMERS.nudgeMs - 1);
  assert.equal(sim.events[0].filter((e) => e.kind === 'nudge').length, 0);
  sim.tick(1);
  for (const i of [0, 1]) assert.deepEqual(sim.events[i].filter((e) => e.kind === 'nudge'), [{ kind: 'nudge', seat: loser, msLeft: TIMERS.turnMs - TIMERS.nudgeMs }]);
  sim.tick(TIMERS.turnMs - TIMERS.nudgeMs);
  assert.equal(sim.view(o).phase, 'over');                          // the waiting house claims
  sim.flush();
  same(sim);
  const r = sim.result(0);
  assert.equal(r.ending, 'forfeit');
  assert.equal(r.forfeitReason, 'turn-timeout');
  assert.equal(r.winner, o + 1);
  assert.ok(verifyMatch(r).ok);
});

test('away for two minutes forfeits; coming back in time doesn\'t', () => {
  const sim = ready({ seed: 41 });
  sim.deliver(0, { from: 'page', kind: 'presence', seat: 2, state: 'gone' });
  sim.tick(TIMERS.awayMs - 1000);
  sim.deliver(0, { from: 'page', kind: 'presence', seat: 2, state: 'back' });
  sim.tick(5000);
  assert.equal(sim.view(0).phase, 'playing');
  // Seat 2 rolls a little, then drops for good.
  const until = () => sim.view(0).turn;
  if (until() === 2) { sim.act(1, { kind: 'roll' }); sim.flush(); }
  sim.deliver(0, { from: 'page', kind: 'presence', seat: 2, state: 'gone' });
  sim.lost = true;
  sim.tick(TIMERS.awayMs);
  assert.equal(sim.view(0).phase, 'over');
  assert.equal(sim.result(0).forfeitReason, 'away');
  assert.equal(sim.result(0).winner, 1);
  assert.ok(verifyMatch(sim.result(0)).ok);
  // Seat 2's page comes back and asks what it missed: it learns of the forfeit and agrees.
  sim.lost = false;
  sim.deliver(0, { from: 'peer', kind: 'resend', after: sim.houses[1].local.peerSeq });
  sim.flush();
  same(sim);
  assert.deepEqual(sim.result(1), sim.result(0));
});

test('a roll left unrevealed forfeits: whoever sees the roll first can\'t walk away from it', () => {
  const sim = ready({ seed: 51 });
  const t = turnHouse(sim), o = 1 - t;
  sim.act(t, { kind: 'roll' });
  sim.next(o);                                                       // the other house sees the roll (it now knows the die)…
  sim.queues[t] = [];                                                // …and its reveal never arrives
  sim.lost = true;
  sim.tick(TIMERS.revealMs);
  assert.equal(sim.view(t).phase, 'over');
  const r = sim.result(t);
  assert.equal(r.forfeitReason, 'no-reveal');
  assert.equal(r.winner, t + 1);
  assert.ok(verifyMatch(r).ok);
  // The withholding house hears the claim later: the roll it saw is undone, and both agree.
  sim.lost = false;
  sim.deliver(t, { from: 'peer', kind: 'resend', after: sim.houses[o].local.peerSeq });
  sim.flush();
  same(sim);
  assert.deepEqual(sim.result(o), r);
});

test('a claim that crosses a winning roll stands from the point the claimant saw', () => {
  // Make a table where the turn player is one roll from winning, then let the waiting house time out
  // while that roll is still on its way.
  for (let seed = 60; seed < 200; seed++) {
    const sim = ready({ seed });
    const t = turnHouse(sim), o = 1 - t;
    let guard = 0;
    while (sim.view(t).turn === t + 1 && sim.view(t).phase === 'playing' && guard++ < 50) {
      const v = sim.view(t);
      if (v.seats[t].score + v.turnTotal < 19) { sim.act(t, { kind: 'roll' }); sim.flush(); } else break;
    }
    const v = sim.view(t);
    if (v.phase !== 'playing' || v.turn !== t + 1 || !v.canRoll) continue;
    // The roll goes out; before the other house sees it, its turn timer runs out.
    sim.act(t, { kind: 'roll' });
    sim.now += TIMERS.turnMs;
    sim.deliver(o, { from: 'page', kind: 'tick' });
    assert.equal(sim.view(o).phase, 'over');
    sim.flush();
    same(sim);
    const r = sim.result(0);
    assert.equal(r.ending, 'forfeit');
    assert.equal(r.winner, o + 1);
    assert.ok(verifyMatch(r).ok);
    return;
  }
  assert.fail('no table reached the setup');
});

test('both houses claim at once (a split): the earlier claim stands, seat 1\'s at the same point', () => {
  const sim = ready({ seed: 71 });
  sim.lost = true;
  sim.deliver(0, { from: 'page', kind: 'presence', seat: 2, state: 'gone' });
  sim.deliver(1, { from: 'page', kind: 'presence', seat: 1, state: 'gone' });
  sim.tick(TIMERS.awayMs);
  assert.equal(sim.result(0).winner, 1);
  assert.equal(sim.result(1).winner, 2);
  sim.lost = false;
  sim.deliver(0, { from: 'peer', kind: 'resend', after: sim.houses[1].local.peerSeq });
  sim.deliver(1, { from: 'peer', kind: 'resend', after: sim.houses[0].local.peerSeq });
  sim.flush();
  same(sim);
  assert.equal(sim.result(1).winner, 1);
});

test('leaving before play abandons the table (no match, nothing to save)', () => {
  const sim = makeSim({ seed: 81 });
  sim.seat();
  sim.flush();
  sim.deliver(0, { from: 'page', kind: 'presence', seat: 2, state: 'gone' });
  sim.tick(TIMERS.awayMs);
  assert.equal(sim.view(0).phase, 'abandoned');
  sim.flush();
  assert.equal(sim.view(1).phase, 'abandoned');
  assert.equal(sim.result(0), null);
});

test('rematch: same seats and glazes, a new match id, fresh chains, a new coin', () => {
  const sim = ready({ seed: 91 });
  playOut(sim, [randomPlayer(sim, { bankAt: 12 }), randomPlayer(sim, { bankAt: 12 })]);
  const first = sim.result(0);
  const oldCommit = sim.shared(0).chains[0].commitments;
  sim.act(0, { kind: 'rematch' });
  sim.flush();
  assert.equal(sim.view(1).otherAsked, true);
  assert.equal(sim.view(0).phase, 'over');
  sim.act(1, { kind: 'rematch' });
  sim.flush();
  same(sim);
  const s = sim.shared(0);
  assert.equal(s.matchNo, 2);
  assert.equal(s.phase, 'playing');
  assert.notEqual(s.matchId, first.matchId);
  assert.deepEqual(s.glazes, first.players.map((p) => p.glaze));
  assert.notDeepEqual(s.chains[0].commitments, oldCommit);
  playOut(sim, [randomPlayer(sim), randomPlayer(sim)]);
  same(sim);
  assert.ok(verifyMatch(sim.result(0)).ok);
});

test('against the bot: the person\'s page plays both houses; the bot banks at 20 and agrees to a rematch', () => {
  const sim = makeSim({ seed: 101, players: [ACCOUNTS[0], BOT] });
  sim.seat();
  const bot = (v) => botMove(v);
  playOut(sim, [randomPlayer(sim, { bankAt: 15 }), bot]);
  same(sim);
  const r = sim.result(0);
  assert.equal(r.players[1].bot, true);
  assert.ok(verifyMatch(r).ok);
  for (const t of r.turns.filter((x) => x.player === 2 && x.end === 'bank')) assert.ok(t.rolls.reduce((a, b) => a + b, 0) >= 20);
  assert.equal(botMove(sim.view(1)), null);                          // it waits to be asked
  sim.act(0, { kind: 'rematch' });
  sim.flush();
  assert.deepEqual(botMove(sim.view(1)), { kind: 'rematch' });
});

test('setup is checked: one account per seat, seats only before play, presence only about the other seat', () => {
  let s = createTable({ me: 1 });
  const ctx = { now: () => 0, randomBytes: (n) => new Uint8Array(n).fill(7), newId: () => '3my5klkhg227s' };
  s = step(s, { from: 'page', kind: 'seated', seat: 1, ...ACCOUNTS[0] }, ctx).state;
  assert.equal(step(s, { from: 'page', kind: 'seated', seat: 2, ...ACCOUNTS[0] }, ctx).ignored, 'one account, one seat');
  assert.equal(step(s, { from: 'page', kind: 'presence', seat: 1, state: 'gone' }, ctx).ignored, 'presence is about the other seat');
  assert.equal(step(s, { from: 'player', kind: 'pick', glaze: 'jade' }, ctx).ignored, 'not choosing glazes now');
  assert.equal(step(s, { from: 'player', kind: 'roll' }, ctx).ignored, 'not playing');
  assert.equal(step(s, { from: 'peer', kind: 'roll' }, ctx).ignored, 'no sequence number');
  assert.equal(step(s, { from: 'player', kind: 'shout' }, ctx).ignored, 'unknown message player:shout');
  assert.throws(() => createTable({ me: 1, target: 50 }), /target/);
  assert.equal(viewOf(s).canRoll, false);
});

test('timer sets: seat 1 names its set in its first commitment; seat 2 refuses a table with a different set', () => {
  const sim = makeSim({ seed: 111 });
  sim.houses[0] = createTable({ me: 1, timerSet: 'short' });
  sim.seat();
  assert.equal(sim.queues[1][0].timers, 'short');
  sim.flush();
  assert.ok(sim.ignored[1].some((x) => x.why === 'different timers'));
  assert.equal(sim.shared(1).matchId, null);                         // the table doesn't start
  const ok = makeSim({ seed: 112 });
  ok.houses = [createTable({ me: 1, timerSet: 'short' }), createTable({ me: 2, timerSet: 'short' })];
  ok.seat(); ok.flush();
  ok.act(0, { kind: 'pick', glaze: 'jade' }); ok.act(1, { kind: 'pick', glaze: 'glow' }); ok.flush();
  same(ok);
  assert.equal(ok.shared(0).timerSet, 'short');
  ok.tick(TIMER_SETS.short.turnMs);                                   // 30 s instead of 3 min
  ok.flush();
  assert.equal(ok.result(0).forfeitReason, 'turn-timeout');
  assert.throws(() => createTable({ me: 1, timerSet: 'fast' }), /timerSet/);
});

test('a reloaded page picks up: the house\'s state (with its seed) comes back, and a reconnect asks for what it missed', () => {
  const sim = ready({ seed: 121 });
  const t = turnHouse(sim), o = 1 - t;
  sim.act(t, { kind: 'roll' });
  sim.flush();
  // House o is "reloaded": its state survives in the page's storage (as JSON), and the next roll
  // happens while it's gone.
  const kept = JSON.parse(JSON.stringify(sim.houses[o]));
  sim.lost = true;
  const v = sim.view(t);
  if (v.canRoll) sim.act(t, { kind: 'roll' }); else if (v.canBank) sim.act(t, { kind: 'bank' });
  sim.lost = false;
  const back = resumeFrom(kept);
  assert.ok(back.state, back.problem);
  sim.houses[o] = back.state;
  sim.deliver(o, { from: 'page', kind: 'reconnected' });
  assert.equal(sim.queues[t].at(-1).kind, 'resend');
  sim.flush();
  same(sim);
  playOut(sim, [randomPlayer(sim, { bankAt: 10 }), randomPlayer(sim, { bankAt: 10 })]);
  same(sim);
  assert.ok(verifyMatch(sim.result(0)).ok);
  // A snapshot whose seed doesn't match its commitment is refused.
  const bad = JSON.parse(JSON.stringify(kept));
  bad.local.seeds[0] = 'ab'.repeat(32);
  assert.equal(resumeFrom(bad).problem, 'a seed doesn\'t match its commitment');
  assert.equal(resumeFrom({ game: 'sevenup' }).problem, 'wrong game or version');
});

test('a page that started over without its kept state is noticed: its new commitment is refused as "started over"', () => {
  const sim = ready({ seed: 131 });
  const fresh = createTable({ me: 2 });
  sim.houses[1] = fresh;                                                // seat 2's page lost everything
  sim.queues = [[], []];
  sim.deliver(1, { from: 'page', kind: 'seated', seat: 1, ...ACCOUNTS[0] });
  sim.deliver(1, { from: 'page', kind: 'seated', seat: 2, ...ACCOUNTS[1] });
  const commit = sim.queues[0].find((x) => x.kind === 'commit');
  assert.ok(commit);
  const r = step(sim.houses[0], { ...commit, from: 'peer', seq: sim.houses[0].local.peerSeq + 1 }, sim.ctx);
  assert.equal(r.ignored, 'the other page started over');
});
