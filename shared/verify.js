// verify.js: re-checks a finished match from its record alone (or from the referee's result, which has
// the same fields). Anyone can run it: from each player's last revealed link it rebuilds every earlier
// reveal back up to their commitment, recomputes the coin and every die, and replays the rules.
// So a record shows the dice weren't chosen, even after a forfeit, and no seed is ever handed over.
import { revealsFrom, dieFrom, coinFrom, isLink } from './dice.js';
import { replay, forfeit, FORFEIT_REASONS, otherSeat } from './rules.js';
import { isTid } from './tid.js';

// Returns { ok: true, rolls } (rolls: every die value in order) or { ok: false, problem }.
export function verifyMatch(m) {
  const bad = (problem) => ({ ok: false, problem });
  if (!m || typeof m !== 'object') return bad('not a match');
  if (!isTid(m.matchId)) return bad('matchId');
  if (!Number.isInteger(m.target) || m.target < 1) return bad('target');
  if (m.firstPlayer !== 1 && m.firstPlayer !== 2) return bad('firstPlayer');
  if (!Array.isArray(m.turns)) return bad('turns');

  // The chains: the first, then any rechains, each with both commitments and both last reveals.
  const chains = [{ fromRoll: 0, commitments: m.commitments, lastReveals: m.lastReveals }, ...(m.rechains || [])];
  const reveals = [[], []];                  // by seat, indexed by roll number (0 = the coin)
  let expectFrom = 0;
  for (const [k, c] of chains.entries()) {
    if (!c || c.fromRoll !== expectFrom) return bad(`chain ${k} starts at the wrong roll`);
    if (!Array.isArray(c.commitments) || c.commitments.length !== 2 || !c.commitments.every(isLink)) return bad(`chain ${k} commitments`);
    if (!Array.isArray(c.lastReveals) || c.lastReveals.length !== 2 || !c.lastReveals.every(isLink)) return bad(`chain ${k} last reveals`);
    const walks = [0, 1].map((s) => revealsFrom(c.lastReveals[s], c.commitments[s]));
    if (!walks[0] || !walks[1]) return bad(`chain ${k}: a last reveal doesn't lead back to its commitment`);
    if (walks[0].length !== walks[1].length) return bad(`chain ${k}: the players revealed different numbers of links`);
    for (const s of [0, 1]) reveals[s].push(...walks[s]);
    expectFrom += walks[0].length;
  }

  // Every revealed roll: the coin, then one die per recorded roll.
  const recorded = m.turns.flatMap((t) => (t && Array.isArray(t.rolls) ? t.rolls : []));
  if (reveals[0].length !== recorded.length + 1) return bad(`the reveals cover ${reveals[0].length} rolls, the turns ${recorded.length + 1} (with the coin)`);
  if (coinFrom(m.matchId, reveals[0][0], reveals[1][0]) !== m.firstPlayer) return bad('the coin chose the other player');
  const rolls = recorded.map((_, i) => dieFrom(m.matchId, i + 1, reveals[0][i + 1], reveals[1][i + 1]));
  for (const [i, v] of rolls.entries()) if (recorded[i] !== v) return bad(`roll ${i + 1} was a ${v}, the record says ${recorded[i]}`);

  // Replay the rules with those dice and the recorded banks; the turns must come out the same.
  const actions = [];
  const last = m.turns.length - 1;
  for (const [i, t] of m.turns.entries()) {
    if (!t || (t.player !== 1 && t.player !== 2)) return bad(`turn ${i + 1} player`);
    for (const value of t.rolls) actions.push({ type: 'roll', seat: t.player, value });
    if (t.end === 'bank') actions.push({ type: 'bank', seat: t.player });
    else if (t.end === 'forfeit' && i !== last) return bad('only the last turn can end in a forfeit');
    else if (!['bust', 'win', 'forfeit'].includes(t.end)) return bad(`turn ${i + 1} end`);
  }
  const r = replay({ target: m.target, first: m.firstPlayer }, actions);
  if (r.error) return bad(`the rules refuse action ${r.at + 1}: ${r.error}`);
  let game = r.game;
  if (m.ending === 'forfeit') {
    if (!FORFEIT_REASONS.includes(m.forfeitReason)) return bad('forfeitReason');
    if (m.winner !== 1 && m.winner !== 2) return bad('winner');
    const f = forfeit(game, otherSeat(m.winner), m.forfeitReason);
    if (f.error) return bad(`forfeit: ${f.error}`);
    game = f.game;
  } else if (m.ending !== 'won') return bad('ending');
  if (game.winner !== m.winner) return bad('winner');
  if (JSON.stringify(game.turns) !== JSON.stringify(m.turns.map((t) => ({ player: t.player, rolls: t.rolls, end: t.end })))) return bad('the turns don\'t follow the rules');
  return { ok: true, rolls };
}
