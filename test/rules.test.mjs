import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, roll, bank, forfeit, replay, turnTotal, bigBankFor, TARGETS } from '../shared/rules.js';

// Apply a list of moves: numbers are rolls by whoever's turn it is, "b" banks.
function play(game, moves) {
  for (const m of moves) {
    const r = m === 'b' ? bank(game, game.turn) : roll(game, game.turn, m);
    assert.ok(!r.error, r.error);
    game = r.game;
  }
  return game;
}

test('only 25 is offered while testing; the 🌼 burst is for a bank of 10 or more at 25', () => {
  assert.deepEqual(TARGETS, [25]);
  assert.equal(bigBankFor(25), 10);
});

test('rolling adds up the turn; a 1 loses it and passes the turn', () => {
  let g = newGame({ first: 2 });
  g = play(g, [4, 6]);
  assert.equal(turnTotal(g), 10);
  assert.equal(g.turn, 2);
  const r = roll(g, 2, 1);
  assert.deepEqual(r.events.map((e) => e.kind), ['rolled', 'bust', 'turn']);
  assert.equal(r.events[1].lost, 10);
  assert.deepEqual(r.game.scores, [0, 0]);
  assert.equal(r.game.turn, 1);
  assert.deepEqual(r.game.turns, [{ player: 2, rolls: [4, 6, 1], end: 'bust' }]);
});

test('bank keeps the turn and passes it; banking needs at least one roll this turn', () => {
  let g = newGame({ first: 1 });
  assert.equal(bank(g, 1).error, 'roll at least once before banking');
  g = play(g, [5, 6]);
  const r = bank(g, 1);
  assert.deepEqual(r.events[0], { kind: 'banked', seat: 1, points: 11, score: 11, big: true });
  assert.equal(r.game.turn, 2);
  assert.deepEqual(r.game.turns, [{ player: 1, rolls: [5, 6], end: 'bank' }]);
  g = play(r.game, [3, 'b']);
  assert.deepEqual(g.scores, [11, 3]);
  assert.equal(bank(g, 1).error, 'roll at least once before banking');
  assert.equal(bank(play(g, [2]), 1).events[0].big, false);
});

test('the win comes the moment banked score + turn total reaches the target, mid-turn, no bank needed', () => {
  let g = play(newGame({ first: 1 }), [6, 6, 'b']);              // seat 1 has 12
  g = play(g, [2, 'b']);                                           // seat 2 has 2
  const before = play(g, [6, 6]);                                  // seat 1: 12 + 12 = 24
  assert.equal(before.winner, null);
  const bust = roll(before, 1, 1);                                 // one short: a 1 still busts
  assert.equal(bust.game.winner, null);
  assert.equal(bust.events[1].kind, 'bust');
  assert.deepEqual(bust.game.scores, [12, 2]);
  const win = play(g, [6, 6, 5]);                                  // 12 + 17 = 29: overshoot wins too
  assert.equal(win.winner, 1);
  assert.equal(win.ending, 'won');
  assert.deepEqual(win.scores, [29, 2]);
  assert.deepEqual(win.turns.at(-1), { player: 1, rolls: [6, 6, 5], end: 'win' });
  const exactly = play(g, [6, 5, 2]);                              // 12 + 13 = 25 exactly
  assert.equal(exactly.winner, 1);
  assert.equal(exactly.scores[0], 25);
});

test('first to 25 can end the game before the second player ever rolls', () => {
  const g = play(newGame({ first: 2 }), [6, 6, 6, 4, 3]);          // 25 in the first turn
  assert.equal(g.winner, 2);
  assert.deepEqual(g.turns, [{ player: 2, rolls: [6, 6, 6, 4, 3], end: 'win' }]);
});

test('wrong seat, a finished game, and faces outside 1 to 6 are refused', () => {
  const g = newGame({ first: 1 });
  assert.equal(roll(g, 2, 4).error, 'not your turn');
  assert.equal(bank(g, 2).error, 'not your turn');
  assert.equal(roll(g, 1, 7).error, 'a die shows 1 to 6');
  assert.equal(roll(g, 1, 0).error, 'a die shows 1 to 6');
  assert.equal(roll(g, 3, 2).error, 'no such seat');
  const won = play(g, [6, 6, 6, 6, 6]);
  assert.equal(roll(won, 2, 3).error, 'the game is over');
  assert.equal(forfeit(won, 2, 'away').error, 'the game is over');
});

test('a forfeit ends it for the other player, keeping a turn under way', () => {
  const g = play(newGame({ first: 1 }), [3, 'b', 4, 5]);           // seat 2 has rolled 4 and 5
  const f = forfeit(g, 2, 'away');
  assert.equal(f.game.winner, 1);
  assert.equal(f.game.ending, 'forfeit');
  assert.equal(f.game.forfeitReason, 'away');
  assert.deepEqual(f.game.turns.at(-1), { player: 2, rolls: [4, 5], end: 'forfeit' });
  const fresh = forfeit(play(newGame({ first: 1 }), [3, 'b']), 1, 'turn-timeout');   // seat 2's turn, no rolls yet
  assert.equal(fresh.game.winner, 2);
  assert.equal(fresh.game.turns.length, 1);
  assert.equal(forfeit(g, 2, 'bored').error, 'unknown reason');
});

test('the rules never change the game they were given', () => {
  const g = play(newGame({ first: 1 }), [4]);
  const before = JSON.stringify(g);
  roll(g, 1, 1); roll(g, 1, 6); bank(g, 1); forfeit(g, 2, 'away');
  assert.equal(JSON.stringify(g), before);
});

test('replay folds a list of actions, and names the one the rules refuse', () => {
  const r = replay({ target: 25, first: 1 }, [
    { type: 'roll', seat: 1, value: 4 }, { type: 'bank', seat: 1 }, { type: 'roll', seat: 2, value: 1 },
  ]);
  assert.deepEqual(r.game.scores, [4, 0]);
  assert.equal(r.game.turn, 1);
  const bad = replay({ target: 25, first: 1 }, [{ type: 'bank', seat: 1 }]);
  assert.equal(bad.at, 0);
});
