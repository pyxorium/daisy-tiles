// coin3d.js: Daisy's coin toss (Raku step 5c, Oct 21 2026), drawn with plain WebGL like the die (no
// library), on its own canvas over the die's box (Q76). The look and the motion come from the owner's
// lil-gui tuning panel, moved here unchanged (claude/raku-stage5c-plan.md); the numbers live in coin.js.
//
// The house decides who goes first and hands over a seed and the timings; this file only animates:
// tossMotion(...) is plain arithmetic from the seed and the clock, so every screen that tosses the same
// seed shows the same toss, and a tile that starts late joins it where it is (Q77). A coin: a metal rim
// and ridged edge, each face enamelled in one player's glaze with a raised metal daisy (seat 1's face is
// the coin's +Z side). It lands facing the viewer, the winner's face up.
//
//   tossMotion({ first, seed, timings, look }) -> { plan, sample(t) }       (t: ms since the flip)
//   createCoinView(canvas, look) -> { draw(state, glazes), lose() } | null  (null without WebGL)
//   drawFlatCoin(ctx2d, state, glazes, look, box)                          (the no-WebGL coin)
//   drawKeepsake(canvas, glaze, look, px)                                  (the tiny coin by the score)
import { COIN_LOOK, coinPlan } from './coin.js';

export const CAMERA_Z = 5.2;               // the die's own distance (die3d.js Z_HOME)
export const EDGE_LIMIT = 0.96;            // the guard (Q74): the coin's edge stays inside 96 % of the box

// ---------- small maths ----------
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const Q = {
  aa(ax, a) { const l = Math.hypot(...ax) || 1, s = Math.sin(a / 2); return [ax[0] / l * s, ax[1] / l * s, ax[2] / l * s, Math.cos(a / 2)]; },
  mul(a, b) {
    return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  },
  m3(q) {
    const [x, y, z, w] = q;
    return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)];
  },
  rot(q, v) { const m = Q.m3(q); return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]]; },
};
function m4q(q, s, t) {
  const m = Q.m3(q);
  return new Float32Array([m[0] * s, m[1] * s, m[2] * s, 0, m[3] * s, m[4] * s, m[5] * s, 0, m[6] * s, m[7] * s, m[8] * s, 0, t[0], t[1], t[2], 1]);
}
function m3mul(a, b) {
  const o = new Float32Array(9);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) { let s = 0; for (let k = 0; k < 3; k++) s += a[k * 3 + r] * b[c * 3 + k]; o[c * 3 + r] = s; }
  return o;
}
function persp(asp) {
  const f = 1 / Math.tan(Math.PI / 8), n = 0.1, fr = 100;
  return new Float32Array([f / asp, 0, 0, 0, 0, f, 0, 0, 0, 0, (fr + n) / (n - fr), -1, 0, 0, 2 * fr * n / (n - fr), 0]);
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
export function gainFor(face) {                          // as die3d.js lightingFor: darker glazes a little brighter
  const [r, g, b] = hex(face);
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  return Math.max(1, Math.min(1.5, 1 + 0.9 * (0.72 - l)));
}
export const cameraTilt = (look) => Q.mul(Q.aa([1, 0, 0], -0.5 * look.camTilt), Q.aa([0, 0, 1], 0.12 * look.camTilt));
export function lampDir(look) {
  const az = look.lampAz * Math.PI / 180, el = look.lampEl * Math.PI / 180;
  return [Math.sin(el) * Math.cos(az), Math.sin(el) * Math.sin(az), Math.cos(el)];
}
const flatQ = (psi, theta, axAng) => Q.mul(Q.aa([0, 0, 1], psi), Q.aa([Math.cos(axAng), Math.sin(axAng), 0], theta));

// ---------- the motion (from the seed and the clock) ----------
// state: { x, y, h, q, scale, alpha, visible, phase, landed, still, faceUp }
export function tossMotion({ first, seed, timings, look = COIN_LOOK }) {
  const plan = coinPlan(timings);
  const T = plan.timings;
  const r = rng(seed);
  const startSeat = r() < 0.5 ? 1 : 2;
  let n = Math.round(T.flips * 2);
  if (((startSeat === first) ? 0 : 1) !== (n % 2)) n += 1;          // half turns: the winner's face ends up
  const m = {
    startSeat, n, alpha: r() * Math.PI * 2 * 0.15 + (r() < 0.5 ? 0 : Math.PI), wph: r() * 6.28, wfreq: 1.5 + r() * 1.5,
    psi0: r() * 6.28, spin: (r() - 0.5) * 2.4, dx: (r() - 0.5) * 0.35, dy: (r() - 0.5) * 0.25, phi0: r() * 6.28,
    dir: r() < 0.5 ? -1 : 1, rock: r() < 0.5 ? 1 : -1, k: 1,
  };
  const th0 = startSeat === 1 ? 0 : Math.PI, Th = n * Math.PI;
  const endQ = flatQ(m.psi0 + m.spin, th0 + Th, m.alpha);
  const base = { x: 0, y: 0, h: 0, scale: 1, alpha: 1, visible: true };
  function sample(t) {
    const s = plan.seg.find((x) => t >= x.t0 && t < x.t0 + x.d) || null;
    if (t < 0) return { ...base, q: flatQ(m.psi0, th0, m.alpha), phase: 'still' };
    if (!s) return { ...base, x: m.dx, y: m.dy, q: endQ, visible: false, phase: 'done', landed: true, still: true };
    const u = s.d > 0 ? (t - s.t0) / s.d : 1;
    if (s.k === 'still') return { ...base, q: flatQ(m.psi0, th0, m.alpha), phase: 'still' };
    if (s.k === 'air') {
      const wob = T.wobble * Math.sin(6.2832 * u * m.wfreq + m.wph);
      const q = Q.mul(Q.aa([0, 0, 1], m.psi0 + m.spin * u), Q.aa([Math.cos(m.alpha + wob), Math.sin(m.alpha + wob), 0], th0 + Th * u));
      return { ...base, x: m.dx * u, y: m.dy * u, h: T.height * m.k * 4 * u * (1 - u), q, phase: 'air' };
    }
    if (s.k === 'bounce') {
      const i = s.i - 1;
      const rock = T.wobble * 0.8 * Math.pow(T.bounceHeight, i + 0.5) * Math.sin(Math.PI * u) * (i % 2 ? -1 : 1) * m.rock;
      return { ...base, x: m.dx, y: m.dy, h: T.height * m.k * s.share * 4 * u * (1 - u), q: Q.mul(Q.aa([Math.cos(m.alpha), Math.sin(m.alpha), 0], rock), endQ), phase: 'bounce', landed: true };
    }
    if (s.k === 'settle') {
      const a = T.settleTilt * Math.pow(1 - u, 2);
      const ph = m.phi0 + m.dir * 6.2832 * (2 * u + 5 * u * u);
      return { ...base, x: m.dx, y: m.dy, h: Math.sin(a) * look.size, q: Q.mul(Q.aa([Math.cos(ph), Math.sin(ph), 0], a), endQ), phase: 'settle', landed: true };
    }
    if (s.k === 'rest') return { ...base, x: m.dx, y: m.dy, q: endQ, phase: 'rest', landed: true, still: true };
    // The hand-off (owner: "Slide to keepsake"): down and to the left, shrinking and fading, toward the scores.
    const e = u * u * (3 - 2 * u);
    return { ...base, x: m.dx + (-1.7 - m.dx) * e, y: m.dy + (-1.6 - m.dy) * e, q: endQ, scale: Math.max(0.001, 1 - 0.88 * e), alpha: 1 - e * e * 0.6, phase: 'handoff', landed: true, still: true };
  }
  // The guard (Q74): if this seed's drift and wobble would carry the coin's edge out of the box at the top
  // of the toss, lower this toss just enough. Almost every seed leaves k at 1.
  m.k = guardFactor(sample, plan, look);
  return { plan, sample, startSeat, halfTurns: n, heightFactor: m.k, finalQ: endQ };
}

// How far out of the box the coin reaches over the toss (the largest |x| or |y| on screen, -1 to 1).
export function reachOf(sample, plan, look, steps = 90) {
  const tilt = cameraTilt(look), view = m4q(tilt, 1, [0, 0, -CAMERA_Z]), proj = persp(1);
  const air = plan.seg.find((s) => s.k === 'air');
  const lastBounce = [...plan.seg].reverse().find((s) => s.k === 'bounce') || air;
  const t0 = air.t0, t1 = lastBounce.t0 + lastBounce.d;
  const R = look.size, half = look.thickness * look.size / 2;
  let worst = 0;
  for (let i = 0; i <= steps; i++) {
    const st = sample(t0 + (t1 - t0) * i / steps);
    const mm = Q.m3(st.q);
    for (let j = 0; j < 24; j++) {
      const a = j / 24 * Math.PI * 2;
      for (const z of [-half, half]) {
        const p = [R * Math.cos(a), R * Math.sin(a), z];
        const w = [mm[0] * p[0] + mm[3] * p[1] + mm[6] * p[2] + st.x, mm[1] * p[0] + mm[4] * p[1] + mm[7] * p[2] + st.y, mm[2] * p[0] + mm[5] * p[1] + mm[8] * p[2] + st.h];
        const v = [view[0] * w[0] + view[4] * w[1] + view[8] * w[2] + view[12], view[1] * w[0] + view[5] * w[1] + view[9] * w[2] + view[13], view[2] * w[0] + view[6] * w[1] + view[10] * w[2] + view[14]];
        const cw = -v[2];
        if (cw <= 0.01) return Infinity;
        worst = Math.max(worst, Math.abs(proj[0] * v[0] / cw), Math.abs(proj[5] * v[1] / cw));
      }
    }
  }
  return worst;
}
function guardFactor(sample, plan, look) {
  // While this runs the toss's own factor is still 1: try lower tosses by scaling its heights.
  const tryK = (k) => reachOf((t) => scaleHeight(sample(t), k), plan, look);
  if (tryK(1) <= EDGE_LIMIT) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (tryK(mid) <= EDGE_LIMIT) lo = mid; else hi = mid; }
  return lo;
}
const scaleHeight = (st, k) => (st.phase === 'air' || st.phase === 'bounce' ? { ...st, h: st.h * k } : st);

// ---------- the coin's shape: a lathe (recessed face, inner wall, rim top, rounded bevel, edge) ----------
function buildCoin(look) {

const T=look.thickness,zt=T/2,zf=Math.max(0.004,zt-look.rimHeight),ri=1-look.rimWidth,bev=Math.min(look.outerBevel,look.rimWidth*0.45,zt*0.9),wall=Math.min(look.rimHeight*0.8,look.rimWidth*0.4);
const prof=[];
const seg=(a,b,part,na,nb)=>prof.push({a,b,part,na,nb});
const flatN=(a,b)=>{const dr=b[0]-a[0],dz=b[1]-a[1],l=Math.hypot(dr,dz)||1;return[-dz/l,dr/l]};
const add=(a,b,part)=>{const n=flatN(a,b);seg(a,b,part,n,n)};
add([0,zf],[ri,zf],0);
add([ri,zf],[ri+wall,zt],1);
add([ri+wall,zt],[1-bev,zt],1);
const K=5;
for(let i=0;i<K;i++){const a0=Math.PI/2*(1-i/K),a1=Math.PI/2*(1-(i+1)/K);seg([1-bev+bev*Math.cos(a0),zt-bev+bev*Math.sin(a0)],[1-bev+bev*Math.cos(a1),zt-bev+bev*Math.sin(a1)],1,[Math.cos(a0),Math.sin(a0)],[Math.cos(a1),Math.sin(a1)])}
add([1,zt-bev],[1,-(zt-bev)],2);
for(let i=0;i<K;i++){const a0=-Math.PI/2*(i/K),a1=-Math.PI/2*((i+1)/K);seg([1-bev+bev*Math.cos(a0),-(zt-bev)+bev*Math.sin(a0)],[1-bev+bev*Math.cos(a1),-(zt-bev)+bev*Math.sin(a1)],1,[Math.cos(a0),Math.sin(a0)],[Math.cos(a1),Math.sin(a1)])}
add([1-bev,-zt],[ri+wall,-zt],1);
add([ri+wall,-zt],[ri,-zf],1);
add([ri,-zf],[0,-zf],0);
const M=128,pos=[],nor=[],part=[],idx=[];
for(const s of prof){const base=pos.length/3;
for(let j=0;j<=M;j++){const f=j/M*Math.PI*2,c=Math.cos(f),sn=Math.sin(f);
for(const[p,n]of[[s.a,s.na],[s.b,s.nb]]){pos.push(p[0]*c,p[0]*sn,p[1]);nor.push(n[0]*c,n[0]*sn,n[1]);part.push(s.part)}}
for(let j=0;j<M;j++){const a=base+j*2;idx.push(a,a+1,a+3,a,a+3,a+2)}}
return{pos:new Float32Array(pos),nor:new Float32Array(nor),part:new Float32Array(part),idx:new Uint32Array(idx)};

}

// ---------- the shaders (from the tuning panel) ----------
const VS=`attribute vec3 aP;attribute vec3 aN;attribute float aPart;uniform mat4 uM;uniform mat4 uV;uniform mat4 uPr;varying vec3 vObj;varying vec3 vObjN;varying float vPart;varying vec3 vVP;
void main(){vec4 vp=uV*uM*vec4(aP,1.0);vVP=vp.xyz;gl_Position=uPr*vp;vObj=aP;vObjN=aN;vPart=aPart;}`;
const FS=`#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 vObj;varying vec3 vObjN;varying float vPart;varying vec3 vVP;
uniform mat3 uNM;uniform vec3 uL;uniform vec3 uMetal;uniform vec3 uDMetal;uniform vec3 uG1;uniform vec3 uG2;uniform vec3 uCentre;uniform vec2 uGain;
uniform vec4 uDaisy;uniform float uDaisyRelief;uniform vec2 uRidge;uniform vec4 uMS;uniform vec4 uMI;uniform vec4 uMI2;uniform vec4 uFS;uniform vec4 uFI;uniform vec4 uFI2;
uniform float uRimGlow;uniform float uAlpha;
float hash(vec3 p){p=fract(p*0.3183099+0.1);p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise(vec3 x){vec3 i=floor(x);vec3 f=fract(x);f=f*f*(3.0-2.0*f);
return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
vec2 h2(vec2 p){p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)));return fract(sin(p)*43758.5453);}
float vedge(vec2 x){vec2 n=floor(x);vec2 f=fract(x);vec2 mg=vec2(0.0);vec2 mr=vec2(0.0);float md=8.0;
for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){vec2 g=vec2(float(i),float(j));vec2 r=g+h2(n+g)-f;float d=dot(r,r);if(d<md){md=d;mr=r;mg=g;}}
md=8.0;for(int j=-2;j<=2;j++)for(int i=-2;i<=2;i++){vec2 g=mg+vec2(float(i),float(j));vec2 r=g+h2(n+g)-f;if(dot(mr-r,mr-r)>0.00001)md=min(md,dot(0.5*(mr+r),normalize(r-mr)));}
return md;}
float daisyH(vec2 p){float r=length(p);float a=atan(p.y,p.x);float sec=6.2831853/uDaisy.y;float k=floor(a/sec+0.5)*sec;float c=cos(k);float s=sin(k);
vec2 q=vec2(c*p.x+s*p.y,-s*p.x+c*p.y);float w=min(0.17*12.0/uDaisy.y,0.32);float pe=length((q-vec2(0.62,0.0))/vec2(0.40,w));
float sf=max(uDaisy.w,0.03);float hp=smoothstep(1.0,1.0-sf,pe);float ring=smoothstep(0.34,0.34-0.12*sf-0.01,r)*smoothstep(0.18,0.2,r);return max(hp,ring);}
void main(){
vec3 N=normalize(vObjN);float part=vPart;float side=vObjN.z>=0.0?1.0:-1.0;
float metalMask=part>0.5?1.0:0.0;float centreMask=0.0;float mark=0.0;
if(part<0.5){float sc=uDaisy.z*uDaisy.x;vec2 uv=vec2(vObj.x*side,vObj.y)/sc;float e=0.006;
float h0=daisyH(uv);
float du=(daisyH(uv+vec2(e,0.0))-daisyH(uv-vec2(e,0.0)))/(2.0*e);float dv=(daisyH(uv+vec2(0.0,e))-daisyH(uv-vec2(0.0,e)))/(2.0*e);
float sx=du/sc*uDaisyRelief;float sy=dv/sc*uDaisyRelief;
N=normalize(vec3(-side*sx,-sy,side));
metalMask=smoothstep(0.35,0.65,h0);
centreMask=(1.0-smoothstep(0.17,0.19,length(uv)))*(1.0-metalMask);
}
bool isMetal=metalMask>0.5;
vec4 S=isMetal?uMS:uFS;vec4 I=isMetal?uMI:uFI;vec4 I2=isMetal?uMI2:uFI2;
if(part>1.5){float th=atan(vObj.y,vObj.x);vec3 t=vec3(-sin(th),cos(th),0.0);N=normalize(N+t*uRidge.y*sin(th*uRidge.x));}
float g=max(S.w,0.5);float e2=0.5/g;vec3 pq=vObj*g;float n0=noise(pq);
vec3 gr=vec3(noise(pq+vec3(e2*g,0,0))-n0,noise(pq+vec3(0,e2*g,0))-n0,noise(pq+vec3(0,0,e2*g))-n0)/(e2*g);
gr=gr-dot(gr,N)*N;N=normalize(N-S.z*0.6*gr);
vec3 Nv=normalize(uNM*N);vec3 V=normalize(-vVP);vec3 L=normalize(uL);
float dif=max(dot(Nv,L),0.0);vec3 R=reflect(-L,Nv);float rv=max(dot(R,V),0.0);float ndv=max(dot(Nv,V),0.0);
vec3 Rv=reflect(-V,Nv);float env=mix(0.12,0.95,smoothstep(-0.4,0.7,Rv.y));env=mix(env,0.5,S.x*0.6);
vec3 col;
if(isMetal){vec3 M=part>0.5?uMetal:uDMetal;float sp=pow(rv,mix(220.0,6.0,S.x))*S.y*mix(2.2,0.5,S.x);
col=M*(0.18+0.35*dif+0.75*env)+M*sp+vec3(sp)*0.25;}
else{vec3 G=side>0.0?uG1:uG2;float gn=side>0.0?uGain.x:uGain.y;G=mix(G,uCentre,centreMask);
float sp=pow(rv,mix(160.0,8.0,S.x))*S.y;float fr=pow(1.0-ndv,3.0);
col=G*(0.38+0.75*dif)*gn+vec3(sp)+vec3(fr*0.18*env*S.y);col*=1.0-0.55*mark;}
float ph=I.y*(1.0-ndv)*I.w+I.z+noise(vObj*3.0)*0.3;vec3 ir=0.5+0.5*cos(6.2831853*(ph+vec3(0.0,0.33,0.67)));
float pm=mix(1.0,smoothstep(0.35,0.65,noise(vObj*4.0+7.0)),I2.x);float amt=I.x*pm;
col=isMetal?mix(col,col*ir*1.8,amt):mix(col,col*(0.55+ir*0.9),amt);
if(I2.y>0.001){vec2 cc=abs(vObjN.z)>0.5?vObj.xy:vec2(atan(vObj.y,vObj.x),vObj.z*3.0);float ln=1.0-smoothstep(0.0,0.012+0.06*I2.y,vedge(cc/max(I2.w,0.02)));col*=1.0-ln*I2.z;}
float fres=pow(1.0-ndv,1.1);col+=vec3(1.0,0.92,0.7)*fres*uRimGlow;
gl_FragColor=vec4(col,uAlpha);}`;
const SVS=`attribute vec2 aC;uniform vec3 uC;uniform vec2 uU;uniform vec2 uE;uniform mat4 uV;uniform mat4 uPr;varying vec2 vL;
void main(){vec2 o=aC*uE.x;vec2 w=uU*o.x+vec2(-uU.y,uU.x)*o.y;vL=o;gl_Position=uPr*uV*vec4(uC.xy+w,uC.z,1.0);}`;
const SFS=`precision mediump float;varying vec2 vL;uniform vec3 uS;uniform float uSoft;
void main(){float d=length(vec2(vL.x/uS.x,vL.y/uS.y));float a=uS.z*(1.0-smoothstep(1.0-uSoft,1.0+uSoft,d));gl_FragColor=vec4(0.0,0.0,0.0,a);}`;

// ---------- the 3D view ----------
export function createCoinView(canvas, look = COIN_LOOK) {
  let gl = null;
  try { gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false }); } catch { gl = null; }
  if (!gl || !gl.getExtension('OES_element_index_uint')) return null;
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const prog = (v, f) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, v)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, f)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; };
  let pc, ps;
  try { pc = prog(VS, FS); ps = prog(SVS, SFS); } catch (err) { console.error('daisy: the coin could not be drawn', err); return null; }
  const U = {}, u = (p, n) => gl.getUniformLocation(p, n);
  ['uM', 'uV', 'uPr', 'uNM', 'uL', 'uMetal', 'uDMetal', 'uG1', 'uG2', 'uCentre', 'uGain', 'uDaisy', 'uDaisyRelief', 'uRidge', 'uMS', 'uMI', 'uMI2', 'uFS', 'uFI', 'uFI2', 'uRimGlow', 'uAlpha'].forEach((n) => { U[n] = u(pc, n); });
  const SU = {};
  ['uC', 'uU', 'uE', 'uV', 'uPr', 'uS', 'uSoft'].forEach((n) => { SU[n] = u(ps, n); });
  const A = { p: gl.getAttribLocation(pc, 'aP'), n: gl.getAttribLocation(pc, 'aN'), part: gl.getAttribLocation(pc, 'aPart'), c: gl.getAttribLocation(ps, 'aC') };
  const buf = (d, k = gl.ARRAY_BUFFER) => { const b = gl.createBuffer(); gl.bindBuffer(k, b); gl.bufferData(k, d, gl.STATIC_DRAW); return b; };
  const g0 = buildCoin(look);
  const geo = { p: buf(g0.pos), n: buf(g0.nor), part: buf(g0.part), i: buf(g0.idx, gl.ELEMENT_ARRAY_BUFFER), count: g0.idx.length };
  const quad = buf(new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]));
  const tilt = cameraTilt(look), L = lampDir(look);
  let lost = false;

  function draw(st, glazes) {
    if (lost) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!st || !st.visible) return;
    const view = m4q(tilt, 1, [0, 0, -CAMERA_Z]), pr = persp(w / h);
    const tableZ = -look.thickness * look.size / 2;
    if (look.shadow) {
      gl.useProgram(ps); gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const n = Q.rot(st.q, [0, 0, 1]); const nz = Math.abs(n[2]), nxy = Math.hypot(n[0], n[1]);
      const ux = nxy > 1e-4 ? [-n[1] / nxy, n[0] / nxy] : [1, 0];
      const hgt = Math.max(0, st.h), R = look.size * st.scale;
      const major = R * (1 + hgt * 0.25 * look.shSoft), minor = Math.max(R * nz + look.thickness * look.size * nxy, R * 0.06) * (1 + hgt * 0.25 * look.shSoft);
      const off = [-L[0] / Math.max(L[2], 0.2) * hgt * 0.5, -L[1] / Math.max(L[2], 0.2) * hgt * 0.5];
      gl.uniform3f(SU.uC, st.x + off[0], st.y + off[1], tableZ); gl.uniform2f(SU.uU, ux[0], ux[1]); gl.uniform2f(SU.uE, major * 2.2, 0);
      gl.uniformMatrix4fv(SU.uV, false, view); gl.uniformMatrix4fv(SU.uPr, false, pr);
      gl.uniform3f(SU.uS, major, minor, look.shDark * st.alpha / (1 + hgt * 0.6)); gl.uniform1f(SU.uSoft, Math.min(0.95, 0.08 + look.shSoft * (0.25 + hgt * 0.3)));
      gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(A.c); gl.vertexAttribPointer(A.c, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6); gl.disableVertexAttribArray(A.c);
    }
    gl.useProgram(pc); gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
    if (st.alpha < 1) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); } else gl.disable(gl.BLEND);
    gl.uniformMatrix4fv(U.uM, false, m4q(st.q, look.size * st.scale, [st.x, st.y, st.h]));
    gl.uniformMatrix4fv(U.uV, false, view); gl.uniformMatrix4fv(U.uPr, false, pr);
    gl.uniformMatrix3fv(U.uNM, false, m3mul(Q.m3(tilt), Q.m3(st.q)));
    gl.uniform3fv(U.uL, L);
    gl.uniform3fv(U.uMetal, hex(look.metalColor)); gl.uniform3fv(U.uDMetal, hex(look.daisyMetal));
    gl.uniform3fv(U.uG1, hex(glazes[0])); gl.uniform3fv(U.uG2, hex(glazes[1])); gl.uniform3fv(U.uCentre, hex(look.centre));
    gl.uniform2f(U.uGain, gainFor(glazes[0]), gainFor(glazes[1]));
    gl.uniform4f(U.uDaisy, look.daisySize, look.petals, 1 - look.rimWidth, look.reliefSoft); gl.uniform1f(U.uDaisyRelief, look.relief);
    gl.uniform2f(U.uRidge, look.ridges, look.ridges > 0 ? look.ridgeDepth : 0);
    gl.uniform4f(U.uMS, look.mRough, look.mGlint, look.mBump, look.mGrain); gl.uniform4f(U.uMI, look.mIri, look.mIRange, look.mIHue, look.mIShift); gl.uniform4f(U.uMI2, look.mIPatch, look.mCrack, look.mCrackDark, look.mCrackCell);
    gl.uniform4f(U.uFS, look.fRough, look.fGlint, look.fBump, look.fGrain); gl.uniform4f(U.uFI, look.fIri, look.fIRange, look.fIHue, look.fIShift); gl.uniform4f(U.uFI2, look.fIPatch, look.fCrack, look.fCrackDark, look.fCrackCell);
    gl.uniform1f(U.uRimGlow, look.rimGlow); gl.uniform1f(U.uAlpha, st.alpha);
    const at = (b, l, k) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, k, gl.FLOAT, false, 0, 0); };
    at(geo.p, A.p, 3); at(geo.n, A.n, 3); at(geo.part, A.part, 1); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, geo.i);
    gl.drawElements(gl.TRIANGLES, geo.count, gl.UNSIGNED_INT, 0);
    gl.disableVertexAttribArray(A.p); gl.disableVertexAttribArray(A.n); gl.disableVertexAttribArray(A.part); gl.disable(gl.CULL_FACE);
  }
  // After the hand-off the drawing surface is given back (Q76), so a page with both tiles holds the
  // extra graphics contexts only for the toss.
  function lose() {
    if (lost) return;
    lost = true;
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
  return { draw, lose };
}

// ---------- the flat coin (browsers without WebGL) ----------
// The same motion, seen from the front: the coin narrows as it turns end over end, shows the face that's
// toward you, grows a little as it rises.
export function drawFlatCoin(g, st, glazes, look = COIN_LOOK, box = 132) {
  g.clearRect(0, 0, box, box);
  if (!st || !st.visible) return;
  const tilt = cameraTilt(look), view = Q.m3(Q.mul(tilt, st.q));
  const nz = view[8];                                     // the coin's +Z (seat 1's face) toward the viewer
  const grow = CAMERA_Z / Math.max(1.5, CAMERA_Z - st.h);
  const R = box * 0.36 * look.size * st.scale * grow;
  g.save();
  g.globalAlpha = st.alpha;
  g.translate(box / 2 + st.x * box * 0.18, box / 2 - st.y * box * 0.18);
  const ang = Math.atan2(-view[7], view[6]);      // (the canvas's y runs down)               // which way the coin is tipping on screen
  g.rotate(ang);
  g.scale(Math.max(0.06, Math.abs(nz)), 1);
  g.rotate(-ang);
  drawFace(g, R, nz >= 0 ? glazes[0] : glazes[1], look);
  g.restore();
}
function drawFace(g, R, glaze, look) {
  g.fillStyle = look.metalColor;
  g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 1; g.stroke();
  const inner = R * (1 - look.rimWidth) * 0.92;
  g.fillStyle = glaze;
  g.beginPath(); g.arc(0, 0, inner, 0, Math.PI * 2); g.fill();
  const D = inner * look.daisySize;
  g.fillStyle = look.daisyMetal;
  for (let k = 0; k < look.petals; k++) {
    g.save(); g.rotate(k / look.petals * Math.PI * 2);
    g.beginPath(); g.ellipse(0, -D * 0.62, Math.max(0.6, D * Math.min(0.17 * 12 / look.petals, 0.32)), D * 0.4, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  g.beginPath(); g.arc(0, 0, D * 0.34, 0, Math.PI * 2); g.fill();
  g.fillStyle = look.centre;
  g.beginPath(); g.arc(0, 0, D * 0.2, 0, Math.PI * 2); g.fill();
}

// ---------- the keepsake (Q67): a tiny flat coin in the first player's glaze ----------
export function drawKeepsake(canvas, glaze, look = COIN_LOOK, px = look.keepSize) {
  const d = Math.min(globalThis.devicePixelRatio || 1, 3);
  canvas.width = canvas.height = Math.round(px * d);
  canvas.style.width = canvas.style.height = `${px}px`;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(d, 0, 0, d, 0, 0);
  g.clearRect(0, 0, px, px);
  g.translate(px / 2, px / 2);
  drawFace(g, px / 2 - 0.5, glaze, look);
}
