import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay, isTableId } from '../relay/tables.js';
import { startRelay } from '../scripts/relay-standin.mjs';

const A = { did: 'did:plc:rqbqpaaluty5v47jwciowpik', handle: 'pyxorium.com' };
const B = { did: 'did:plc:joer5rzmwgec3dkr4srfmq45', handle: 'thunderbirdwine.bsky.social' };
const C = { did: 'did:plc:ro563p5faldqu44apudq44k4', handle: 'colorado.atprotocol.space' };
const TABLE = 'k7q3m2xw9a';
const msg = (x) => JSON.stringify(x);
const to = (out, conn) => out.filter((o) => o.conn === conn).map((o) => o.msg);

test('joining: seat 1 opens, "any" takes seat 2, a third account hears "full"', () => {
  const r = createRelay();
  const a = {}, b = {}, c = {};
  [a, b, c].forEach((x) => r.open(x));
  assert.deepEqual(r.receive(a, msg({ type: 'join', table: TABLE, seat: 1, ...A })), [{ conn: a, msg: { type: 'joined', table: TABLE, seat: 1, other: null } }]);
  const out = r.receive(b, msg({ type: 'join', table: TABLE, seat: 'any', ...B }));
  assert.deepEqual(to(out, b), [{ type: 'joined', table: TABLE, seat: 2, other: { ...A, here: true } }]);
  assert.deepEqual(to(out, a), [{ type: 'presence', seat: 2, state: 'here', ...B }]);
  assert.deepEqual(r.receive(c, msg({ type: 'join', table: TABLE, seat: 'any', ...C })), [{ conn: c, msg: { type: 'full' } }]);
  assert.deepEqual(r.receive(c, msg({ type: 'join', table: TABLE, seat: 1, ...C })), [{ conn: c, msg: { type: 'full' } }]);
});

test('messages go to the other seat only; nobody there, they\'re dropped', () => {
  const r = createRelay();
  const a = {}, b = {};
  r.open(a); r.open(b);
  r.receive(a, msg({ type: 'join', table: TABLE, seat: 1, ...A }));
  assert.deepEqual(r.receive(a, msg({ type: 'send', data: { kind: 'commit' } })), []);
  r.receive(b, msg({ type: 'join', table: TABLE, seat: 'any', ...B }));
  assert.deepEqual(r.receive(a, msg({ type: 'send', data: { kind: 'commit', seq: 1 } })), [{ conn: b, msg: { type: 'peer', data: { kind: 'commit', seq: 1 } } }]);
  assert.deepEqual(r.receive(b, msg({ type: 'send', data: { kind: 'pick' } })), [{ conn: a, msg: { type: 'peer', data: { kind: 'pick' } } }]);
});

test('a seat belongs to an account: leaving tells the other seat, coming back takes the same seat, a second tab replaces the first', () => {
  const r = createRelay();
  const a = {}, b = {}, b2 = {}, b3 = {};
  [a, b, b2, b3].forEach((x) => r.open(x));
  r.receive(a, msg({ type: 'join', table: TABLE, seat: 1, ...A }));
  r.receive(b, msg({ type: 'join', table: TABLE, seat: 'any', ...B }));
  assert.deepEqual(r.close(b), [{ conn: a, msg: { type: 'presence', seat: 2, state: 'gone', ...B } }]);
  const back = r.receive(b2, msg({ type: 'join', table: TABLE, seat: 'any', ...B }));
  assert.equal(to(back, b2)[0].seat, 2);
  assert.equal(to(back, a)[0].state, 'here');
  const again = r.receive(b3, msg({ type: 'join', table: TABLE, seat: 1, ...B }));     // asks for seat 1, gets its own
  assert.deepEqual(to(again, b2), [{ type: 'replaced' }]);
  assert.equal(to(again, b3)[0].seat, 2);
  assert.deepEqual(r.close(b2), []);                                                  // the replaced one leaving changes nothing
  assert.deepEqual(r.receive(a, msg({ type: 'send', data: { x: 1 } })), [{ conn: b3, msg: { type: 'peer', data: { x: 1 } } }]);
});

test('after a relay restart both pages rejoin their own seats', () => {
  const r = createRelay();
  const a = {}, b = {};
  r.open(a); r.open(b);
  r.receive(b, msg({ type: 'join', table: TABLE, seat: 2, ...B }));                   // seat 2 is back first
  const out = r.receive(a, msg({ type: 'join', table: TABLE, seat: 1, ...A }));
  assert.equal(to(out, a)[0].seat, 1);
  assert.equal(to(out, b)[0].state, 'here');
});

test('checks: table ids, accounts, joining first, size, rate, idle tables forgotten', () => {
  let t = 0;
  const r = createRelay({ now: () => t, limits: { maxBytes: 200, burst: 3, perSecond: 1, idleTableMs: 1000 } });
  const a = {};
  r.open(a);
  assert.ok(isTableId(TABLE));
  assert.ok(!isTableId('../x'));
  assert.equal(r.receive(a, msg({ type: 'send', data: {} }))[0].msg.why, 'join a table first');
  assert.equal(r.receive(a, msg({ type: 'join', table: 'BAD!', seat: 1, ...A }))[0].msg.why, 'table');
  assert.equal(r.receive(a, 'x'.repeat(300))[0].msg.why, 'too big');
  assert.equal(r.receive(a, msg({ type: 'join', table: TABLE, seat: 3, ...A }))[0].msg.why, 'seat');
  assert.equal(r.receive(a, msg({ type: 'join', table: TABLE, seat: 1, ...A }))[0].msg.why, 'too many');   // 3 at once, then 1 a second
  t += 5000;
  assert.equal(r.receive(a, msg({ type: 'join', table: TABLE, seat: 1, did: 'nope', handle: 'x.y' }))[0].msg.why, 'account');
  r.receive(a, msg({ type: 'join', table: TABLE, seat: 1, ...A }));
  r.close(a);
  assert.equal(r.stats().tables, 1);
  t += 2000;
  r.sweep();
  assert.equal(r.stats().tables, 0);
});

test('the stand-in relay over real WebSockets: join, pass messages both ways, presence, a restart', { skip: typeof WebSocket === 'undefined' && 'needs Node 22 or later (WebSocket)' }, async () => {
  const relay = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${relay.port}/`;
  const client = () => new Promise((resolve) => {
    const ws = new WebSocket(url);
    const inbox = [];
    let wake = null;
    ws.onmessage = (e) => { inbox.push(JSON.parse(e.data)); if (wake) { wake(); wake = null; } };
    ws.onopen = () => resolve({
      ws, send: (x) => ws.send(JSON.stringify(x)),
      async next() { while (!inbox.length) await new Promise((r) => { wake = r; }); return inbox.shift(); },
    });
  });
  const a = await client(), b = await client();
  a.send({ type: 'join', table: TABLE, seat: 1, ...A });
  assert.equal((await a.next()).seat, 1);
  b.send({ type: 'join', table: TABLE, seat: 'any', ...B });
  assert.equal((await b.next()).seat, 2);
  assert.equal((await a.next()).state, 'here');
  const big = { kind: 'commit', pad: 'x'.repeat(70000 - 200) };                      // a long frame (64-bit length)
  a.send({ type: 'send', data: { kind: 'roll', n: 1 } });
  assert.deepEqual(await b.next(), { type: 'peer', data: { kind: 'roll', n: 1 } });
  b.send({ type: 'send', data: { kind: 'reveal', n: 1, reveal: 'ab'.repeat(32) } });
  assert.equal((await a.next()).data.kind, 'reveal');
  a.send({ type: 'send', data: big });
  assert.equal((await a.next()).why, 'too big');                                     // over 64 KB, refused
  b.ws.close();
  assert.equal((await a.next()).state, 'gone');
  await relay.close();
  // A new relay on the same port: both rejoin their own seats.
  const again = await startRelay({ port: relay.port });
  const a2 = await client(), b2 = await client();
  b2.send({ type: 'join', table: TABLE, seat: 2, ...B });
  assert.equal((await b2.next()).seat, 2);
  a2.send({ type: 'join', table: TABLE, seat: 1, ...A });
  assert.equal((await a2.next()).other.did, B.did);
  a2.ws.close(); b2.ws.close();
  await again.close();
});

test('a page without a seat\'s kept state can\'t take that seat: the relay says "held" and changes nothing (Oct 18)', () => {
  const r = createRelay();
  const a = {}, b = {}, b2 = {}, b3 = {};
  [a, b, b2, b3].forEach((x) => r.open(x));
  r.receive(a, msg({ type: 'join', table: TABLE, seat: 1, ...A }));
  r.receive(b, msg({ type: 'join', table: TABLE, seat: 'any', ...B }));
  assert.deepEqual(r.receive(b2, msg({ type: 'join', table: TABLE, seat: 'any', fresh: true, ...B })), [{ conn: b2, msg: { type: 'held', seat: 2 } }]);
  assert.deepEqual(r.receive(a, msg({ type: 'send', data: { x: 1 } })), [{ conn: b, msg: { type: 'peer', data: { x: 1 } } }]);   // b still sits there
  r.close(b);
  assert.equal(r.receive(b3, msg({ type: 'join', table: TABLE, seat: 'any', fresh: true, ...B }))[0].msg.type, 'held');   // even while b is away
  // A fresh account that holds no seat sits as usual; the page with kept state takes its seat back.
  const fresh = createRelay(); const x = {}; fresh.open(x);
  assert.equal(fresh.receive(x, msg({ type: 'join', table: TABLE, seat: 1, fresh: true, ...A }))[0].msg.type, 'joined');
  const back = r.receive(b3, msg({ type: 'join', table: TABLE, seat: 2, ...B }));
  assert.equal(back.find((o) => o.conn === b3).msg.type, 'joined');
});

test('the house version each page runs is passed on (never judged): in "joined", and in "presence" both ways', () => {
  const r = createRelay();
  const a = {}, b = {};
  r.open(a); r.open(b);
  const HA = 'bafyreihouseversionaaaa', HB = 'memory:0123456789abcdef';
  r.receive(a, msg({ type: 'join', table: TABLE, seat: 1, ...A, house: HA }));
  const out = r.receive(b, msg({ type: 'join', table: TABLE, seat: 'any', ...B, house: HB }));
  assert.equal(to(out, b)[0].other.house, HA);
  assert.equal(to(out, a)[0].house, HB);
  const gone = r.close(b);
  assert.equal(to(gone, a)[0].house, HB);
  const c = {};
  r.open(c);
  assert.equal(to(r.receive(c, msg({ type: 'join', table: 'zz9zz9zz9', seat: 1, ...C, house: 'bad version!' })), c)[0].why, 'house');
});
