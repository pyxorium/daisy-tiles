// die3d.js: Daisy's 3D die, drawn with plain WebGL (no library). The rounded-cube shape, the lighting,
// the rim glow and the pointer handling (rotate only with exactly one pointer: the pinch fix) are
// adapted from the shared-die tiles (C:\thunderbird-cafe\wish-die-demo\tiles\src, Sep 30 2026).
//
// The dice decide, the animation follows: roll() starts a tumble while the two houses swap their
// links, land(value) eases it onto the face they agreed on. Between rolls the die's owner can turn it
// (one pointer) and zoom it (wheel or pinch); every change is offered to onView (orientation + zoom) so
// the other screen can show it. A watching copy takes those views with setView and never answers
// pointers. A 1 is a single daisy, and it wilts (dims and tips) when it lands.
//
// createDie3d(canvas, opts) returns null when the browser has no WebGL: the player tile then keeps
// its flat die.

const FACE_VALUES = [3, 4, 2, 5, 1, 6];            // faces +X, -X, +Y, -Y, +Z, -Z (opposite faces add to 7)
const FACES = [
  { N: [1, 0, 0], U: [0, 0, -1], V: [0, 1, 0] }, { N: [-1, 0, 0], U: [0, 0, 1], V: [0, 1, 0] },
  { N: [0, 1, 0], U: [1, 0, 0], V: [0, 0, -1] }, { N: [0, -1, 0], U: [1, 0, 0], V: [0, 0, 1] },
  { N: [0, 0, 1], U: [1, 0, 0], V: [0, 1, 0] }, { N: [0, 0, -1], U: [-1, 0, 0], V: [0, 1, 0] },
];
export const Z_HOME = 5.2, Z_MIN = 3.8, Z_MAX = 8.5;
export const LAND_MS = 650;                       // the landing after the links are in
export const VIEWS_PER_SECOND = 15;               // the shared view (owner, Oct 17: decide at build time)

// ---------- quaternions [x, y, z, w] ----------
export const quat = {
  id: () => [0, 0, 0, 1],
  axisAngle([x, y, z], a) { const l = Math.hypot(x, y, z) || 1, s = Math.sin(a / 2); return [x / l * s, y / l * s, z / l * s, Math.cos(a / 2)]; },
  mul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
  },
  norm(q) { const l = Math.hypot(...q) || 1; return q.map((x) => x / l); },
  slerp(a, b, t) {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let bb = b;
    if (d < 0) { d = -d; bb = b.map((x) => -x); }
    if (d > 0.9995) return quat.norm(a.map((x, i) => x + (bb[i] - x) * t));
    const th = Math.acos(d), s = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
    return a.map((x, i) => x * wa + bb[i] * wb);
  },
  rotate(q, v) {
    const [x, y, z, w] = q;
    const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2];
    const iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
  },
  // The shortest rotation taking unit vector a onto unit vector b.
  between(a, b) {
    const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    if (d < -0.999999) return quat.axisAngle(Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], Math.PI);
    const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    return quat.norm([c[0], c[1], c[2], 1 + d]);
  },
  toMat4(q, out) {
    const [x, y, z, w] = q;
    out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y + z * w); out[2] = 2 * (x * z - y * w); out[3] = 0;
    out[4] = 2 * (x * y - z * w); out[5] = 1 - 2 * (x * x + z * z); out[6] = 2 * (y * z + x * w); out[7] = 0;
    out[8] = 2 * (x * z + y * w); out[9] = 2 * (y * z - x * w); out[10] = 1 - 2 * (x * x + y * y); out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  },
};

// The resting orientation that shows `value` toward the viewer: that face turned to the camera, a
// quarter-turn twist (spin), then a slight tilt so the die reads as a solid.
const TILT = quat.mul(quat.axisAngle([1, 0, 0], 0.26), quat.axisAngle([0, 1, 0], -0.34));
export function restFor(value, spin = 0) {
  const f = FACES[FACE_VALUES.indexOf(value)];
  const align = quat.between(f.N, [0, 0, 1]);
  return quat.norm(quat.mul(TILT, quat.mul(quat.axisAngle([0, 0, 1], spin * Math.PI / 2), align)));
}
// Before any roll: a corner toward the viewer, so no face reads as a value.
export const IDLE = quat.norm(quat.mul(quat.axisAngle([0, 0, 1], 0.2), quat.between(quat.norm([1, 1, 1]), [0, 0, 1])));
// Which value faces the viewer for an orientation (the face whose normal points most toward +Z).
export function showing(q) {
  let best = 0, bz = -2;
  FACES.forEach((f, i) => { const z = quat.rotate(q, f.N)[2]; if (z > bz) { bz = z; best = i; } });
  return FACE_VALUES[best];
}
export function isView(v) {
  return v && Array.isArray(v.q) && v.q.length === 4 && v.q.every(Number.isFinite) && Math.abs(Math.hypot(...v.q) - 1) < 0.01
    && Number.isFinite(v.z) && v.z >= Z_MIN && v.z <= Z_MAX;
}

// ---------- the shape: flat faces (textured, one atlas cell each) and rounded edges ----------
// Adapted from buildFallbackParts in the shared-die tiles; each face now maps to its own cell of a
// 4 × 2 atlas.
function buildParts() {
  const INNER = 0.8, HALF = 1.2, K = 8, r = 1 - INNER;
  const S = [];
  for (let i = 0; i <= K; i++) S.push(-1 + r * i / K);
  for (let i = 0; i <= K; i++) S.push(INNER + r * i / K);
  const n = S.length;
  const fp = [], fn = [], ft = [], fi = [], bp = [], bn = [], bi = [];
  FACES.forEach((f, fIndex) => {
    const cx = fIndex % 4, cy = Math.floor(fIndex / 4);
    const fb = fp.length / 3;
    for (const [u, v] of [[-INNER, -INNER], [INNER, -INNER], [INNER, INNER], [-INNER, INNER]]) {
      for (let k = 0; k < 3; k++) { fp.push((f.N[k] + u * f.U[k] + v * f.V[k]) * HALF); fn.push(f.N[k]); }
      ft.push((cx + (u / INNER * 0.5 + 0.5)) / 4, (cy + (v / INNER * 0.5 + 0.5)) / 2);
    }
    fi.push(fb, fb + 1, fb + 2, fb, fb + 2, fb + 3);
    const bb = bp.length / 3;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const c = [0, 1, 2].map((k) => f.N[k] + S[i] * f.U[k] + S[j] * f.V[k]);
      const inner = c.map((x) => Math.max(-INNER, Math.min(INNER, x)));
      const d = c.map((x, k) => x - inner[k]);
      const len = Math.hypot(d[0], d[1], d[2]);
      for (let k = 0; k < 3; k++) { bp.push((inner[k] + d[k] / len * r) * HALF); bn.push(d[k] / len); }
    }
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) {
      if (i === K && j === K) continue;
      const a = bb + i * n + j, b = bb + (i + 1) * n + j, cc = bb + (i + 1) * n + (j + 1), d2 = bb + i * n + (j + 1);
      bi.push(a, b, cc, a, cc, d2);
    }
  });
  return [
    { positions: new Float32Array(fp), normals: new Float32Array(fn), texcoords: new Float32Array(ft), indices: new Uint16Array(fi), hasTexture: true },
    { positions: new Float32Array(bp), normals: new Float32Array(bn), texcoords: new Float32Array(bp.length / 3 * 2), indices: new Uint16Array(bi), hasTexture: false },
  ];
}

// ---------- the faces: an atlas in the glaze ----------
const PIPS = { 2: [[0, 0], [2, 2]], 3: [[0, 0], [1, 1], [2, 2]], 4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]], 6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]] };
const CELL = 256;
export function drawFace(g, value, glaze, x0 = 0, y0 = 0) {
  g.save();
  g.translate(x0, y0);
  g.fillStyle = glaze.face;
  g.fillRect(0, 0, CELL, CELL);
  const shade = g.createRadialGradient(CELL / 2, CELL / 2, CELL * 0.2, CELL / 2, CELL / 2, CELL * 0.75);
  shade.addColorStop(0, 'rgba(255,255,255,0.06)'); shade.addColorStop(1, 'rgba(0,0,0,0.10)');
  g.fillStyle = shade; g.fillRect(0, 0, CELL, CELL);
  g.fillStyle = glaze.pip;
  if (value === 1) drawDaisy(g, CELL / 2, CELL / 2, CELL * 0.3, glaze);
  else for (const [i, j] of PIPS[value]) { g.beginPath(); g.arc(CELL * (0.25 + i * 0.25), CELL * (0.25 + j * 0.25), CELL * 0.085, 0, Math.PI * 2); g.fill(); }
  g.restore();
}
// The 1: one daisy in the pip colour, its heart a ring around a dot of the face colour.
function drawDaisy(g, cx, cy, R, glaze) {
  g.save();
  g.translate(cx, cy);
  g.fillStyle = glaze.pip;
  for (let k = 0; k < 12; k++) {
    g.save(); g.rotate((k / 12) * Math.PI * 2);
    g.beginPath(); g.ellipse(0, -R * 0.62, R * 0.17, R * 0.42, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  g.beginPath(); g.arc(0, 0, R * 0.34, 0, Math.PI * 2); g.fill();
  g.fillStyle = glaze.face;
  g.beginPath(); g.arc(0, 0, R * 0.2, 0, Math.PI * 2); g.fill();
  g.restore();
}
function makeAtlas(glaze) {
  const c = document.createElement('canvas');
  c.width = CELL * 4; c.height = CELL * 2;
  const g = c.getContext('2d');
  FACES.forEach((_, i) => drawFace(g, FACE_VALUES[i], glaze, (i % 4) * CELL, (1 - Math.floor(i / 4)) * CELL));
  return c;
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

// ---------- the die ----------
// How brightly a glaze is lit, from its face colour alone (nothing set by hand per glaze): darker
// glazes get more light (Midnight 1.5; light glazes 1, never dimmed) and a stronger landing shimmer
// (capped at 0.85 so Brick stays brick; Bone and Glow get a gentle one).
export const SHIMMER_CAP = 0.85;
export function lightingFor(glaze) {
  const [r, g, b] = hex(glaze.face);
  const lightness = 0.299 * r + 0.587 * g + 0.114 * b;
  return {
    lightness,
    gain: Math.max(1, Math.min(1.5, 1 + 0.9 * (0.72 - lightness))),
    shimmerStrength: Math.max(0.45, Math.min(SHIMMER_CAP, 1.4 - lightness)),
  };
}

export function createDie3d(canvas, { glaze, watching = false, onView = () => {}, interactive = () => true, reduceMotion = () => false } = {}) {
  let gl = null;
  try { gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false }) || canvas.getContext('experimental-webgl'); } catch { gl = null; }
  if (!gl) return null;

  const vs = `
    attribute vec3 aPosition; attribute vec3 aNormal; attribute vec2 aTexCoord;
    uniform mat4 uModelView; uniform mat4 uProjection; uniform mat3 uNormalMatrix;
    varying vec3 vNormal; varying vec2 vTexCoord; varying vec3 vViewPos;
    void main() {
      vec4 viewPos = uModelView * vec4(aPosition, 1.0);
      gl_Position = uProjection * viewPos;
      vViewPos = viewPos.xyz; vNormal = normalize(uNormalMatrix * aNormal); vTexCoord = aTexCoord;
    }`;
  // Lighting (owner, Oct 18, after two comparison sheets): ambient + one lamp just above the viewer's
  // right shoulder, so the number face at rest is the brightest (the old light, from the shared-die
  // tiles, sat above right and left the face in shade). Each die is lit by its glaze's lightness
  // (uGain: darker glazes brighter, light ones never dimmed). The landing shimmer brightens the face
  // toward you in proportion, so dark pips stay dark (uFaceGlow), with only a hint at the rim; Glow
  // glows on its face. The wilt dims and greys the die.
  const fs = `
    precision mediump float;
    varying vec3 vNormal; varying vec2 vTexCoord; varying vec3 vViewPos;
    uniform sampler2D uTexture; uniform float uHasTexture; uniform vec3 uBaseColor;
    uniform vec3 uGlowColor; uniform float uRimStrength; uniform float uEmissive; uniform float uWilt; uniform float uFaceGlow; uniform float uGain;
    void main() {
      vec3 N = normalize(vNormal);
      vec3 L = normalize(vec3(0.1, 0.35, 0.93));
      vec3 V = normalize(-vViewPos);
      float diffuse = max(dot(N, L), 0.0);
      float spec = pow(max(dot(reflect(-L, N), V), 0.0), 24.0) * 0.14;
      vec3 base = mix(uBaseColor, texture2D(uTexture, vTexCoord).rgb, uHasTexture);
      vec3 lit = base * (0.38 + diffuse * 0.75) + vec3(spec) + base * uEmissive;
      float fres = pow(1.0 - max(dot(N, V), 0.0), 1.1);
      lit += uGlowColor * fres * uRimStrength;
      lit *= 1.0 + pow(max(dot(N, V), 0.0), 3.0) * uFaceGlow * 0.4;
      lit *= uGain;
      float grey = dot(lit, vec3(0.299, 0.587, 0.114));
      lit = mix(lit, vec3(grey) * 0.7, uWilt * 0.65);
      gl_FragColor = vec4(lit, 1.0);
    }`;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; };
  const program = gl.createProgram();
  gl.attachShader(program, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(program)); return null; }
  gl.useProgram(program);
  const U = (n) => gl.getUniformLocation(program, n);
  const loc = {
    position: gl.getAttribLocation(program, 'aPosition'), normal: gl.getAttribLocation(program, 'aNormal'), tex: gl.getAttribLocation(program, 'aTexCoord'),
    mv: U('uModelView'), proj: U('uProjection'), nm: U('uNormalMatrix'), texture: U('uTexture'), hasTexture: U('uHasTexture'),
    base: U('uBaseColor'), glowColor: U('uGlowColor'), rim: U('uRimStrength'), emissive: U('uEmissive'), wilt: U('uWilt'), faceGlow: U('uFaceGlow'), gain: U('uGain'),
  };
  const buf = (data, kind = gl.ARRAY_BUFFER) => { const b = gl.createBuffer(); gl.bindBuffer(kind, b); gl.bufferData(kind, data, gl.STATIC_DRAW); return b; };
  const parts = buildParts().map((p) => ({
    pos: buf(p.positions), norm: buf(p.normals), uv: buf(p.texcoords), idx: buf(p.indices, gl.ELEMENT_ARRAY_BUFFER), count: p.indices.length, hasTexture: p.hasTexture,
  }));
  const texture = gl.createTexture();
  let bevel = [0.9, 0.88, 0.8], emissive = 0, glazeId = null, gain = 1, shimmerStrength = 0.85;
  function setGlaze(gz) {
    if (!gz || gz.id === glazeId) return;
    glazeId = gz.id;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, makeAtlas(gz));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    bevel = hex(gz.face).map((x) => x * 0.9);
    emissive = gz.id === 'glow' ? 0.12 : 0;                   // Glow really glows (on its face)
    ({ gain, shimmerStrength } = lightingFor(gz));
    wake();
  }

  // ---------- state ----------
  let q = IDLE, zoom = Z_HOME;
  let viewTarget = null;          // watching: the owner's latest view
  let anim = null;                // { kind: 'spin' | 'land' | 'fade', … }
  let wilt = 0, wiltTarget = 0, shimmer = null, hop = null;
  let value = null;               // the value it shows (or is landing on)
  const now = () => performance.now();

  function roll() {
    wiltTarget = 0;
    if (reduceMotion()) { anim = { kind: 'fade', start: now() }; canvas.style.opacity = '0.25'; wake(); return; }
    anim = { kind: 'spin', start: now(), axis: [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5], w: 13 };
    wake();
  }
  function land(v, done = () => {}) {
    value = v;
    const target = restFor(v, Math.floor(Math.random() * 4));
    if (reduceMotion() || (anim && anim.kind === 'fade')) {
      q = target; zoom = Z_HOME; anim = null; canvas.style.opacity = '1'; wiltTarget = v === 1 ? 1 : 0; wake(); done(); return;
    }
    anim = { kind: 'land', start: now(), q0: q, qT: target, axis: anim && anim.axis ? anim.axis : [0, 1, 0], turns: 1, z0: zoom, done };
    wake();
  }
  // Show a value at rest at once (after a reload, or on the watching copy's first view).
  function show(v, { wilted = v === 1 } = {}) {
    value = v;
    if (anim) return;
    q = restFor(v, 0);
    wilt = wiltTarget = wilted ? 1 : 0;
    wake();
  }
  // Back to no value (a rematch). A landing under way is finished first, so whoever waits for it hears.
  function clear() {
    const done = anim && anim.done;
    value = null; wilt = wiltTarget = 0; anim = null; q = IDLE; canvas.style.opacity = '1'; wake();
    if (done) done();
  }
  function setView(v) { if (!isView(v) || anim) return; viewTarget = { q: quat.norm(v.q), z: v.z }; wake(); }

  // ---------- pointers: rotate with one pointer, zoom with the wheel or a pinch ----------
  const pointers = new Map();
  let lastX = 0, lastY = 0, pinch = null, lastSent = 0, pendingSend = null;
  const canTurn = () => !watching && !anim && interactive();
  function sendView(force = false) {
    const t = now();
    const v = { q: q.map((x) => Math.round(x * 1e4) / 1e4), z: Math.round(zoom * 100) / 100 };
    clearTimeout(pendingSend);
    if (force || t - lastSent >= 1000 / VIEWS_PER_SECOND) { lastSent = t; onView(v); }
    else pendingSend = setTimeout(() => sendView(true), 1000 / VIEWS_PER_SECOND - (t - lastSent));
  }
  if (!watching) {
    canvas.addEventListener('pointerdown', (e) => {
      if (!canTurn()) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      if (pointers.size === 1) { lastX = e.clientX; lastY = e.clientY; }
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId) || !canTurn()) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {                              // pinch: zoom only, never rotate
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) { zoom = Math.max(Z_MIN, Math.min(Z_MAX, zoom - (d - pinch) * 0.02)); sendView(); wake(); }
        pinch = d;
        return;
      }
      if (pointers.size !== 1) return;                       // rotate only with exactly one pointer
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      q = quat.norm(quat.mul(quat.mul(quat.axisAngle([0, 1, 0], dx * 0.012), quat.axisAngle([1, 0, 0], dy * 0.012)), q));
      sendView(); wake();
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 1) { const r = [...pointers.values()][0]; lastX = r.x; lastY = r.y; }   // 2 → 1: resync
      if (pointers.size === 0) sendView(true);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      if (!canTurn()) return;
      e.preventDefault();
      zoom = Math.max(Z_MIN, Math.min(Z_MAX, zoom + e.deltaY * 0.004));
      sendView(); wake();
    }, { passive: false });
  }

  // ---------- drawing (only while something moves; the browser pauses hidden tabs itself) ----------
  const mv = new Float32Array(16), proj = new Float32Array(16), rot = new Float32Array(16), nm = new Float32Array(9);
  let raf = 0;
  function wake() { if (!raf) raf = requestAnimationFrame(frame); }
  function step(t) {
    let moving = false;
    if (anim && anim.kind === 'spin') {
      const dt = 1 / 60;
      q = quat.norm(quat.mul(quat.axisAngle(anim.axis, anim.w * dt), q));
      zoom += (Z_HOME - zoom) * 0.15;                          // Roll eases the die home
      moving = true;
    } else if (anim && anim.kind === 'land') {
      const k = Math.min(1, (t - anim.start) / LAND_MS), e = 1 - Math.pow(1 - k, 3);
      const extra = quat.axisAngle(anim.axis, (1 - e) * anim.turns * Math.PI * 2);
      q = quat.norm(quat.mul(extra, quat.slerp(anim.q0, anim.qT, e)));
      zoom = anim.z0 + (Z_HOME - anim.z0) * e;
      moving = true;
      if (k >= 1) {
        q = anim.qT; const done = anim.done; anim = null;
        hop = { start: t };
        if (value === 1) wiltTarget = 1; else shimmer = { start: t };
        done();
      }
    } else if (anim && anim.kind === 'fade') moving = true;
    if (viewTarget && !anim) {
      q = quat.slerp(q, viewTarget.q, 0.35);
      zoom += (viewTarget.z - zoom) * 0.35;
      const close = Math.abs(zoom - viewTarget.z) < 0.01 && Math.abs(q[0] * viewTarget.q[0] + q[1] * viewTarget.q[1] + q[2] * viewTarget.q[2] + q[3] * viewTarget.q[3]) > 0.99999;
      if (close) { q = viewTarget.q; zoom = viewTarget.z; viewTarget = null; } else moving = true;
    }
    if (Math.abs(wilt - wiltTarget) > 0.001) { wilt += (wiltTarget - wilt) * 0.08; moving = true; } else wilt = wiltTarget;
    if (shimmer && t - shimmer.start < 900) moving = true; else shimmer = null;
    if (hop && t - hop.start < 260) moving = true; else hop = null;
    return moving;
  }
  function frame(t) {
    raf = 0;
    const moving = step(t);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const f = 1 / Math.tan(Math.PI / 8), near = 0.1, far = 100;
    proj.set([f / (w / h), 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
    // The wilt tips the die forward a little; the hop lifts it as it lands.
    const shown = wilt > 0.001 ? quat.mul(quat.axisAngle([0, 0, 1], -0.3 * wilt), q) : q;   // the wilt: it leans over
    quat.toMat4(shown, rot);
    const lift = hop ? Math.sin(Math.min(1, (t - hop.start) / 260) * Math.PI) * 0.18 : 0;
    mv.set(rot); mv[12] = 0.1 * wilt; mv[13] = lift - 0.14 * wilt; mv[14] = -zoom;
    nm.set([rot[0], rot[1], rot[2], rot[4], rot[5], rot[6], rot[8], rot[9], rot[10]]);
    gl.uniformMatrix4fv(loc.proj, false, proj);
    gl.uniformMatrix4fv(loc.mv, false, mv);
    gl.uniformMatrix3fv(loc.nm, false, nm);
    const pulse = shimmer ? Math.sin(Math.min(1, (t - shimmer.start) / 900) * Math.PI) : 0;
    const glows = emissive > 0;
    gl.uniform3fv(loc.glowColor, [1.0, 0.92, 0.7]);
    gl.uniform1f(loc.rim, pulse * 0.12 + (glows ? 0.08 : 0));
    gl.uniform1f(loc.faceGlow, pulse * 0.9 * shimmerStrength + (glows ? 0.35 : 0));
    gl.uniform1f(loc.gain, gain);
    gl.uniform1f(loc.emissive, emissive);
    gl.uniform1f(loc.wilt, wilt);
    for (const p of parts) {
      for (const [l, b, size] of [[loc.position, p.pos, 3], [loc.normal, p.norm, 3], [loc.tex, p.uv, 2]]) {
        gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0);
      }
      gl.uniform1f(loc.hasTexture, p.hasTexture ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(loc.texture, 0);
      gl.uniform3fv(loc.base, bevel);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, p.idx);
      gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_SHORT, 0);
    }
    canvas.dataset.showing = String(showing(q));
    canvas.dataset.q = q.map((x) => x.toFixed(3)).join(',');
    canvas.dataset.moving = moving ? '1' : '';
    canvas.dataset.wilt = wilt > 0.5 ? '1' : '';
    if (anim && anim.kind === 'fade' && t - anim.start > 200) canvas.style.opacity = '1';
    if (moving) wake();
  }

  setGlaze(glaze);
  // Draw again whenever the canvas changes size (it starts hidden behind the coin, at no size at all).
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => wake()).observe(canvas);
  wake();
  return {
    roll, land, show, clear, setGlaze, setView, sendView: () => sendView(true), redraw: wake,
    get rolling() { return !!anim; },
    get view() { return { q: [...q], z: zoom }; },
  };
}
