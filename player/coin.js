// coin.js: Daisy's coin toss (Raku step 5c, Oct 21 2026): how it looks, how long it takes, and where its
// seed comes from. The same file is in house/ and player/ (scripts/sync-shared.mjs; tiles can't share
// files once published). The look and the timings were tuned by the owner in a lil-gui panel
// (claude/raku-stage5c-plan.md, "The owner's settings").
//
// The house decides who goes first (dice.js coinFrom, from both players' reveals) and hands its player
// tile the seed and the timings with the flip; the player tile only animates (player/coin3d.js). Both
// houses derive the same seed from the same reveals, so both computers toss the same coin the same way,
// and nobody can choose the toss: it can't be known before the coin is decided (Q75).
import { sha256, utf8 } from './sha256.js';

// The look (player/coin3d.js reads it; numbers are in the tuning panel's units).
export const COIN_LOOK = Object.freeze({
  camTilt: 0.7, lampAz: 16, lampEl: 47,
  size: 1.24, thickness: 0.095, rimWidth: 0.08, rimHeight: 0.019, outerBevel: 0.047,
  ridges: 155, ridgeDepth: 0.23, metalColor: '#cfd3d8', rimGlow: 0.165,
  mRough: 0.44, mGlint: 0.98, mBump: 0.61, mGrain: 3.3, mIri: 0.14, mIRange: 2.35, mIHue: 0.24, mIShift: 1.44, mIPatch: 0.57,
  mCrack: 0, mCrackDark: 0.25, mCrackCell: 0.17,
  daisySize: 0.72, petals: 12, relief: 0.035, reliefSoft: 0.35, daisyMetal: '#cfd3d8', centre: '#f2b233',
  fRough: 0.15, fGlint: 0.6, fBump: 0.05, fGrain: 9, fIri: 0.08, fIRange: 0.8, fIHue: 0.3, fIShift: 1, fIPatch: 0.5,
  fCrack: 0.15, fCrackDark: 0.35, fCrackCell: 0.12,
  shadow: true, shDark: 0.28, shSoft: 0.5, keepSize: 16,
});

// The timings, in milliseconds (and the toss's shape). The house sends these with the flip, so the
// screens and the bot keep one clock (Q63).
export const COIN_TIMINGS = Object.freeze({
  still: 300, air: 1500, flips: 3, height: 0.95, wobble: 0.25, bounces: 2, bounceHeight: 0.22,
  settle: 700, settleTilt: 0.22, rest: 1200, handoff: 450,
});

// Sane limits for timings that arrive in a message (anything else falls back to COIN_TIMINGS).
const LIMITS = {
  still: [0, 3000], air: [100, 4000], flips: [0.5, 10], height: [0, 4], wobble: [0, 2], bounces: [0, 5],
  bounceHeight: [0, 0.9], settle: [0, 4000], settleTilt: [0, 1], rest: [0, 6000], handoff: [0, 3000],
};
export function cleanTimings(t) {
  if (!t || typeof t !== 'object') return { ...COIN_TIMINGS };
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const v = t[k];
    out[k] = typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : COIN_TIMINGS[k];
  }
  out.bounces = Math.round(out.bounces);
  return out;
}

// The sequence: still, air, the bounces (each shorter, as a lower hop takes less time), the settle, the
// rest on the winning face, the hand-off to the die. Roll is free at the end (Q63).
export function coinPlan(timings = COIN_TIMINGS) {
  const T = cleanTimings(timings);
  const seg = [{ k: 'still', d: T.still }, { k: 'air', d: T.air }];
  for (let i = 1; i <= T.bounces; i++) {
    const share = Math.pow(T.bounceHeight, i);
    seg.push({ k: 'bounce', i, d: T.air * Math.sqrt(share), share });
  }
  seg.push({ k: 'settle', d: T.settle }, { k: 'rest', d: T.rest }, { k: 'handoff', d: T.handoff });
  let t = 0;
  for (const s of seg) { s.t0 = t; t += s.d; }
  const landsAt = T.still + T.air;
  return { timings: T, seg, total: Math.round(t), landsAt, stillAt: Math.round(t - T.rest - T.handoff), restEnds: Math.round(t - T.handoff) };
}
export const COIN_TOTAL_MS = coinPlan().total;

// The toss's seed: from the match id and the two coin reveals, the same values coinFrom uses. A 32-bit
// whole number.
export function tossSeed(matchId, r1, r2) {
  const h = sha256(utf8(['daisy', 'toss', String(matchId), String(r1), String(r2)].join('|')));
  return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
}
