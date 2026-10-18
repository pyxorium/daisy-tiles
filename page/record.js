// record.js: turns the referee's result into the record one player saves
// (cafe.thunderbird.daisy.match, one per player in their own account, record key = match id), and
// checks a record against the lexicon (lexicons/cafe.thunderbird.daisy.match.json) before saving.
// No browser parts: tested in Node, copied into the site's src/daisy/ in step 2.
import { verifyMatch } from '../shared/verify.js';

export const COLLECTION = 'cafe.thunderbird.daisy.match';
export const GLAZE_IDS = ['bone', 'jade', 'midnight', 'glow', 'brick', 'marigold'];
export const isRecordKey = (k) => typeof k === 'string' && /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(k);
const isLink = (x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);

// house: { uri, cid } of the published house tile, or null while it isn't published (then left out).
export function recordFor(result, seat, house, createdAt = new Date().toISOString()) {
  if (seat !== 1 && seat !== 2) throw new Error('seat must be 1 or 2');
  const record = {
    $type: COLLECTION,
    matchId: result.matchId,
    seat,
    target: result.target,
    players: result.players.map((p) => ({ did: p.did, handle: p.handle, glaze: p.glaze, ...(p.bot ? { bot: true } : {}) })),
    firstPlayer: result.firstPlayer,
    commitments: [...result.commitments],
    lastReveals: [...result.lastReveals],
    turns: result.turns.map((t) => ({ player: t.player, rolls: [...t.rolls], end: t.end })),
    winner: result.winner,
    ending: result.ending,
    createdAt,
  };
  if (result.rechains) record.rechains = result.rechains.map((c) => ({ fromRoll: c.fromRoll, commitments: [...c.commitments], lastReveals: [...c.lastReveals] }));
  if (result.ending === 'forfeit') record.forfeitReason = result.forfeitReason;
  if (house && typeof house.uri === 'string' && house.uri.startsWith('at://') && typeof house.cid === 'string') {
    record.house = { uri: house.uri, cid: house.cid };
  }
  return record;
}

// The other player, for the save prompt's "This record mentions @x".
export const otherPlayer = (result, seat) => result.players[seat === 1 ? 1 : 0];

// Returns null when the record matches the lexicon and its dice check out, else what's wrong.
export function checkRecord(r) {
  const int = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
  const pair = (a) => Array.isArray(a) && a.length === 2 && a.every(isLink);
  if (!r || r.$type !== COLLECTION) return '$type';
  if (!isRecordKey(r.matchId)) return 'matchId';
  if (!int(r.seat, 1, 2)) return 'seat';
  if (!int(r.target, 1, 1000)) return 'target';
  if (!Array.isArray(r.players) || r.players.length !== 2) return 'players';
  for (const p of r.players) {
    if (!p || typeof p.did !== 'string' || !/^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(p.did)) return 'player did';
    if (typeof p.handle !== 'string' || p.handle.length > 253 || !p.handle.includes('.')) return 'player handle';
    if (!GLAZE_IDS.includes(p.glaze)) return 'player glaze';
    if ('bot' in p && p.bot !== true) return 'player bot';
  }
  if (r.players[0].glaze === r.players[1].glaze) return 'the players\' glazes match';
  if (r.players[r.seat - 1].bot) return 'a bot seat does not save';
  if (!int(r.firstPlayer, 1, 2)) return 'firstPlayer';
  if (!pair(r.commitments)) return 'commitments';
  if (!pair(r.lastReveals)) return 'lastReveals';
  if ('rechains' in r && !(Array.isArray(r.rechains) && r.rechains.length <= 100 && r.rechains.every((c) => c && int(c.fromRoll, 1, 1e9) && pair(c.commitments) && pair(c.lastReveals)))) return 'rechains';
  if (!Array.isArray(r.turns) || r.turns.length > 10000) return 'turns';
  for (const t of r.turns) {
    if (!t || !int(t.player, 1, 2) || !Array.isArray(t.rolls) || t.rolls.length > 10000 || !t.rolls.every((v) => int(v, 1, 6))) return 'turn';
    if (!['bank', 'bust', 'win', 'forfeit'].includes(t.end)) return 'turn end';
  }
  if (!int(r.winner, 1, 2)) return 'winner';
  if (r.ending !== 'won' && r.ending !== 'forfeit') return 'ending';
  if ((r.ending === 'forfeit') !== ('forfeitReason' in r)) return 'forfeitReason';
  if (typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) return 'createdAt';
  if ('house' in r && !(r.house && typeof r.house.uri === 'string' && r.house.uri.startsWith('at://') && typeof r.house.cid === 'string')) return 'house';
  const v = verifyMatch(r);
  if (!v.ok) return `dice: ${v.problem}`;
  return null;
}
