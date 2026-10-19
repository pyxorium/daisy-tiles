// bot.js: the table's bot, for solo play (build step 7). It plays seat 2 from the person's own page, in a
// second copy of the house (house.js, set up with `bot: true`), so a match against the bot is a
// demonstration: both chains of dice come from the same page, and nobody else can check them.
//
// How it plays (owner, Oct 18): each turn it picks a fresh banking point from 8 to 12, at random, and
// banks once the turn is worth that much (a turn can run past it: 11 then a 6 is 17, so one turn never
// reaches 25, two can). It chooses its glaze after the person, at random from the ones left, and agrees
// to a rematch when asked.
export const BOT_BANK_FROM = 8, BOT_BANK_TO = 12;

// Its pace (owner, Oct 18): a short, human pause after each landing before it rolls again or banks, and a
// moment more at the start of its turn. The player tiles show a roll's result when the die lands, about
// SHOW_ROLL_MS after it starts (player.js: TUMBLE_MS 650 + LAND_MS 650), and the coin spins COIN_MS.
export const BOT_PAUSE_MS = 800, BOT_TURN_START_MS = 400, SHOW_ROLL_MS = 1300, SHOW_COIN_MS = 1500;

// A banking point for one turn (random() as Math.random: 0 to under 1).
export const bankPoint = (random = Math.random) => BOT_BANK_FROM + Math.floor(random() * (BOT_BANK_TO - BOT_BANK_FROM + 1));

// What the bot does next, from the referee's view of the table (viewOf), or null to wait. bankAt: this
// turn's banking point.
export function botMove(view, { bankAt = BOT_BANK_TO, random = Math.random } = {}) {
  if (view.phase === 'picking' && view.canPick) {
    const theirs = view.seats.find((s) => s.seat !== view.me);
    if (!theirs || !theirs.glaze) return null;                         // the person chooses first
    const free = view.glazes.filter((g) => g.free);
    return free.length ? { kind: 'pick', glaze: free[Math.floor(random() * free.length)].id } : null;
  }
  if (view.phase === 'over' && view.canRematch && view.otherAsked) return { kind: 'rematch' };   // agrees when the person asks
  if (view.phase !== 'playing') return null;
  if (view.canBank && view.turnTotal >= bankAt) return { kind: 'bank' };
  if (view.canRoll) return { kind: 'roll' };
  return null;
}
