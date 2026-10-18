// rules.js: Daisy's rules (Pig, renamed), as plain functions with no clock, network or randomness.
// The dice come from outside (dice.js, through the referee); these functions only say what a roll or a
// bank does. Every function returns a new game and never changes the one it was given.
//
// One die. On your turn roll as often as you like; a 1 loses that turn's points and passes the turn;
// Bank adds the turn's points to your score and passes the turn, and needs at least one roll this turn
// (Oct 18). The moment banked score + turn total reaches the target, that player wins: the game ends at
// once (classic), so the second player may get no turn.
//
// Seats are 1 and 2 throughout, as in the record.

export const TARGETS = [25];                 // the house settings offered (only 25 while testing)
export const DEFAULT_TARGET = 25;
export const BUST_FACE = 1;
// A bank big enough for the 🌼 burst on both screens: 10 at a target of 25.
export const bigBankFor = (target) => Math.max(1, Math.round(target * 0.4));
export const otherSeat = (seat) => (seat === 1 ? 2 : 1);

export function newGame({ target = DEFAULT_TARGET, first }) {
  if (!Number.isInteger(target) || target < 1) throw new Error('target must be a whole number');
  if (first !== 1 && first !== 2) throw new Error('first must be seat 1 or 2');
  return {
    target, first,
    scores: [0, 0],          // banked, by seat
    turn: first,             // whose turn (null once over)
    turnRolls: [],           // this turn's rolls so far
    turns: [],               // finished turns: { player, rolls, end: "bank" | "bust" | "win" | "forfeit" }
    winner: null,
    ending: null,            // "won" | "forfeit"
    forfeitReason: null,     // "turn-timeout" | "away" | "no-reveal"
  };
}

const copy = (g) => ({ ...g, scores: [...g.scores], turnRolls: [...g.turnRolls], turns: g.turns.map((t) => ({ ...t, rolls: [...t.rolls] })) });
export const turnTotal = (g) => g.turnRolls.reduce((a, b) => a + b, 0);
export const isOver = (g) => g.winner !== null;

function check(g, seat) {
  if (isOver(g)) return 'the game is over';
  if (seat !== 1 && seat !== 2) return 'no such seat';
  if (g.turn !== seat) return 'not your turn';
  return null;
}

// A roll of `value` by `seat`. Returns { game, events } or { error }.
export function roll(g, seat, value) {
  const problem = check(g, seat);
  if (problem) return { error: problem };
  if (!Number.isInteger(value) || value < 1 || value > 6) return { error: 'a die shows 1 to 6' };
  const game = copy(g);
  game.turnRolls.push(value);
  const events = [{ kind: 'rolled', seat, value }];
  if (value === BUST_FACE) {
    const lost = turnTotal(g);
    game.turns.push({ player: seat, rolls: game.turnRolls, end: 'bust' });
    game.turnRolls = [];
    game.turn = otherSeat(seat);
    events.push({ kind: 'bust', seat, lost }, { kind: 'turn', seat: game.turn });
    return { game, events };
  }
  const total = game.scores[seat - 1] + turnTotal(game);
  if (total >= game.target) {
    game.scores[seat - 1] = total;
    game.turns.push({ player: seat, rolls: game.turnRolls, end: 'win' });
    game.turnRolls = [];
    game.turn = null;
    game.winner = seat;
    game.ending = 'won';
    events.push({ kind: 'win', seat, score: total });
    return { game, events };
  }
  events[0].turnTotal = turnTotal(game);
  return { game, events };
}

// Bank by `seat`. Needs at least one roll this turn.
export function bank(g, seat) {
  const problem = check(g, seat);
  if (problem) return { error: problem };
  if (!g.turnRolls.length) return { error: 'roll at least once before banking' };
  const game = copy(g);
  const points = turnTotal(g);
  game.scores[seat - 1] += points;
  game.turns.push({ player: seat, rolls: game.turnRolls, end: 'bank' });
  game.turnRolls = [];
  game.turn = otherSeat(seat);
  const events = [
    { kind: 'banked', seat, points, score: game.scores[seat - 1], big: points >= bigBankFor(g.target) },
    { kind: 'turn', seat: game.turn },
  ];
  return { game, events };
}

// `loser` forfeits (walked away, stopped revealing, or let the turn timer run out). A turn under way
// with rolls in it is kept, marked "forfeit".
export const FORFEIT_REASONS = ['turn-timeout', 'away', 'no-reveal'];
export function forfeit(g, loser, reason) {
  if (isOver(g)) return { error: 'the game is over' };
  if (loser !== 1 && loser !== 2) return { error: 'no such seat' };
  if (!FORFEIT_REASONS.includes(reason)) return { error: 'unknown reason' };
  const game = copy(g);
  if (game.turnRolls.length) game.turns.push({ player: game.turn, rolls: game.turnRolls, end: 'forfeit' });
  game.turnRolls = [];
  game.turn = null;
  game.winner = otherSeat(loser);
  game.ending = 'forfeit';
  game.forfeitReason = reason;
  return { game, events: [{ kind: 'forfeit', seat: loser, reason, winner: game.winner }] };
}

// Replays a list of actions ({ type: "roll", seat, value } | { type: "bank", seat }) from the start.
// Returns { game, events } or { error, at } (the index of the action that was refused).
export function replay({ target, first }, actions) {
  let game = newGame({ target, first });
  const events = [];
  for (const [at, a] of actions.entries()) {
    const r = a.type === 'roll' ? roll(game, a.seat, a.value) : a.type === 'bank' ? bank(game, a.seat) : { error: 'unknown action' };
    if (r.error) return { error: r.error, at };
    game = r.game;
    events.push(...r.events);
  }
  return { game, events };
}
