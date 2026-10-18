import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordFor, checkRecord, otherPlayer, COLLECTION, GLAZE_IDS } from '../page/record.js';
import { verifyMatch } from '../shared/verify.js';
import { GLAZE_IDS as DICE_GLAZES } from '../shared/dice.js';
import { FORFEIT_REASONS } from '../shared/rules.js';
import { TIMERS } from '../house/referee.js';
import { makeSim, randomPlayer, playOut, BOT, ACCOUNTS } from './table-sim.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOUSE = { uri: 'at://did:plc:6vxjigxrqizmbo56gojxico3/ing.dasl.masl/3my27cwible2m', cid: 'bafyreifox3fars5yg5zh5ff5lmxdm4gvlpuxbsdknjcuwpdsxf3qx7ghee' };
const clone = (x) => JSON.parse(JSON.stringify(x));

function finished(seed, opts = {}) {
  const sim = makeSim({ seed, ...opts });
  sim.seat();
  playOut(sim, [randomPlayer(sim, { bankAt: 10 }), randomPlayer(sim, { bankAt: 10 })]);
  return sim.result(0);
}

test('each player\'s record: same match, their own seat; it passes the lexicon checks and the dice check', () => {
  const result = finished(1);
  const a = recordFor(result, 1, HOUSE, '2026-10-18T12:00:00.000Z');
  const b = recordFor(result, 2, HOUSE, '2026-10-18T12:00:05.000Z');
  assert.equal(a.$type, COLLECTION);
  assert.equal(a.matchId, b.matchId);
  assert.deepEqual([a.seat, b.seat], [1, 2]);
  assert.deepEqual(a.house, HOUSE);
  assert.equal(checkRecord(a), null);
  assert.equal(checkRecord(b), null);
  assert.equal(otherPlayer(result, 1).handle, ACCOUNTS[1].handle);
  assert.equal('house' in recordFor(result, 1, null), false);         // left out until the house is published
  assert.equal('forfeitReason' in a, false);
  assert.equal('rechains' in a, false);
});

test('records with rechains and forfeits check out too', () => {
  const long = finished(4, { chainLength: 4 });
  assert.ok(long.rechains && long.rechains.length > 0);
  assert.equal(checkRecord(recordFor(long, 2, HOUSE)), null);
  const sim = makeSim({ seed: 9 });
  sim.seat();
  sim.flush();
  sim.act(0, { kind: 'pick', glaze: 'bone' }); sim.act(1, { kind: 'pick', glaze: 'midnight' });
  sim.flush();
  sim.tick(TIMERS.turnMs);
  sim.flush();
  const f = sim.result(0);
  assert.equal(f.ending, 'forfeit');
  const rec = recordFor(f, 1, HOUSE);
  assert.equal(rec.forfeitReason, 'turn-timeout');
  assert.equal(checkRecord(rec), null);
});

test('a bot seat can\'t save; the person\'s record marks the bot', () => {
  const sim = makeSim({ seed: 2, players: [ACCOUNTS[0], BOT] });
  sim.seat();
  playOut(sim, [randomPlayer(sim, { bankAt: 10 }), randomPlayer(sim, { bankAt: 20 })]);
  const r = sim.result(0);
  assert.equal(checkRecord(recordFor(r, 1, HOUSE)), null);
  assert.equal(recordFor(r, 1, HOUSE).players[1].bot, true);
  assert.equal(checkRecord(recordFor(r, 2, HOUSE)), 'a bot seat does not save');
});

test('tampering is caught: a changed roll, reveal, commitment, coin, turn end or winner', () => {
  const result = finished(5);
  const rec = recordFor(result, 1, HOUSE);
  const tamper = (f) => { const r = clone(rec); f(r); return checkRecord(r); };
  const firstRoll = rec.turns.findIndex((t) => t.rolls.length);
  assert.match(tamper((r) => { const t = r.turns[firstRoll]; t.rolls[0] = t.rolls[0] === 6 ? 5 : 6; }), /^dice: /);
  assert.match(tamper((r) => { r.lastReveals[0] = 'ab'.repeat(32); }), /doesn't lead back/);
  assert.match(tamper((r) => { r.lastReveals.reverse(); }), /^dice: /);
  assert.match(tamper((r) => { r.commitments[1] = r.commitments[0]; }), /^dice: /);
  assert.match(tamper((r) => { r.firstPlayer = r.firstPlayer === 1 ? 2 : 1; }), /^dice: /);
  assert.match(tamper((r) => { r.winner = r.winner === 1 ? 2 : 1; }), /^dice: /);
  assert.match(tamper((r) => { r.matchId = '3my5klkhg222h'; }), /^dice: /);
  assert.match(tamper((r) => { r.turns.pop(); }), /^dice: /);
  const banked = rec.turns.findIndex((t) => t.end === 'bank');
  if (banked >= 0) assert.match(tamper((r) => { r.turns[banked].end = 'bust'; }), /^dice: /);
  assert.equal(tamper((r) => { r.players[1].glaze = r.players[0].glaze; }), 'the players\' glazes match');
  assert.equal(tamper((r) => { r.ending = 'forfeit'; }), 'forfeitReason');
  assert.equal(tamper((r) => { r.commitments[0] = 'XYZ'; }), 'commitments');
  // The original still checks.
  assert.equal(checkRecord(rec), null);
});

test('a forfeit can\'t be dressed up as a win, nor a win as a forfeit', () => {
  const won = finished(6);
  const r = clone(won);
  r.ending = 'forfeit'; r.forfeitReason = 'away';
  r.winner = r.winner === 1 ? 2 : 1;                                   // the loser claims the other walked away…
  assert.ok(!verifyMatch(r).ok);                                       // …but the winning turn is still there
});

test('the match lexicon lists what the record holds, and the lounge is one record per account', () => {
  const lex = JSON.parse(readFileSync(join(root, 'lexicons/cafe.thunderbird.daisy.match.json'), 'utf8'));
  assert.equal(lex.id, COLLECTION);
  const main = lex.defs.main;
  assert.equal(main.key, 'tid');
  const rec = recordFor(finished(7), 1, HOUSE);
  const props = Object.keys(main.record.properties);
  for (const k of Object.keys(rec)) if (k !== '$type') assert.ok(props.includes(k), `lexicon lacks ${k}`);
  for (const k of main.record.required) assert.ok(k in rec, `record lacks ${k}`);
  assert.deepEqual(lex.defs.player.properties.glaze.knownValues, DICE_GLAZES);
  assert.deepEqual(GLAZE_IDS, DICE_GLAZES);
  assert.deepEqual(main.record.properties.forfeitReason.knownValues, FORFEIT_REASONS);
  const lounge = JSON.parse(readFileSync(join(root, 'lexicons/cafe.thunderbird.daisy.lounge.json'), 'utf8'));
  assert.equal(lounge.id, 'cafe.thunderbird.daisy.lounge');
  assert.equal(lounge.defs.main.key, 'literal:self');
});

test('the shared files in each tile are exact copies (run node scripts/sync-shared.mjs after a change)', async () => {
  const { SHARED_FOR } = await import('../scripts/sync-shared.mjs');
  const { TILES } = await import('../scripts/tiles.mjs');
  for (const [tile, files] of Object.entries(SHARED_FOR)) for (const f of files) {
    assert.equal(readFileSync(join(root, tile, f), 'utf8'), readFileSync(join(root, 'shared', f), 'utf8'), `${tile}/${f}`);
  }
  // Every file a tile lists exists, and every module it imports is in its list.
  for (const [tile, t] of Object.entries(TILES)) {
    for (const f of t.files) assert.ok(readFileSync(join(root, tile, f)), `${tile}/${f}`);
    for (const f of t.files.filter((x) => x.endsWith('.js'))) {
      for (const m of readFileSync(join(root, tile, f), 'utf8').matchAll(/from '\.\/([a-z0-9-]+\.js)'/g)) assert.ok(t.files.includes(m[1]), `${tile}/${f} imports ${m[1]}`);
    }
  }
});
