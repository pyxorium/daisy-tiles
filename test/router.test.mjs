import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, GAME, VERSION } from '../page/router.js';

function setup() {
  const got = { house: [], mine: [], theirs: [], bot: [], relay: [], page: [], log: [] };
  const r = createRouter({
    deliver: (frame, p) => got[frame].push(p),
    toRelay: (d) => got.relay.push(d),
    onPage: (from, p) => got.page.push({ from, ...p }),
    onLog: (e) => got.log.push(e),
  });
  return { r, got };
}
const m = (kind, fields = {}) => ({ ...fields, game: GAME, v: VERSION, kind });

test('my player tile\'s moves go to my house, stamped "player"; the watching copy has no say', () => {
  const { r, got } = setup();
  assert.equal(r.fromTile('mine', m('roll', { from: 'peer' })), null);
  assert.deepEqual(got.house, [m('roll', { from: 'player' })]);
  assert.equal(r.fromTile('theirs', m('roll')), 'the watching copy has no say');
  assert.equal(r.fromTile('mine', m('commit')), 'players may not send that');
  r.fromTile('theirs', m('hello', { role: 'player' }));
  assert.equal(got.page[0].from, 'theirs');
});

test('the house: to the page, to both player tiles, and to the other house through the relay (bare)', () => {
  const { r, got } = setup();
  r.fromTile('house', m('result', { to: 'page', result: { winner: 1 } }));
  assert.equal(got.page[0].kind, 'result');
  r.fromTile('house', m('view', { to: 'players', view: { phase: 'playing' } }));
  assert.equal(got.mine.length, 1); assert.equal(got.theirs.length, 1);
  assert.equal(got.mine[0].from, 'house');
  r.fromTile('house', m('roll', { to: 'peer', n: 3, reveal: 'ab', seq: 7, matchNo: 1 }));
  assert.deepEqual(got.relay, [{ kind: 'roll', n: 3, reveal: 'ab', seq: 7, matchNo: 1 }]);
  assert.equal(r.fromTile('house', m('view', { to: 'peer' })), 'house may not send that to the other house');
  assert.equal(r.fromTile('house', m('roll', { to: 'seat1' })), 'no such recipient');
  assert.equal(r.fromTile('house', { kind: 'view' }), 'not a Daisy message');
});

test('the other house\'s messages reach my house stamped "peer"; anything else is dropped', () => {
  const { r, got } = setup();
  assert.equal(r.fromRelay({ kind: 'reveal', n: 1, reveal: 'cd', from: 'player' }), null);
  assert.deepEqual(got.house, [{ kind: 'reveal', n: 1, reveal: 'cd', game: GAME, v: VERSION, from: 'peer' }]);
  assert.equal(r.fromRelay({ kind: 'tick' }), 'the other house may not send that');
  assert.equal(r.fromRelay({ kind: 'roll', pad: 'x'.repeat(70000) }), 'too big');
});

test('the page\'s own messages are checked', () => {
  const { r, got } = setup();
  r.fromPage('house', 'tick');
  r.fromPage('theirs', 'seat', { seat: 2, watching: true });
  assert.equal(got.house[0].from, 'page');
  assert.equal(got.theirs[0].watching, true);
  assert.throws(() => r.fromPage('house', 'roll'));
  assert.throws(() => r.fromPage('mine', 'view'));
  assert.equal(got.log.filter((e) => e.kind === 'tick').length, 0);            // quiet kinds stay out of the log
});

test('a flood from one frame is cut off', () => {
  let t = 0;
  const got = [];
  const r = createRouter({ deliver: (f, p) => got.push(p), toRelay() {}, now: () => t, limits: { maxBytes: 65536, burst: 5, perSecond: 1 } });
  const results = Array.from({ length: 8 }, () => r.fromTile('mine', m('roll')));
  assert.equal(results.filter((x) => x === null).length, 5);
  assert.equal(results.at(-1), 'too many');
});

test('the shared view: my tile\'s die-view goes to the relay (and the page keeps it); the other page\'s reaches only my watching copy', () => {
  const { r, got } = setup();
  const view = { q: [0, 0, 0, 1], z: 5.2 };
  assert.equal(r.fromTile('mine', m('die-view', view)), null);
  assert.deepEqual(got.relay, [{ kind: 'die-view', ...view }]);
  assert.equal(got.page.at(-1).kind, 'die-view');
  assert.equal(got.house.length, 0);
  assert.equal(r.fromTile('theirs', m('die-view', view)), 'the watching copy has no say');
  assert.equal(r.fromRelay({ kind: 'die-view', ...view }), null);
  assert.equal(got.theirs.at(-1).kind, 'die-view');
  assert.equal(got.theirs.at(-1).from, 'peer');
  assert.equal(got.mine.length, 0);
  assert.equal(got.house.length, 0);
  assert.equal(r.fromRelay({ kind: 'die-view', pad: 'x'.repeat(3000) }), 'too big');
  assert.equal(got.log.filter((e) => e.kind === 'die-view' && e.dir !== 'drop').length, 0);   // too frequent for the log (drops still show)
});

test('saving: only your own tile can ask the page to save (never the watching copy); the page answers with save-status', () => {
  const { r, got } = setup();
  assert.equal(r.fromTile('mine', m('save-request')), null);
  assert.deepEqual(got.page.map((p) => [p.from, p.kind]), [['mine', 'save-request']]);
  assert.equal(got.house.length, 0, 'the house never hears it');
  assert.equal(got.relay.length, 0, 'nor the other page');
  assert.equal(r.fromTile('theirs', m('save-request')), 'the watching copy has no say');
  r.fromPage('mine', 'save-status', { state: 'saved', handle: 'pyxorium.com' });
  assert.equal(got.mine.at(-1).kind, 'save-status');
  assert.throws(() => r.fromPage('house', 'save-status', {}));
});

test('against the bot: the two houses talk through the page (no relay); the bot\'s views go nowhere', () => {
  const { r, got } = setup();
  // The bot's house → your house, as if from the other house.
  assert.equal(r.fromTile('bot', m('commit', { to: 'peer', chain: 0, seq: 1, matchNo: 1 })), null);
  assert.deepEqual(got.house, [m('commit', { chain: 0, seq: 1, matchNo: 1, from: 'peer' })]);
  assert.equal(got.relay.length, 0);
  // Your house → the bot's house.
  assert.equal(r.toBot({ kind: 'pick', glaze: 'jade', seq: 2, matchNo: 1 }), null);
  assert.deepEqual(got.bot, [m('pick', { glaze: 'jade', seq: 2, matchNo: 1, from: 'peer' })]);
  assert.equal(r.toBot({ kind: 'view' }), 'not for the other house');
  // Its snapshot goes to the page; its views to nobody.
  r.fromTile('bot', m('state', { to: 'page', snapshot: { me: 2 } }));
  assert.equal(got.page.at(-1).from, 'bot');
  assert.equal(r.fromTile('bot', m('view', { to: 'players', view: {} })), null);
  assert.equal(got.mine.length + got.theirs.length, 0);
  assert.equal(r.fromTile('bot', m('roll', { to: 'page' })), 'house may not send that to the page');
  // The page sets it up like a house.
  r.fromPage('bot', 'setup', { seat: 2, bot: true });
  assert.equal(got.bot.at(-1).kind, 'setup');
  assert.throws(() => r.fromPage('bot', 'seat', {}));
});
