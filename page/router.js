// router.js: the page's side of one seat at a Daisy table, with no browser parts so it's tested in
// Node (copied into the site's src/daisy/ by scripts/copy-to-site.mjs). Modelled on Seven-Up's relay.js.
//
// A page holds three tiles: its own house (hidden), its own player tile ("mine") and a copy of the
// player tile watching the other seat ("theirs"). The page knows which frame sent what (event.source)
// and stamps everything it passes on with `from`; whatever a tile wrote there itself is replaced.
//   mine   → house    pick, roll, bank, rematch            (from: "player")
//   mine   → page     save-request: the end screen's Save (saving is the page's job, outside the tiles)
//   theirs → (nothing but hello/pong: the watching copy has no say)
//   house  → page     to: "page"
//   house  → both player tiles   to: "players"
//   house  → the other house     to: "peer" (through the relay; game, v, to and from are left behind)
//   relay  → house    the other house's messages              (from: "peer")
//   mine   → relay → the other page's "theirs" copy: die-view, the shared view of your die (around
//            the house: it never touches the game or the record; latest wins)
//   page   → house / player tiles   the page's own messages  (from: "page")

export const GAME = 'daisy';
export const VERSION = 1;
export const FRAMES = ['house', 'mine', 'theirs'];

export const PLAYER_TO_HOUSE = ['pick', 'roll', 'bank', 'rematch'];
export const TILE_TO_PAGE = ['hello', 'pong'];
export const PLAYER_TO_PAGE = ['save-request'];         // only from your own tile, never the watching copy
export const HOUSE_TO_PAGE = ['hello', 'pong', 'state', 'result', 'ignored', 'resumed'];
export const HOUSE_TO_PEER = ['commit', 'pick', 'reveal', 'roll', 'bank', 'rematch', 'forfeit', 'abandon', 'resend'];
export const HOUSE_TO_PLAYERS = ['view', 'picking', 'taken', 'flipping', 'flip', 'turn', 'rolling', 'rolled', 'bust', 'banked',
  'win', 'nudge', 'forfeit', 'match-over', 'rematch-asked', 'rematch', 'abandoned'];
export const PAGE_TO_HOUSE = ['ping', 'setup', 'seated', 'presence', 'tick', 'reconnected'];
export const PAGE_TO_PLAYER = ['ping', 'seat', 'presence', 'save-status'];
export const PLAYER_TO_PEER = ['die-view'];           // the shared view: mine → relay → the other page's watching copy
export const QUIET_KINDS = ['ping', 'pong', 'tick', 'state', 'view', 'die-view'];   // too frequent for the message log

export const LIMITS = { maxBytes: 64 * 1024, burst: 80, perSecond: 40 };   // room for the shared view (15 a second)

export function sizeOf(x) { try { return JSON.stringify(x).length; } catch { return Infinity; } }

export function createRouter({ deliver, toRelay, onPage = () => {}, onLog = () => {}, now = () => Date.now(), limits = LIMITS }) {
  const buckets = Object.fromEntries([...FRAMES, 'relay'].map((s) => [s, { tokens: limits.burst, at: now() }]));
  const allowed = (who) => {
    const b = buckets[who], t = now();
    b.tokens = Math.min(limits.burst, b.tokens + ((t - b.at) / 1000) * limits.perSecond);
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
  const drop = (from, kind, why) => { onLog({ dir: 'drop', from, kind, why }); return why; };
  const stamp = (raw, from) => { const { to, ...rest } = raw; return { ...rest, game: GAME, v: VERSION, from }; };
  const log = (entry) => { if (!QUIET_KINDS.includes(entry.kind)) onLog(entry); };

  // A payload from one of the three frames. Returns null when passed on, or why it was dropped.
  function fromTile(frame, raw) {
    if (!FRAMES.includes(frame)) return drop(frame, raw && raw.kind, 'unknown frame');
    if (!raw || typeof raw !== 'object' || raw.game !== GAME || raw.v !== VERSION || typeof raw.kind !== 'string') return drop(frame, raw && raw.kind, 'not a Daisy message');
    if (sizeOf(raw) > limits.maxBytes) return drop(frame, raw.kind, 'too big');
    if (!allowed(frame)) return drop(frame, raw.kind, 'too many');
    const kind = raw.kind;
    if (frame === 'house') {
      if (raw.to === 'page') {
        if (!HOUSE_TO_PAGE.includes(kind)) return drop(frame, kind, 'house may not send that to the page');
        log({ dir: 'page', from: 'house', kind });
        onPage('house', stamp(raw, 'house'));
        return null;
      }
      if (raw.to === 'peer') {
        if (!HOUSE_TO_PEER.includes(kind)) return drop(frame, kind, 'house may not send that to the other house');
        const { game, v, to, from, ...data } = raw;
        log({ dir: 'out', from: 'house', to: 'peer', kind });
        toRelay(data);
        return null;
      }
      if (raw.to === 'players') {
        if (!HOUSE_TO_PLAYERS.includes(kind)) return drop(frame, kind, 'house may not send that to the players');
        const p = stamp(raw, 'house');
        deliver('mine', p); deliver('theirs', p);
        log({ dir: 'relay', from: 'house', to: 'players', kind });
        return null;
      }
      return drop(frame, kind, 'no such recipient');
    }
    if (TILE_TO_PAGE.includes(kind)) { onPage(frame, stamp(raw, frame)); log({ dir: 'page', from: frame, kind }); return null; }
    if (frame === 'theirs') return drop(frame, kind, 'the watching copy has no say');
    if (PLAYER_TO_PAGE.includes(kind)) { onPage('mine', stamp(raw, 'mine')); log({ dir: 'page', from: 'mine', kind }); return null; }
    if (PLAYER_TO_PEER.includes(kind)) {
      const { game, v, to, from, ...data } = raw;
      onPage('mine', stamp(raw, 'mine'));                 // the page keeps the latest, to send again after a reconnect
      toRelay(data);
      return null;
    }
    if (!PLAYER_TO_HOUSE.includes(kind)) return drop(frame, kind, 'players may not send that');
    deliver('house', stamp(raw, 'player'));
    log({ dir: 'relay', from: 'mine', to: 'house', kind });
    return null;
  }

  // The other house's message, from the relay.
  function fromRelay(data) {
    if (!data || typeof data !== 'object' || typeof data.kind !== 'string') return drop('relay', data && data.kind, 'not a message');
    if (PLAYER_TO_PEER.includes(data.kind)) {
      if (sizeOf(data) > 2048) return drop('relay', data.kind, 'too big');
      if (!allowed('relay')) return drop('relay', data.kind, 'too many');
      deliver('theirs', stamp(data, 'peer'));
      onPage('peer', stamp(data, 'peer'));
      return null;
    }
    if (!HOUSE_TO_PEER.includes(data.kind)) return drop('relay', data.kind, 'the other house may not send that');
    if (sizeOf(data) > limits.maxBytes) return drop('relay', data.kind, 'too big');
    if (!allowed('relay')) return drop('relay', data.kind, 'too many');
    deliver('house', stamp(data, 'peer'));
    log({ dir: 'in', from: 'peer', to: 'house', kind: data.kind });
    return null;
  }

  // The page's own messages, checked so a typo can't slip through.
  function fromPage(target, kind, fields = {}) {
    const ok = target === 'house' ? PAGE_TO_HOUSE.includes(kind) : (target === 'mine' || target === 'theirs') && PAGE_TO_PLAYER.includes(kind);
    if (!ok) throw new Error(`page may not send ${kind} to ${target}`);
    deliver(target, { ...fields, game: GAME, v: VERSION, kind, from: 'page' });
    log({ dir: 'relay', from: 'page', to: target, kind });
  }

  return { fromTile, fromRelay, fromPage };
}
