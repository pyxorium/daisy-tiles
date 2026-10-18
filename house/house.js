// house.js: the hidden house tile of one seat at a Daisy table. Each player's page runs one, for its own
// seat; the two houses talk through the page and the relay and must always agree (referee.js).
//
// The page sends everything here stamped with `from`: "player" (this seat's player tile), "peer" (the
// other house, through the relay) or "page". The house answers with `to`: "players" (both player tiles
// on this page: yours and the copy watching the other seat), "peer" or "page". After every change it
// sends the players a view and the page a snapshot of its state, which the page keeps in this browser
// so a reload can pick up where it left off (the snapshot holds this house's secret seeds: it never
// leaves this computer).
import { createTable, step, viewOf, resumeFrom } from './referee.js';
import { defaultRandomBytes } from './dice.js';
import { newTid } from './tid.js';
import { connect } from './talk.js';

// Match ids are TIDs: the time to the microsecond where the browser gives it.
const preciseNow = () => (typeof performance !== 'undefined' && performance.timeOrigin ? performance.timeOrigin + performance.now() : Date.now());
const ctx = { now: () => Date.now(), randomBytes: defaultRandomBytes, newId: () => newTid(preciseNow()) };
let state = null;
let lastSnapshot = '';

// On its own (a tile gallery, a viewer, or opened directly) no Daisy page sets the house up: after a
// moment it shows its card picture instead of an empty page (Oct 18, option A).
export const ALONE_MS = 1500;
let setUp = false;
function showCard() {
  if (setUp) return;
  const pic = document.getElementById('card-pic');
  pic.addEventListener('error', () => { pic.hidden = true; }, { once: true });   // the memory copies have no pictures
  pic.src = './banner.png';
  document.getElementById('card').hidden = false;
  document.documentElement.dataset.alone = '1';
}

const talk = await connect(onMessage);
if (talk.via === 'none') showCard(); else setTimeout(showCard, ALONE_MS);
talk.send('hello', { to: 'page', role: 'house' });

function onMessage(p) {
  if (p.from === 'house') return;                       // only the page's stamp counts
  if (p.kind === 'ping') { if (p.from === 'page') talk.send('pong', { to: 'page', n: p.n }); return; }
  if (p.from === 'page' && p.kind === 'setup') return setup(p);
  if (!state) { talk.send('ignored', { to: 'page', why: 'not set up yet', about: p.kind, by: p.from }); return; }
  const { game, v, to, ...message } = p;
  const r = step(state, message, ctx);
  if (r.ignored) talk.send('ignored', { to: 'page', why: r.ignored, about: p.kind, by: p.from });
  state = r.state;
  for (const o of r.out) talk.send(o.msg.kind, { ...o.msg, to: o.to === 'player' ? 'players' : o.to });
  afterChange();
}

// The page sets the house up once: which seat it plays for and which timers (the short set only on
// the owner's computer), or hands back a kept snapshot after a reload.
function setup(p) {
  setUp = true;
  document.getElementById('card').hidden = true;
  delete document.documentElement.dataset.alone;
  if (state) return;
  if (p.snapshot) {
    const r = resumeFrom(p.snapshot);
    if (r.state && r.state.me === p.seat) {
      state = r.state;
      talk.send('resumed', { to: 'page' });
      afterChange();
      return;
    }
    talk.send('ignored', { to: 'page', why: `kept state refused: ${r.problem || 'another seat'}`, about: 'setup', by: 'page' });
  }
  if (p.seat !== 1 && p.seat !== 2) return;
  state = createTable({ me: p.seat, timerSet: p.timers === 'short' ? 'short' : 'real' });
  afterChange();
}

function afterChange() {
  const snap = JSON.stringify(state);
  if (snap === lastSnapshot) return;                     // a quiet tick: nothing to tell anyone
  lastSnapshot = snap;
  talk.send('view', { to: 'players', view: viewOf(state) });
  talk.send('state', { to: 'page', snapshot: state });
}
