// bot.js: the table's bot, for solo play. It plays seat 2 from the person's own page (so, as in
// Seven-Up, a match against the bot is a demonstration, not something another person can check).
// Textbook Pig: keep rolling until the turn is worth 20, then bank. (A bolder bot when behind is on
// the later list.)
export const BOT_BANKS_AT = 20;

// What the bot does next, from the referee's view of the table (viewOf), or null to wait.
export function botMove(view) {
  if (view.phase === 'picking' && view.canPick) {
    const free = view.glazes.filter((g) => g.free);
    return free.length ? { kind: 'pick', glaze: free[Math.floor(Math.random() * free.length)].id } : null;
  }
  if (view.phase === 'over' && view.canRematch && view.otherAsked) return { kind: 'rematch' };   // agrees when the person asks
  if (view.phase !== 'playing') return null;
  if (view.canBank && view.turnTotal >= BOT_BANKS_AT) return { kind: 'bank' };
  if (view.canRoll) return { kind: 'roll' };
  return null;
}
