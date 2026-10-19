// player.js: one seat at a Daisy table. The same tile is used twice on each page: once for you (live,
// with Roll and Bank) and once as a copy watching the other player's seat (no buttons). The page tells
// each copy which seat it shows. It never decides anything: it asks this page's house to roll or bank,
// and draws what the house says. The die is 3D (die3d.js, WebGL) where the browser allows it, else flat.
import { connect } from './talk.js';
import { GLAZES, glazeById } from './dice.js';
import { createDie3d, lightingFor, LAND_MS } from './die3d.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
let seat = null;          // the seat this copy shows (1 or 2)
let watching = false;     // the copy watching the other player: no buttons
let view = null;          // the house's latest view (from this page's house, whose own seat is view.me)
let houseGone = false;    // the page says the house stopped: wait
let pickNote = '';
let nudgeUntil = 0, nudgeTimer = null;
let coinUntil = 0;        // Roll waits while the coin spins (the house has already decided)
let tumble = null;        // { n, until, timer, value }
let shown = null;         // { value, n } this seat's die as last drawn
let die3d = null;         // the 3D die (null: flat)
let turningTimer = null;
let saveState = null;     // how saving this match is going (the page's word: saving is the page's job)
let otherGone = false;    // the page says the other player's page has left the table (step 7)
// Holding the result until the die lands (step 7, owner Oct 18): once a roll is decided, the house's new
// view waits here until the die has landed on screen, so the turn line, the scores, the banner and, on a
// 1, the hand-off to the other seat change together with the die. Both copies time it the same way.
let held = null;          // a view waiting for the die to land
let holdUntil = 0, holdTimer = null;
const rollingAt = new Map();   // roll number → when its tumble started
let landedN = 0;          // the last roll this copy's die landed on
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export const COIN_MS = 1500, TUMBLE_MS = 650;
const REASONS = {
  'turn-timeout': (who) => `${who} let the turn timer run out.`,
  away: (who) => `${who} was away too long.`,
  'no-reveal': (who) => `${who}'s page didn't answer a roll.`,
};

// On its own (a tile gallery, a viewer, or opened directly) no Daisy page tells this tile its seat: after
// a moment it shows its card picture instead of an empty table (Oct 18, option A).
export const ALONE_MS = 1500;
function showCard() {
  if (seat) return;
  const pic = $('card-pic');
  pic.addEventListener('error', () => { pic.hidden = true; }, { once: true });   // the memory copies have no pictures
  pic.src = './banner.png';
  $('card').hidden = false;
  document.documentElement.dataset.alone = '1';
}

const talk = await connect(onMessage);
talk.send('hello', { role: 'player' });
setTimeout(showCard, ALONE_MS);

const at = (h) => (h ? '@' + h : 'someone');
const other = (n) => (n === 1 ? 2 : 1);
const seatInfo = (n) => (view && view.seats[n - 1]) || {};
const isMine = () => !watching && view && view.me === seat;
const nameOf = (n) => (view && n === view.me ? 'You' : at(seatInfo(n).handle));

function onMessage(p) {
  switch (p.kind) {
    case 'seat':
      if (p.seat !== 1 && p.seat !== 2) return;
      seat = p.seat; watching = p.watching === true;
      $('card').hidden = true; delete document.documentElement.dataset.alone;
      app.dataset.watching = watching ? '1' : '';
      $('badge').hidden = !watching;
      makeDie();
      $('handle').textContent = at(p.handle);
      render();
      break;
    case 'ping': talk.send('pong', { n: p.n }); break;
    case 'presence':
      if (p.who === 'house') { houseGone = p.state === 'gone'; render(); }
      if (p.who === 'other') { otherGone = p.state === 'gone'; render(); }
      break;
    case 'view':
      if (Date.now() < holdUntil) held = p.view;
      else { held = null; view = p.view; }
      render();
      break;
    // Events from the house (both copies hear them; each keeps to its own seat).
    case 'taken': if (p.seat === seat) { pickNote = `${glazeName(p.glaze)} was taken by the other player at the same moment. Pick another.`; render(); } break;
    case 'flip': coinUntil = Date.now() + (reduceMotion() ? 0 : COIN_MS); spinCoin(p.first); break;
    case 'rolling':
      rollingAt.set(p.n, Date.now());
      if (p.seat === seat) startTumble(p.n);
      clearNudge();                                       // any move restarts the turn timer
      break;
    case 'rolled': hold(p.n); if (p.seat === seat) settle(p.value, p.n); break;
    case 'banked': if (p.seat === seat && p.big) burst(); clearNudge(); break;
    case 'nudge': nudge(p); break;
    case 'turn': case 'win': case 'forfeit': case 'match-over': clearNudge(); break;
    case 'rematch':
      // A new match: anything still tumbling or landing is over.
      pickNote = ''; shown = null; shown3d = null; saveState = null;
      if (tumble) { clearInterval(tumble.timer); tumble = null; }
      release(); landedN = 0; rollingAt.clear();
      if (die3d) die3d.clear();
      render();
      break;
    case 'save-status': if (!watching) { saveState = p; renderSave(); } break;
    // The other player turning their die (the shared view): only the watching copy follows it.
    case 'die-view':
      if (watching && die3d && !tumble) {
        die3d.setView(p);
        $('turning').hidden = false;
        $('turning').textContent = `${at(seatInfo(seat).handle)} is turning their die`;
        clearTimeout(turningTimer);
        turningTimer = setTimeout(() => { $('turning').hidden = true; }, 1500);
      }
      break;
  }
}

$('roll').addEventListener('click', () => { if (isMine() && view.canRoll && !busy()) talk.send('roll', {}); });
$('bank').addEventListener('click', () => { if (isMine() && view.canBank && !busy()) talk.send('bank', {}); });
$('rematch').addEventListener('click', () => { if (isMine() && view.canRematch) talk.send('rematch', {}); });
$('save').addEventListener('click', () => { if (isMine() && view.phase === 'over') talk.send('save-request', {}); });
const busy = () => Date.now() < coinUntil || !!tumble;
const glazeName = (id) => (glazeById(id) || { name: id }).name;

// ---------- drawing ----------

function render() {
  if (!seat) return;
  if (!view) { $('banner').textContent = 'Waiting for the table…'; return; }
  const me = seatInfo(seat), them = seatInfo(other(seat));
  const g = glazeById(me.glaze);
  $('handle').textContent = seat === view.me ? `You (${at(me.handle)})` : at(me.handle);
  if (me.bot) $('handle').append(robot());
  $('sub').textContent = `Seat ${seat}${g ? ' · ' + g.name : ''}${view.first === seat && view.phase !== 'flipping' ? ' · went first' : ''}`;
  if (die3d && g) die3d.setGlaze(g);
  $('dot').style.background = g ? g.face : '';
  $('dot').style.borderColor = g ? g.pip : '';
  document.documentElement.style.setProperty('--face', g ? g.face : '#efe6d2');
  document.documentElement.style.setProperty('--pip', g ? g.pip : '#2b2622');

  const picking = view.phase === 'picking' || view.phase === 'seating';
  $('picker').hidden = !picking;
  $('stage').hidden = picking || view.phase === 'over';
  $('end').hidden = view.phase !== 'over' || watching;
  if (picking) drawPicker(me, them);
  if (view.phase === 'over') {
    $('stage').hidden = !watching;
    if (!watching) drawEnd();
  }

  const playing = view.phase === 'playing' && !houseGone;
  const myTurn = playing && view.turn === seat;
  app.dataset.mode = myTurn ? 'turn' : 'wait';
  const live = isMine() && myTurn;
  $('roll').hidden = !live; $('bank').hidden = !live;
  $('roll').disabled = !view.canRoll || busy();
  $('bank').disabled = !view.canBank || busy();
  $('banner').textContent = banner(myTurn);
  $('turn-line').textContent = myTurn && view.turnRolls.length
    ? `${view.turnRolls.join(' + ')} = ${view.turnTotal} this turn`
    : (myTurn && isMine() ? 'Roll to start the turn' : ' ');
  if (view.phase === 'over') $('turn-line').textContent = ' ';
  drawScores();

  // The die: this seat's last roll (also after a reload, from the view).
  if (view.rolling && view.rolling.seat === seat && !tumble && view.rolling.n > landedN) startTumble(view.rolling.n);
  if (!tumble && !coinSpinning) {
    const last = view.lastRoll && view.lastRoll.seat === seat ? view.lastRoll : null;
    if (last && (!shown || shown.n !== last.n)) shown = { value: last.value, n: last.n };
    if (view.phase === 'picking' || view.phase === 'seating') shown = null;
    if (die3d) show3d(shown, { wilt: !!shown && shown.value === 1 && !myTurnStarted(myTurn) });
    else drawDie(shown ? shown.value : 0, { wilt: shown && shown.value === 1 && !myTurnStarted(myTurn) });
    $('value').textContent = shown ? (shown.value === 1 ? '1 · the turn is lost' : `Rolled a ${shown.value}`) : ' ';
  }
}
// A small outline robot after the bot's handle (the drawing Seven-Up's bot button uses), and words for
// screen readers.
const SVG = 'http://www.w3.org/2000/svg';
function robot() {
  const span = document.createElement('span');
  span.className = 'robot';
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
  const parts = [['line', { x1: 12, y1: 2.5, x2: 12, y2: 5.5 }], ['circle', { cx: 12, cy: 2.3, r: 0.6, fill: 'currentColor' }],
    ['rect', { x: 4.5, y: 6, width: 15, height: 12, rx: 3.5 }], ['circle', { cx: 9.3, cy: 12, r: 1.3, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 14.7, cy: 12, r: 1.3, fill: 'currentColor', stroke: 'none' }], ['line', { x1: 2.5, y1: 11, x2: 2.5, y2: 13.5 }],
    ['line', { x1: 21.5, y1: 11, x2: 21.5, y2: 13.5 }]];
  for (const [tag, attrs] of parts) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  const sr = document.createElement('span');
  sr.className = 'sr'; sr.textContent = ' (the bot)';
  span.append(svg, sr);
  return span;
}

// A wilted 1 stays wilted until this seat's next turn starts.
function myTurnStarted(myTurn) { return myTurn && view.turnRolls.length > 0; }

function banner(myTurn) {
  const v = view;
  if (houseGone) return 'Waiting for the table…';
  const mine = seat === v.me;
  switch (v.phase) {
    case 'seating': return 'Waiting for the other player';
    case 'picking': return '';
    case 'flipping': return 'Flipping the coin…';
    case 'playing':
      if (Date.now() < coinUntil) return 'Flipping the coin…';
      if (myTurn) return mine && !watching ? 'Your turn' : `${at(seatInfo(seat).handle)}'s turn`;
      return mine && !watching ? `${at(seatInfo(other(seat)).handle)}'s turn` : 'Waiting';
    case 'over': return v.winner === seat ? `${nameOf(seat)} won` : 'Match over';
    case 'abandoned': return 'The table closed before the game started.';
    default: return '';
  }
}

function drawPicker(me, them) {
  const choosing = isMine() && view.canPick;
  const title = watching ? (me.glaze ? `${at(me.handle)} chose ${glazeName(me.glaze)}` : `${at(me.handle)} is choosing a glaze`)
    : me.glaze ? `You chose ${glazeName(me.glaze)}` : view.phase === 'seating' ? 'Waiting for the other player' : 'Choose your glaze';
  $('pick-title').textContent = title;
  const box = $('glazes');
  if (box.childElementCount !== GLAZES.length) {
    box.textContent = '';
    for (const gl of GLAZES) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'glaze'; b.dataset.id = gl.id;
      const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = gl.face;
      const pip = document.createElement('i'); pip.style.background = gl.pip; sw.append(pip);
      const name = document.createElement('span'); name.textContent = gl.name;
      const tag = document.createElement('span'); tag.className = 'tag';
      b.append(sw, name, tag);
      b.addEventListener('click', () => {
        if (!isMine() || !view.canPick) return;
        pickNote = '';
        talk.send('pick', { glaze: gl.id });
      });
      box.append(b);
    }
  }
  for (const b of box.children) {
    const id = b.dataset.id;
    const g = view.glazes.find((x) => x.id === id);
    const theirs = them.glaze === id, mine = me.glaze === id;
    b.disabled = !choosing || !g.free;
    b.classList.toggle('mine', mine);
    b.querySelector('.tag').textContent = mine ? (watching ? 'theirs' : 'yours') : theirs ? (watching ? 'yours' : 'taken') : '';
    b.setAttribute('aria-pressed', mine ? 'true' : 'false');
  }
  $('pick-note').textContent = watching ? '' : pickNote || (me.glaze && !them.glaze ? `Waiting for ${at(them.handle)} to choose.` : '');
}

function drawScores() {
  const target = view.target || 25;
  $('target').textContent = target;
  for (const row of document.querySelectorAll('.score')) {
    const n = Number(row.dataset.seat), s = seatInfo(n), g = glazeById(s.glaze);
    row.querySelector('.name').textContent = n === view.me ? 'You' : at(s.handle);
    row.classList.toggle('self', n === seat);
    row.classList.toggle('turn', view.phase === 'playing' && view.turn === n);
    const pending = view.phase === 'playing' && view.turn === n ? view.turnTotal : 0;
    const fill = row.querySelector('.fill');
    fill.style.width = `${Math.min(100, (100 * (s.score || 0)) / target)}%`;
    fill.style.setProperty('--sw', g ? g.face : '');
    // A′ (owner, Oct 18): a pale glaze (Bone, Glow, Marigold) gets an edge in its pip colour, so its bar
    // shows on the cream track. The same lightness measure as the die's lighting.
    fill.style.setProperty('--edge', g && lightingFor(g).lightness > 0.7 ? g.pip : 'transparent');
    row.querySelector('.num').textContent = pending ? `${s.score || 0}+${pending}` : String(s.score || 0);
  }
}

function drawEnd() {
  const v = view, won = v.winner === v.me, loser = other(v.winner);
  $('end-title').textContent = won ? 'You win 🌼' : `${at(seatInfo(v.winner).handle)} wins`;
  const them = at(seatInfo(other(v.me)).handle);
  // The other player's page has left (owner, Oct 18): said after the reason, and no Rematch (nobody to agree).
  $('end-note').textContent = v.ending === 'forfeit'
    ? (REASONS[v.forfeitReason] || (() => 'Ended by forfeit.'))(loser === v.me ? 'You' : at(seatInfo(loser).handle)).replace(/^You's/, 'Your')
      + (otherGone ? (loser === v.me ? ` ${them} is no longer at the table.` : ' They are no longer at the table.') : '')
    : `First to ${v.target}: ${v.seats.map((s) => s.score).join(' to ')}.` + (otherGone ? ` ${them} is no longer at the table.` : '');
  $('rematch').hidden = !v.canRematch || otherGone;
  $('rematch-note').textContent = otherGone ? '' : v.rematch.includes(v.me) ? `Waiting for ${them} to agree…`
    : v.otherAsked ? `${them} asks for a rematch.` : '';
  renderSave();
}

// Saving is the page's job (its own prompt, outside the tile, Oct 18 option A): the tile only asks and
// shows how it went. Only your own tile has the button; the watching copy shows nothing.
function renderSave() {
  const s = saveState, el = $('save-status'), btn = $('save');
  const mine = isMine() && view.phase === 'over';
  btn.hidden = !mine;
  if (!mine) { el.textContent = ''; return; }
  btn.disabled = !!s && ['asking', 'saving', 'saved'].includes(s.state);
  btn.textContent = s && s.state === 'saved' ? 'Saved' : 'Save this match';
  el.textContent = !s || s.state === 'declined' ? 'Save it to your account, if you like.' :
    s.state === 'asking' ? 'Answer on the page, above the table.' :
    s.state === 'signin' ? 'Sign in again on the page to save.' :
    s.state === 'saving' ? 'Saving…' :
    s.state === 'saved' ? `Saved to ${at(s.handle)}.` :
    s.state === 'failed' ? "Couldn't save. Try again." : '';
}

// ---------- the die (flat in step 2) ----------
const PIPS = { 1: [[1, 1]], 2: [[0, 0], [2, 2]], 3: [[0, 0], [1, 1], [2, 2]], 4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]], 6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]] };
let coinSpinning = false;

function canvas() {
  const c = $('die'), dpr = window.devicePixelRatio || 1, S = 132;
  if (c.width !== S * dpr) { c.width = S * dpr; c.height = S * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, S, S);
  return g;
}
function drawDie(value, { rot = 0, wilt = false, dx = 0, dy = 0 } = {}) {
  const g = canvas(), gl = glazeById(seatInfo(seat).glaze) || { face: '#efe6d2', pip: '#2b2622' };
  const size = 92;
  g.save();
  g.translate(66 + dx, 66 + dy + (wilt ? 6 : 0));
  g.rotate(rot + (wilt ? -0.12 : 0));
  if (wilt) g.globalAlpha = 0.5;
  g.fillStyle = 'rgba(0,0,0,.12)';
  roundRect(g, -size / 2 + 3, -size / 2 + 5, size, size, 18); g.fill();
  g.fillStyle = gl.face;
  roundRect(g, -size / 2, -size / 2, size, size, 18); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 1.5; g.stroke();
  if (value >= 1 && value <= 6) {
    g.fillStyle = gl.pip;
    for (const [i, j] of PIPS[value]) {
      g.beginPath(); g.arc((i - 1) * 24, (j - 1) * 24, 7.5, 0, Math.PI * 2); g.fill();
    }
  } else {
    g.fillStyle = gl.pip; g.globalAlpha *= 0.25;
    g.font = '600 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('🌼', 0, 2);
  }
  g.restore();
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// Roll: the die tumbles while the two houses swap their links, then lands on the value they agree on.
function startTumble(n) {
  if (tumble && tumble.n === n) return;
  clearInterval(tumble && tumble.timer);
  tumble = { n, until: Date.now() + (reduceMotion() ? 0 : TUMBLE_MS), value: null, timer: null };
  $('value').textContent = 'Rolling…';
  if (die3d) { die3d.roll(); render(); return; }
  if (!reduceMotion()) {
    tumble.timer = setInterval(() => {
      const t = tumble;
      if (!t) return;
      if (t.value !== null && Date.now() >= t.until) return land();
      drawDie(1 + Math.floor(Math.random() * 6), { rot: (Math.random() - 0.5) * 0.9, dx: (Math.random() - 0.5) * 10, dy: (Math.random() - 0.5) * 10 });
    }, 70);
  }
  render();
}
function settle(value, n) {
  if (!tumble || tumble.n !== n) { tumble = null; shown = { value, n }; render(); return; }
  tumble.value = value;
  if (die3d) {
    // The tumble runs at least TUMBLE_MS, then lands on the value the houses agreed on.
    const t = tumble;
    setTimeout(() => die3d.land(value, () => {
      if (tumble !== t) return;
      tumble = null; shown = { value, n }; shown3d = { value, n };
      landedN = Math.max(landedN, n);
      release();
    }), Math.max(0, t.until - Date.now()));
    return;
  }
  if (reduceMotion() || Date.now() >= tumble.until) land();
}
function land() {
  const t = tumble;
  clearInterval(t.timer);
  tumble = null;
  shown = { value: t.value, n: t.n };
  landedN = Math.max(landedN, t.n);
  release();
}

// A roll is decided: hold the table as it was until its die lands (the same time on both copies: the
// tumble runs at least TUMBLE_MS, then the 3D die takes LAND_MS to land; nothing to wait for with
// reduced motion).
function hold(n) {
  if (reduceMotion()) return;
  const now = Date.now();
  const lands = Math.max((rollingAt.get(n) || now) + TUMBLE_MS, now) + (die3d ? LAND_MS : 0);
  if (lands <= now) return;
  holdUntil = Math.max(holdUntil, lands);
  clearTimeout(holdTimer);
  holdTimer = setTimeout(release, holdUntil - now + 20);
}
function release() {
  clearTimeout(holdTimer);
  holdUntil = 0;
  if (held) { view = held; held = null; }
  render();
}

// The coin: who goes first. It spins on both copies, then Roll is free.
function spinCoin(first) {
  if (reduceMotion()) { render(); return; }
  coinSpinning = true;
  useFlat(true);
  const start = Date.now();
  const timer = setInterval(() => {
    const t = (Date.now() - start) / COIN_MS;
    const g = canvas();
    if (t >= 1) {
      clearInterval(timer); coinSpinning = false;
      useFlat(!die3d);
      render(); return;
    }
    const w = Math.abs(Math.cos(t * Math.PI * 6)) * 46 + 2;
    g.fillStyle = '#f2b233'; g.strokeStyle = '#3b2a10'; g.lineWidth = 2;
    g.beginPath(); g.ellipse(66, 66, w, 46, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    if (t > 0.7) { g.fillStyle = '#3b2a10'; g.font = '700 30px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(first), 66, 67); }
    $('value').textContent = t > 0.7 ? `${nameOf(first)} ${first === (view && view.me) ? 'go' : 'goes'} first` : ' ';
  }, 40);
  render();
}

// 🌼 for a big bank, on both screens.
function burst() {
  const box = $('burst');
  box.textContent = '';
  const n = reduceMotion() ? 1 : 9;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span');
    const a = (i / n) * Math.PI * 2;
    s.textContent = '🌼';
    s.style.setProperty('--dx', `${Math.cos(a) * 80}px`);
    s.style.setProperty('--dy', `${Math.sin(a) * 80}px`);
    s.style.setProperty('--rot', `${(i % 2 ? 1 : -1) * 90}deg`);
    box.append(s);
  }
  setTimeout(() => { box.textContent = ''; }, 1300);
}

// The turn timer's nudge, on the copy of the seat whose turn it is.
function nudge(p) {
  if (p.seat !== seat) return;
  nudgeUntil = Date.now() + p.msLeft;
  clearInterval(nudgeTimer);
  const show = () => {
    const left = Math.max(0, Math.ceil((nudgeUntil - Date.now()) / 1000));
    const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    $('nudge').hidden = false;
    $('nudge').textContent = isMine() ? `Still there? Roll or bank within ${mm}, or the match is forfeited.` : `${at(seatInfo(seat).handle)} has ${mm} left to play.`;
    if (!left) clearInterval(nudgeTimer);
  };
  show();
  nudgeTimer = setInterval(show, 1000);
}
function clearNudge() { clearInterval(nudgeTimer); $('nudge').hidden = true; }

// ---------- the 3D die ----------
let shown3d = null;       // { value, n } as the 3D die shows it (to know when it needs setting)
function makeDie() {
  if (die3d !== null || app.dataset.die) return;
  die3d = createDie3d($('die3d'), {
    glaze: glazeById(seatInfo(seat).glaze) || GLAZES[0],
    watching,
    reduceMotion,
    // Only the die's owner turns it, only between rolls, and not while choosing glazes or the coin spins.
    interactive: () => !!view && !busy() && ['playing', 'over'].includes(view.phase),
    onView: (v) => talk.send('die-view', v),
  });
  document.documentElement.dataset.die = die3d ? 'webgl' : 'flat';
  app.dataset.die = die3d ? 'webgl' : 'flat';
  useFlat(!die3d);
}
function useFlat(flat) {
  $('die').hidden = !flat;
  $('die3d').hidden = flat;
  if (!flat && die3d) die3d.redraw();
}
function show3d(s, { wilt }) {
  if (!s) { if (shown3d) { shown3d = null; die3d.clear(); } }
  else if (!shown3d || shown3d.n !== s.n) { shown3d = { ...s }; die3d.show(s.value, { wilted: wilt }); }
  $('value').textContent = s ? (s.value === 1 ? '1 · the turn is lost' : `Rolled a ${s.value}`) : ' ';
  document.documentElement.dataset.shown = s ? String(s.value) : '';
}

