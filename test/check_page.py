"""Browser checks for the site's Daisy page (build steps 2 to 6): two separate pages, as on two
computers, playing through the stand-in relay; signing in to sit (with a stand-in for the sign-in
library: real sign-ins can only be tested by the owner), saving, the house version check, and the
published tiles, pinned (published to a stand-in PDS with the real scripts/publish.mjs).

Bundles the site's src/daisy/ code with the real @dasl/tile-loader (esbuild), runs the loading server's
own files with test/loader-replica.mjs (needs port 80) and scripts/relay-standin.mjs, and plays in
Chromium with two separate browser contexts (separate storage, like two computers). Handle lookups are
answered by the test.

Usage:
  python3 test/check_page.py --site <site folder> --loader <tiles-loading-server folder>
         --modules <folder holding node_modules/@dasl/tile-loader> [--esbuild <esbuild>] [--shots DIR]
"""
import base64, functools, http.server, json, os, re, shutil, socketserver, subprocess, sys, tempfile, threading, time, urllib.parse
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


SITE, LOADER, MODULES = arg('--site'), arg('--loader'), arg('--modules')
ESBUILD = arg('--esbuild', '/opt/npm-tools/node_modules/.bin/esbuild')
SHOTS = arg('--shots')
if not (SITE and LOADER and MODULES):
    print(__doc__)
    sys.exit(2)

DIDS = {'pyxorium.com': 'did:plc:rqbqpaaluty5v47jwciowpik', 'thunderbirdwine.bsky.social': 'did:plc:joer5rzmwgec3dkr4srfmq45',
        'colorado.atprotocol.space': 'did:plc:ro563p5faldqu44apudq44k4'}
RELAY_PORT = 8787
passed, failed = [], []


def check(name, cond, detail=''):
    (passed if cond else failed).append(name)
    print(('  ok  ' if cond else '  FAIL ') + name + (f'  ({detail})' if detail and not cond else ''), flush=True)


# A stand-in for @atproto/oauth-client-browser: the same calls the page's auth.js makes (as Seven-Up's
# checks). Controlled from the checks through window.__fakeAuth.
FAKE_LIB = r"""
const HANDLES = %(HANDLES)s;
// Sign-ins survive a reload, as the real library keeps them in the browser (IndexedDB).
class KeptSet extends Set {
  constructor() { super(JSON.parse(localStorage.getItem('fake-valid') || '[]')); }
  add(v) { super.add(v); localStorage.setItem('fake-valid', JSON.stringify([...this])); return this; }
  delete(v) { const r = super.delete(v); localStorage.setItem('fake-valid', JSON.stringify([...this])); return r; }
}
window.__fakeAuth = { valid: new KeptSet(), signInAs: {}, expired: new Set(), failNext: false, saved: [], signIns: [] };
const F = () => window.__fakeAuth;
// The permission each account's sign-in was given (step 6): the sets expand as a real server does it.
const SCOPES = JSON.parse(localStorage.getItem('fake-scopes') || '{}');
const expand = (scope) => ['repo:cafe.thunderbird.daisy.match', ...(/authLounge/.test(scope || '') ? ['repo:cafe.thunderbird.daisy.lounge', 'rpc:cafe.thunderbird.daisy.lounge.enter?aud=did:web:relay.daisy.thunderbird.cafe%%23daisy_relay'] : []), 'atproto'].join(' ');
function session(did) {
  return {
    did, sub: did,
    async getTokenInfo() { return { sub: did, scope: expand(SCOPES[did]) }; },
    async fetchHandler(path, init = {}) {
      if (F().expired.has(did)) return new Response(JSON.stringify({ error: 'InvalidToken', message: 'expired' }), { status: 401 });
      if (path.startsWith('/xrpc/com.atproto.server.getServiceAuth')) {
        if (!/authLounge/.test(SCOPES[did] || '')) return new Response(JSON.stringify({ error: 'ScopeMissingError' }), { status: 403 });
        return new Response(JSON.stringify({ token: `pass:${did}` }), { status: 200 });
      }
      if (init.body && /cafe\.thunderbird\.daisy\.lounge/.test(init.body)) {          // lounge records live at the stand-in PDS
        F().lounge = (F().lounge || 0) + 1;
        return fetch(`https://pds.test${path}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: init.body });
      }
      if (F().failNext) { F().failNext = false; return new Response(JSON.stringify({ error: 'InternalServerError' }), { status: 500 }); }
      const body = JSON.parse(init.body);
      F().saved.push({ did, path, ...body });
      return new Response(JSON.stringify({ uri: `at://${did}/${body.collection}/${body.rkey}`, cid: 'bafyfakecid' }), { status: 200 });
    },
  };
}
class LoginContinuedInParentWindowError extends Error {}
class BrowserOAuthClient {
  static async load(opts) { window.__fakeAuth.clientId = opts.clientId; return new BrowserOAuthClient(); }
  async init() {}
  addEventListener() {}
  async signInPopup(handle, { signal, popupName, scope } = {}) {
    await new Promise((r) => setTimeout(r, 300));
    if (signal && signal.aborted) throw new Error('Aborted');
    try { const w = window.open('', popupName); if (w) w.close(); } catch {}
    const did = F().signInAs[handle] || HANDLES[handle];
    delete F().signInAs[handle];
    SCOPES[did] = scope || ''; localStorage.setItem('fake-scopes', JSON.stringify(SCOPES));
    F().valid.add(did); F().expired.delete(did); F().signIns.push(handle); (F().scopesAsked ||= []).push(scope || '');
    return session(did);
  }
  async restore(did) { if (!F().valid.has(did)) throw new Error('no session'); return session(did); }
  async revoke(did) { F().valid.delete(did); }
}
"""


def build(out, daisy=None, name='index', csp=None):
    """Bundles the site's Daisy code (or a changed copy of it) as <name>.html, with the stand-in sign-in."""
    daisy = daisy or os.path.join(SITE, 'src', 'daisy')
    with open(os.path.join(out, 'fake-oauth.js'), 'w') as f:
        f.write(FAKE_LIB % {'HANDLES': json.dumps(DIDS)} + '\nexport { BrowserOAuthClient, LoginContinuedInParentWindowError };\n')
    with open(os.path.join(out, f'{name}-entry.js'), 'w') as f:
        f.write("import { TileMothership, Tile } from '@dasl/tile-loader';\n"
                "import { MemoryTileLoader } from '@dasl/tile-loader/memory';\n"
                "import { BrowserOAuthClient, LoginContinuedInParentWindowError } from './fake-oauth.js';\n"
                f"import {{ createAuth }} from {json.dumps(os.path.join(daisy, 'auth.js'))};\n"
                f"import {{ mountTable }} from {json.dumps(os.path.join(daisy, 'table.js'))};\n"
                "const auth = createAuth({ BrowserOAuthClient, LoginContinuedInParentWindowError });\n"
                "auth.start().then((started) => { window.__daisy = mountTable(document.getElementById('daisy'), { TileMothership, MemoryTileLoader, Tile, auth, authProblem: started.error || null }); });\n")
    env = {**os.environ, 'NODE_PATH': os.path.join(MODULES, 'node_modules')}
    subprocess.run([ESBUILD, os.path.join(out, f'{name}-entry.js'), '--bundle', '--format=esm', f'--outfile={out}/{name}.js', '--log-level=warning'], check=True, env=env)
    if name == 'index':
        # The real entry (main.js) must bundle too; the sign-in library itself isn't in the sandbox.
        subprocess.run([ESBUILD, os.path.join(daisy, 'main.js'), '--bundle', '--format=esm', '--external:@atproto/oauth-client-browser',
                        f'--outfile={out}/main-check.js', '--log-level=warning'], check=True, env=env)
    css = ''.join(open(os.path.join(daisy, f)).read() for f in ('daisy-page.css', 'daisy.css'))
    open(os.path.join(out, 'daisy.css'), 'w').write(css)
    open(os.path.join(out, f'{name}.html'), 'w').write(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        + (f'<meta http-equiv="Content-Security-Policy" content="{csp}">' if csp else '') +
        '<title>Daisy</title><link rel="icon" href="data:,"><link rel="stylesheet" href="daisy.css"></head>'
        f'<body><div id="daisy"></div><script type="module" src="{name}.js"></script></body></html>')
    if name != 'index':
        return
    # A sheet of the six glazes, drawn by the player tile's own die3d.js.
    import shutil
    for f in ('die3d.js', 'dice.js', 'sha256.js'):
        shutil.copy(os.path.join(ROOT, 'player', f), os.path.join(out, f))
    open(os.path.join(out, 'glazes.html'), 'w').write(
        '<!doctype html><meta charset="utf-8"><title>glazes</title><body style="margin:0;background:#fbf7ec;display:grid;grid-template-columns:repeat(3,240px);gap:8px;padding:8px">'
        '<script type="module">import { createDie3d } from "./die3d.js"; import { GLAZES } from "./dice.js";'
        'window.__sheet = GLAZES.map((g, i) => { const c = document.createElement("canvas"); c.style.cssText = "width:240px;height:240px";'
        'document.body.append(c); const d = createDie3d(c, { glaze: g }); d.show(i + 1); return g.id; });</script></body>')


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def lookups(route):
    q = urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query)
    if 'app.bsky.actor.getProfiles' in route.request.url:          # step 6: names for the lounge
        by_did = {d: h for h, d in DIDS.items()}
        profiles = [{'did': d, 'handle': by_did[d], 'displayName': by_did[d].split('.')[0].title()} for d in q.get('actors', []) if d in by_did]
        return route.fulfill(status=200, content_type='application/json', body=json.dumps({'profiles': profiles}))
    did = DIDS.get((q.get('handle') or [''])[0])
    if did:
        return route.fulfill(status=200, content_type='application/json', body=json.dumps({'did': did}))
    return route.fulfill(status=400, content_type='application/json', body='{"error":"InvalidRequest"}')


LOUNGE = set()            # accounts with a lounge record at the stand-in PDS (step 6)
RELAY_DIR = os.path.join(os.path.dirname(ROOT), 'daisy-relay')
LOUNGE_PORT = 8788


def start_lounge_relay(blocks=''):
    """The real relay (C:\\thunderbird-cafe\\daisy-relay, server.js and lounge.js) with stand-in lookups, for the lounge."""
    env = {**os.environ, 'DAISY_BLOCKS': blocks, 'DAISY_LOUNGE_FAST': '1'}
    return subprocess.Popen(['node', os.path.join(RELAY_DIR, 'test', 'lounge-standin.mjs'), str(LOUNGE_PORT)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)


def start_relay():
    return subprocess.Popen(['node', os.path.join(ROOT, 'scripts', 'relay-standin.mjs'), str(RELAY_PORT)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


def variant(out, name, change, csp=None):
    """A changed copy of the site's Daisy code, bundled as <name>.html."""
    daisy = os.path.join(tempfile.mkdtemp(prefix=f'daisy-{name}-'), 'daisy')
    shutil.copytree(os.path.join(SITE, 'src', 'daisy'), daisy)
    change(daisy)
    build(out, daisy=daisy, name=name, csp=csp)
    return daisy


PDS = {'fixture': None, 'tamper': None, 'served': {'records': 0, 'blobs': 0}}
ACCOUNT = 'did:plc:6vxjigxrqizmbo56gojxico3'


def network(route):
    """plc.directory and the stand-in PDS holding the tiles published by the real publish.mjs."""
    url = urllib.parse.unquote(route.request.url)
    fx = PDS['fixture']
    if url.startswith('https://plc.directory/'):
        return route.fulfill(status=200, content_type='application/json', body=json.dumps(
            {'alsoKnownAs': ['at://thunderbird.cafe'], 'service': [{'id': '#atproto_pds', 'type': 'AtprotoPersonalDataServer', 'serviceEndpoint': 'https://pds.test'}]}))
    if url.startswith('https://pds.test/') and 'cafe.thunderbird.daisy.lounge' in url + (route.request.post_data or ''):
        # Step 6: lounge records (cafe.thunderbird.daisy.lounge/self), kept here.
        if 'getRecord' in url:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query)
            has = q['repo'][0] in LOUNGE
            return route.fulfill(status=200 if has else 400, content_type='application/json',
                                 body=json.dumps({'uri': 'at://x/cafe.thunderbird.daisy.lounge/self', 'value': {}} if has else {'error': 'RecordNotFound'}),
                                 headers={'access-control-allow-origin': '*'})
        body = json.loads(route.request.post_data or '{}')
        if 'putRecord' in url:
            LOUNGE.add(body['repo'])
        elif 'deleteRecord' in url:
            LOUNGE.discard(body['repo'])
        return route.fulfill(status=200, content_type='application/json', body=json.dumps({'uri': f"at://{body.get('repo')}/cafe.thunderbird.daisy.lounge/self"}),
                             headers={'access-control-allow-origin': '*'})
    if fx and url.startswith('https://pds.test/'):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query)
        if 'getRecord' in url:
            key = f"{q['collection'][0]}/{q['rkey'][0]}"
            rec = fx['pds']['records'].get(key)
            if not rec:
                return route.fulfill(status=400, content_type='application/json', body='{"error":"RecordNotFound"}')
            PDS['served']['records'] += 1
            which = 'house' if fx['published']['house']['uri'].endswith(q['rkey'][0]) else 'player'
            cid = 'bafyreichangedrecord' if PDS['tamper'] == which else rec['cid']
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'uri': f"at://{ACCOUNT}/{key}", 'cid': cid, 'value': rec['value']}))
        if 'getBlob' in url:
            b = fx['pds']['blobs'].get(q['cid'][0])
            if b:
                PDS['served']['blobs'] += 1
                return route.fulfill(status=200, content_type=b['mimeType'], body=base64.b64decode(b['base64']))
    return route.fulfill(status=404, body='')


def suggestions(route):
    """A stand-in for typeahead.waow.tech (the handle suggestions)."""
    q = (urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query).get('q') or [''])[0]
    actors = [{'did': d, 'handle': h, 'displayName': h.split('.')[0].title()} for h, d in DIDS.items() if h.startswith(q.lower())]
    return route.fulfill(status=200, content_type='application/json', body=json.dumps({'actors': actors}))


def main():
    out = tempfile.mkdtemp(prefix='daisy-page-')
    # The memory tiles for the main checks: the site's own published.generated.js pins the real published
    # tiles, which only the real PDS serves (the published tiles are checked further down, from a stand-in PDS).
    variant(out, 'index', lambda d: open(os.path.join(d, 'published.generated.js'), 'w').write('export const PUBLISHED = null;\n'))
    # A page whose house is another version (the house version check).
    def other_house(d):
        f = os.path.join(d, 'tiles.generated.js')
        text = open(f).read()
        assert 'MEMORY_HOUSE_VERSION = "' in text
        open(f, 'w').write(re.sub(r'MEMORY_HOUSE_VERSION = "[^"]+"', 'MEMORY_HOUSE_VERSION = "memory:000000000000000000000000"', text))
        open(os.path.join(d, 'published.generated.js'), 'w').write('export const PUBLISHED = null;\n')
    variant(out, 'other', other_house)
    # The published tiles: published to a stand-in PDS with the real publish.mjs, then pinned as
    # copy-to-site.mjs does it; this page also runs under the page's real security policy.
    fixture_file = os.path.join(out, 'fixture.json')
    subprocess.run(['node', os.path.join(HERE, 'make-published-fixture.mjs'), fixture_file], check=True, capture_output=True)
    PDS['fixture'] = json.load(open(fixture_file))
    pub = PDS['fixture']['published']
    pinned = {'account': ACCOUNT, 'house': {'uri': pub['house']['uri'], 'cid': pub['house']['cid']}, 'player': {'uri': pub['player']['uri'], 'cid': pub['player']['cid']}}
    csp = subprocess.run(['node', '--input-type=module', '-e',
                          f"import({json.dumps('file://' + os.path.join(SITE, 'src', 'daisy', 'config.js'))}).then(m => process.stdout.write(m.pageCsp('load.tiles.lex.localhost')))"],
                         check=True, capture_output=True, text=True).stdout
    csp = (csp.replace('https://load.tiles.lex.localhost', 'http://load.tiles.lex.localhost').replace('https://*.tiles.lex.localhost', 'http://*.tiles.lex.localhost')
           .replace("connect-src 'self' https: wss:", f"connect-src 'self' https: wss: ws://127.0.0.1:{RELAY_PORT}"))
    pub_dir = variant(out, 'pub', lambda d: open(os.path.join(d, 'published.generated.js'), 'w').write(f'export const PUBLISHED = {json.dumps(pinned)};\n'), csp=csp)
    # The published tiles on their own, as a tile gallery shows them: no Daisy page sets them up.
    with open(os.path.join(out, 'alone-entry.js'), 'w') as f:
        f.write("import { TileMothership, Tile } from '@dasl/tile-loader';\n"
                f"import {{ createPinnedLoader }} from {json.dumps(os.path.join(pub_dir, 'pinned-loader.js'))};\n"
                f"import {{ PUBLISHED }} from {json.dumps(os.path.join(pub_dir, 'published.generated.js'))};\n"
                "const ship = new TileMothership({ loadDomain: 'load.tiles.lexicographer.space' });\n"
                "ship.getLoadSource = () => 'http://load.tiles.lex.localhost/.well-known/web-tiles/';\n"
                "ship.init();\n"
                "ship.addLoader(createPinnedLoader({ Tile, pins: [PUBLISHED.house, PUBLISHED.player] }));\n"
                "for (const which of ['house', 'player']) { const t = await ship.loadTile(PUBLISHED[which].uri); const fr = t.renderContent(420);"
                " fr.id = which; fr.style.cssText = 'width:420px;height:420px;border:1px solid #ccc;margin:8px'; document.body.append(fr); }\n"
                "window.__aloneReady = true;\n")
    subprocess.run([ESBUILD, os.path.join(out, 'alone-entry.js'), '--bundle', '--format=esm', f'--outfile={out}/alone.js', '--log-level=warning'],
                   check=True, env={**os.environ, 'NODE_PATH': os.path.join(MODULES, 'node_modules')})
    open(os.path.join(out, 'alone.html'), 'w').write('<!doctype html><meta charset="utf-8"><title>alone</title><body style="margin:0;background:#eee;display:flex">'
                                                     '<script type="module" src="alone.js"></script></body>')
    replica = subprocess.Popen(['node', os.path.join(HERE, 'loader-replica.mjs'), LOADER, '80'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    relay = start_relay()
    time.sleep(0.8)
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=out))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{srv.server_address[1]}/index.html?loader=http://load.tiles.lex.localhost/.well-known/web-tiles/'

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
            errors = []

            def computer(width=1120):
                ctx = browser.new_context(viewport={'width': width, 'height': 1000})
                ctx.route('https://public.api.bsky.app/**', lookups)
                ctx.route('https://plc.directory/**', network)
                ctx.route('https://pds.test/**', network)
                ctx.route('https://typeahead.waow.tech/**', suggestions)
                page = ctx.new_page()
                page.on('console', lambda m: errors.append(f"{m.text} {(m.location or {}).get('url', '')}") if m.type == 'error' else None)
                page.on('pageerror', lambda e: errors.append(str(e)))
                return ctx, page

            def tile(page, role):
                return page.frame_locator(f'.dz-{role} .dz-mount iframe').frame_locator('iframe')

            def tile_frame(page, role):
                sel = '.dz-house-mount iframe' if role == 'house' else f'.dz-{role} .dz-mount iframe'
                return page.locator(sel).element_handle().content_frame().child_frames[0]

            def die(page, role):
                return tile_frame(page, role).evaluate(
                    "(() => { const c = document.getElementById('die3d'); return { kind: document.documentElement.dataset.die, showing: +c.dataset.showing, q: c.dataset.q, moving: !!c.dataset.moving, wilt: !!c.dataset.wilt, value: document.getElementById('value').textContent }; })()")

            def settled(page, role, timeout=8):
                end = time.time() + timeout
                d = die(page, role)
                while time.time() < end:
                    d = die(page, role)
                    if not d['moving'] and 'Rolling' not in d['value']:
                        return d
                    time.sleep(0.1)
                return d

            def ready(page):
                page.wait_for_function("() => window.__daisy && ['house','mine','theirs'].every(r => __daisy.frames.status(r) === 'ready')", timeout=20000)

            def shared(page):
                return page.evaluate("JSON.stringify(window.__daisy.snapshot && window.__daisy.snapshot.shared)")

            def phase(page):
                return page.evaluate("window.__daisy.phase")

            def shot(page, name):
                if SHOTS:
                    os.makedirs(SHOTS, exist_ok=True)
                    page.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=True)

            def open_table(page, handle, extra='', url=None):
                page.goto((url or base) + extra)
                page.fill('.dz-handle', handle)
                page.click('.dz-open')
                page.locator('.dz-invite:not([hidden])').wait_for(timeout=10000)
                return page.input_value('.dz-link')

            def sit(page, link, handle):
                page.goto(link)
                page.fill('.dz-handle', handle)
                page.click('.dz-sit')

            def pick(page, glaze):
                t = tile(page, 'mine')
                t.locator(f'.glaze[data-id="{glaze}"]:not([disabled])').click(timeout=15000)

            def agree(a, b, wait=8000):
                end = time.time() + wait / 1000
                while time.time() < end:
                    if shared(a) == shared(b) and shared(a) not in ('null', None) and not json.loads(shared(a)).get('pending'):
                        return True
                    a.wait_for_timeout(100)
                return False

            def play(pages, until=lambda: False, bank_at=8, limit=400):
                """Each page's player rolls until the turn is worth bank_at, then banks; stops when the match is over."""
                for _ in range(limit):
                    if all(phase(pg) == 'over' for pg in pages) or until():
                        return True
                    moved = False
                    for pg in pages:
                        t = tile(pg, 'mine')
                        roll, bank = t.locator('#roll'), t.locator('#bank')
                        if roll.is_visible() and roll.is_enabled():
                            total = pg.evaluate("(() => { const s = window.__daisy.snapshot; return s && s.shared.play ? s.shared.play.turnRolls.reduce((a,b)=>a+b,0) : 0 })()")
                            (bank if total >= bank_at and bank.is_enabled() else roll).click(timeout=3000)
                            moved = True
                            pg.wait_for_timeout(250)
                    if not moved:
                        pages[0].wait_for_timeout(150)
                return False

            # ---------------- a whole match on two "computers" ----------------
            print('Two pages, one table:', flush=True)
            ca, a = computer()
            cb, b = computer()
            link = open_table(a, 'pyxorium.com')
            check('opening a table gives a link to send', 'table=' in link and 'loader=' in link, link)
            cid = a.evaluate('window.__fakeAuth.clientId')
            check('signing in on this computer is the loopback kind, with Daisy\'s two permission sets (step 6)',
                  cid.startswith('http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1') and 'scope=atproto%20include%3Acafe.thunderbird.daisy.authPlay%20include%3Acafe.thunderbird.daisy.authLounge%3Faud%3Ddid%3Aweb%3Arelay.daisy.thunderbird.cafe%2523daisy_relay' in cid, cid)
            asked = a.evaluate('window.__fakeAuth.scopesAsked')
            check('…and sitting asks only for "Play Daisy" (authPlay)', asked == ['atproto include:cafe.thunderbird.daisy.authPlay'], str(asked))
            check('you sign in before you sit (one small window), and the page says who you are',
                  a.evaluate('window.__fakeAuth.signIns') == ['pyxorium.com'] and 'Signed in as @pyxorium.com' in a.inner_text('.dz-account'))
            check('the opener waits for the other player', 'Waiting for the other player' in a.inner_text('.dz-status'))
            ready(a)
            talk = [tile_frame(a, r).evaluate('document.documentElement.dataset.talk') for r in ('house', 'mine', 'theirs')]
            check('all three tiles talk through the loader\'s data.js', talk == ['data.js'] * 3, str(talk))
            sit(b, link, 'thunderbirdwine.bsky.social')
            ready(b)
            a.wait_for_function("() => document.querySelector('.dz-status').textContent.includes('Playing with @thunderbirdwine')", timeout=10000)
            check('both pages see each other', 'Playing with @pyxorium.com' in b.inner_text('.dz-status'))
            check('the relay seats the opener at 1 and the guest at 2', a.evaluate('__daisy.me.seat') == 1 and b.evaluate('__daisy.me.seat') == 2)
            shot(a, 's01-picking-a')
            pick(a, 'jade')
            tile(b, 'mine').locator('.glaze[data-id="jade"][disabled]').wait_for(timeout=8000)
            check('a glaze taken on one page greys out on the other', True)
            check('the watching copy on page B shows A\'s choice', 'chose Jade' in tile(b, 'theirs').locator('#pick-title').inner_text())
            pick(b, 'marigold')
            a.wait_for_function("() => window.__daisy.phase === 'playing'", timeout=10000)
            b.wait_for_function("() => window.__daisy.phase === 'playing'", timeout=10000)
            check('the coin is flipped from both pages\' links and both agree who starts', agree(a, b))
            first = json.loads(shared(a))['coin']['first']
            starter = a if first == 1 else b
            tile(starter, 'mine').locator('#roll:not([disabled])').wait_for(timeout=8000)
            other_page = b if starter is a else a
            check('only the player whose turn it is gets Roll and Bank', not tile(other_page, 'mine').locator('#roll').is_visible())
            check('Bank waits for the first roll of the turn', not tile(starter, 'mine').locator('#bank').is_enabled())
            tile(starter, 'mine').locator('#roll').click()
            starter.wait_for_function("() => window.__daisy.snapshot.shared.history.length >= 1", timeout=8000)
            other_page.wait_for_function("() => window.__daisy.snapshot.shared.history.length >= 1", timeout=8000)
            v = json.loads(shared(a))['history'][0]['value']
            seen = ''
            for _ in range(50):                                   # the 3D die tumbles, then lands (about 1.3 s)
                seen = tile(other_page, 'theirs').locator('#value').inner_text()
                if 'Rolling' not in seen and seen.strip():
                    break
                time.sleep(0.1)
            check('the roll shows on the other page\'s watching copy', (str(v) in seen) or ('turn is lost' in seen and v == 1), seen)
            shot(a, 's02-playing-a')
            shot(b, 's02-playing-b')

            # ---------------- step 3: the 3D die ----------------
            kinds = [die(pg, r)['kind'] for pg in (a, b) for r in ('mine', 'theirs')]
            check('every player tile draws the 3D die (WebGL)', kinds == ['webgl'] * 4, str(kinds))
            dm, dt = settled(starter, 'mine'), settled(other_page, 'theirs')
            check('the roller\'s die and the other page\'s watching copy land on the face the houses agreed on',
                  dm['showing'] == v and dt['showing'] == v, f"value {v}, mine {dm['showing']}, theirs {dt['showing']}")
            # The shared view: the roller turns their die; the other page's watching copy follows.
            box = tile(starter, 'mine').locator('#die3d').bounding_box()
            cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
            before = die(other_page, 'theirs')['q']
            starter.mouse.move(cx, cy); starter.mouse.down()
            starter.mouse.move(cx + 70, cy + 25, steps=10); starter.mouse.up()
            starter.mouse.wheel(0, 200)
            time.sleep(1.2)
            mine_q, theirs = die(starter, 'mine')['q'], die(other_page, 'theirs')
            close = all(abs(float(x) - float(y)) < 0.02 for x, y in zip(mine_q.split(','), theirs['q'].split(',')))
            check('turning your die shows on the other page (the shared view)', mine_q != before and close, f'{before} → {mine_q} vs {theirs["q"]}')
            check('…with a hint that the other player is turning their die',
                  tile(other_page, 'theirs').locator('#turning').is_visible() or 'turning' in tile(other_page, 'theirs').locator('#turning').inner_text())
            before_theirs = die(starter, 'theirs')['q']
            box2 = tile(starter, 'theirs').locator('#die3d').bounding_box()
            starter.mouse.move(box2['x'] + 80, box2['y'] + 80); starter.mouse.down()
            starter.mouse.move(box2['x'] + 150, box2['y'] + 120, steps=8); starter.mouse.up()
            time.sleep(0.4)
            check('the watching copy can\'t be turned (only the die\'s owner turns it)', die(starter, 'theirs')['q'] == before_theirs)
            shot(starter, 's03-turned-mine')
            shot(other_page, 's03-turned-theirs')

            # ---------------- a reload mid-match ----------------
            play([a, b], until=lambda: len(json.loads(shared(a))['history']) >= 6 or phase(a) == 'over')
            if phase(a) != 'over':
                match = json.loads(shared(a))['matchId']
                b.reload()
                ready(b)
                b.wait_for_function("() => window.__daisy.me && window.__daisy.me.seat === 2", timeout=10000)
                check('after a reload the page goes straight back to its seat (this tab\'s account)', 'Back' in b.inner_text('.dz-status') or 'Playing with' in b.inner_text('.dz-status'))
                b.wait_for_function(f"() => window.__daisy.snapshot && window.__daisy.snapshot.shared.matchId === {json.dumps(match)}", timeout=10000)
                check('…the house picks up the same match from this browser, seed and all', agree(a, b))

            # ---------------- the relay restarts ----------------
            if phase(a) != 'over':
                relay.kill(); relay.wait()
                a.wait_for_function("() => document.querySelector('.dz-status').textContent.includes('Reconnecting')", timeout=8000)
                check('a page notices the relay went away', True)
                relay_new = start_relay()
                time.sleep(0.5)
                a.wait_for_function("() => document.querySelector('.dz-status').textContent.includes('Playing with')", timeout=15000)
                b.wait_for_function("() => document.querySelector('.dz-status').textContent.includes('Playing with')", timeout=15000)
                check('both pages come back to their seats after a relay restart', True)
                relay = relay_new
            # A dropped connection mid-roll: the houses ask each other for what they missed.
            play([a, b], until=lambda: phase(a) == 'over')
            check('the match plays to the end', phase(a) == 'over' and phase(b) == 'over')
            check('both houses end with the same table', agree(a, b))
            ra, rb = a.evaluate('JSON.stringify(window.__daisy.result)'), b.evaluate('JSON.stringify(window.__daisy.result)')
            check('both pages hold the same result', ra == rb and ra != 'null')
            with open(os.path.join(out, 'result.json'), 'w') as f:
                f.write(ra)
            verdict = subprocess.run(['node', '-e', f"import('{ROOT}/shared/verify.js').then(m => {{ const r = m.verifyMatch(JSON.parse(require('fs').readFileSync('{out}/result.json','utf8'))); console.log(JSON.stringify(r)); }})"],
                                     capture_output=True, text=True)
            check('the result checks out from the record alone (verifyMatch)', '"ok":true' in verdict.stdout, verdict.stdout + verdict.stderr)
            tile(a, 'mine').locator('#end:not([hidden])').wait_for(timeout=5000)
            title = tile(a, 'mine').locator('#end-title').inner_text()
            check('the end screen names the winner', ('You win' in title) or ('@thunderbirdwine' in title), title)
            check('a finished match shows "Back to the lounge" under the table, and "Back to the start" by the account line',
                  a.is_visible('.dz-after-lounge') and a.is_visible('.dz-home'))
            shot(a, 's03-over-a')

            # ---------------- step 4: saving ----------------
            print('Saving:', flush=True)
            res = json.loads(ra)
            check('only your own tile offers Save (the watching copy doesn\'t)',
                  tile(a, 'mine').locator('#save').is_visible() and not tile(a, 'theirs').locator('#save').is_visible())
            tile(a, 'mine').locator('#save').click()
            a.locator('.dz-dialog:not([hidden])').wait_for(timeout=5000)
            a.click('.dz-dialog-details summary')
            shown = json.loads(a.inner_text('.dz-dialog-record'))
            check('Save opens the page\'s own prompt, naming the account and the other player',
                  'Save this match to @pyxorium.com?' in a.inner_text('#dz-dialog-title') and '@thunderbirdwine.bsky.social' in a.inner_text('.dz-dialog-text'))
            check('…and shows the exact record: seat 1, keyed by the match id (no house address for the memory tiles)',
                  shown['seat'] == 1 and shown['matchId'] == res['matchId'] and 'house' not in shown and shown['$type'] == 'cafe.thunderbird.daisy.match')
            check('your tile says to answer on the page', 'Answer on the page' in tile(a, 'mine').locator('#save-status').inner_text())
            shot(a, 's07-save-dialog')
            a.click('.dz-dialog-yes')
            a.wait_for_function("() => document.querySelector('.dz-dialog-status').textContent.includes('Saved')", timeout=5000)
            put = a.evaluate('window.__fakeAuth.saved')[-1]
            check('saving writes one record to your own repo, keyed by the match id',
                  put['repo'] == DIDS['pyxorium.com'] and put['collection'] == 'cafe.thunderbird.daisy.match' and put['rkey'] == res['matchId'] and put['record'] == shown, json.dumps(put)[:200])
            with open(os.path.join(out, 'saved.json'), 'w') as f:
                json.dump(put['record'], f)
            verdict = subprocess.run(['node', '--input-type=module', '-e', f"import('{ROOT}/page/record.js').then(m => console.log(JSON.stringify(m.checkRecord(JSON.parse(require('fs').readFileSync('{out}/saved.json','utf8'))))))".replace("require('fs')", "process.getBuiltinModule('fs')")],
                                     capture_output=True, text=True)
            check('the saved record passes the record check, dice and all', verdict.stdout.strip() == 'null', verdict.stdout + verdict.stderr)
            check('…and the link goes to the record', 'pdsls.dev/at://' in a.inner_html('.dz-dialog-status'))
            a.click('.dz-dialog-no')
            tile(a, 'mine').locator('#save[disabled]').wait_for(timeout=5000)
            check('your tile then says where it was saved', 'Saved to @pyxorium.com' in tile(a, 'mine').locator('#save-status').inner_text())
            # The other player: Not now, then signed out, then saving asks to sign in again.
            tile(b, 'mine').locator('#save').click()
            b.locator('.dz-dialog:not([hidden])').wait_for(timeout=5000)
            b.click('.dz-dialog-no')
            b.wait_for_timeout(300)
            check('Not now writes nothing and the tile offers Save again',
                  'Save it to your account' in tile(b, 'mine').locator('#save-status').inner_text() and len(b.evaluate('window.__fakeAuth.saved')) == 0)
            b.click('.dz-signout')
            b.wait_for_function("() => document.querySelector('.dz-account').textContent.includes('signed out')", timeout=5000)
            check('Sign out keeps the seat and the game; the page says saving needs signing in again', not b.locator('.dz-table').is_hidden())
            tile(b, 'mine').locator('#save').click()
            b.locator('.dz-dialog:not([hidden])').wait_for(timeout=5000)
            check('…and the prompt offers Sign in and save', b.inner_text('.dz-dialog-yes') == 'Sign in and save')
            b.click('.dz-dialog-yes')
            b.wait_for_function("() => document.querySelector('.dz-dialog-status').textContent.includes('Saved')", timeout=8000)
            put_b = b.evaluate('window.__fakeAuth.saved')[-1]
            check('after signing in again, the other player saves their own copy (seat 2, same match id)',
                  put_b['repo'] == DIDS['thunderbirdwine.bsky.social'] and put_b['record']['seat'] == 2 and put_b['rkey'] == res['matchId'])
            b.click('.dz-dialog-no')

            # Rematch: same glazes, a new match.
            old = json.loads(shared(a))['matchId']
            tile(a, 'mine').locator('#rematch').click()
            tile(b, 'mine').locator('#rematch-note').wait_for(timeout=5000)
            b.wait_for_function("() => window.__daisy.snapshot.shared.rematch.length === 1", timeout=8000)
            check('the other page hears the rematch request', 'asks for a rematch' in tile(b, 'mine').locator('#rematch-note').inner_text())
            tile(b, 'mine').locator('#rematch').click()
            a.wait_for_function(f"() => window.__daisy.phase === 'playing' && window.__daisy.snapshot.shared.matchId !== {json.dumps(old)}", timeout=10000)
            check('rematch: a new match with the same glazes', json.loads(shared(a))['glazes'] == ['jade', 'marigold'] and agree(a, b))

            # The wilt: roll (never bank) until somebody throws a 1.
            wilted = None
            for _ in range(200):
                hist = json.loads(shared(a))['history']
                ones = [h for h in hist if h['type'] == 'roll' and h['value'] == 1]
                if ones:
                    wilted = ones[-1]['seat']
                    break
                if phase(a) == 'over':
                    tile(a, 'mine').locator('#rematch').click(); tile(b, 'mine').locator('#rematch').click(timeout=8000)
                    a.wait_for_function("() => window.__daisy.phase === 'playing'", timeout=10000)
                    continue
                for pg in (a, b):
                    r = tile(pg, 'mine').locator('#roll')
                    if r.is_visible() and r.is_enabled():
                        r.click(timeout=3000)
                        pg.wait_for_timeout(300)
                a.wait_for_timeout(100)
            if wilted:
                owner = a if wilted == 1 else b
                watcher = b if owner is a else a
                time.sleep(2.0)
                dw, dtw = die(owner, 'mine'), die(watcher, 'theirs')
                check('a 1 wilts the die, on both pages (and the 1 is a daisy)', dw['wilt'] and dtw['wilt'] and dw['showing'] == 1 and dtw['showing'] == 1, f'{dw} {dtw}')
                shot(owner, 's04-wilt')
            else:
                check('a 1 wilts the die, on both pages (and the 1 is a daisy)', False, 'no 1 was rolled')

            # ---------------- a third visitor ----------------
            cc, c = computer()
            sit(c, link, 'colorado.atprotocol.space')
            c.wait_for_function("() => document.querySelector('.dz-status').textContent.includes('full')", timeout=10000)
            check('a third visitor hears the table is full', c.locator('.dz-table').is_hidden())
            cc.close()

            # A browser without this seat's kept state can't take a seat in play ("held"), and the seat stays put.
            cd, d = computer()
            sit(d, link, 'thunderbirdwine.bsky.social')
            d.wait_for_function("() => document.querySelector('.dz-status').textContent.includes('another browser')", timeout=10000)
            time.sleep(0.5)
            check('a browser without the seat\'s saved game hears the seat is held, and the original keeps playing',
                  d.locator('.dz-table').is_hidden() and 'stepped away' not in b.inner_text('.dz-status') and not b.locator('.dz-table').is_hidden())
            cd.close()

            # ---------------- step 4: signing in as someone else; the house version check ----------------
            print('Sign-in and the house version check:', flush=True)
            ce, e = computer()
            e.goto(base)
            e.wait_for_function('() => window.__fakeAuth && window.__daisy', timeout=10000)
            e.evaluate(f"window.__fakeAuth.signInAs['pyxorium.com'] = {json.dumps(DIDS['colorado.atprotocol.space'])}")
            e.fill('.dz-handle', 'pyxorium.com')
            e.click('.dz-open')
            e.wait_for_function("() => document.querySelector('.dz-lobby-note').textContent.includes('different account')", timeout=8000)
            check('a sign-in for a different account than the typed handle doesn\'t sit', e.locator('.dz-table').is_hidden() and e.locator('.dz-invite').is_hidden())
            e.evaluate("document.querySelector('.dz-handle').value = 'nothandle'")
            e.click('.dz-open')
            check('a handle that isn\'t one is refused before any window opens', 'Type your handle' in e.inner_text('.dz-lobby-note'))
            e.fill('.dz-handle', '')
            e.click('.dz-handle')
            e.keyboard.type('thunder', delay=40)
            e.locator('.dz-ta-list:not([hidden]) .dz-ta-item').first.wait_for(timeout=5000)
            shot(e, 's00-lobby-suggestions')
            e.keyboard.press('ArrowDown'); e.keyboard.press('Enter')
            check('handle suggestions appear as you type, and choosing one fills the box', e.input_value('.dz-handle') == 'thunderbirdwine.bsky.social')
            ce.close()
            # Signed in on this browser before: carrying on needs no window.
            ce, e = computer()
            open_table(e, 'pyxorium.com')
            e.goto(base)
            e.wait_for_function('() => window.__daisy', timeout=10000)
            check('the handle box remembers the last account signed in here', e.input_value('.dz-handle') == 'pyxorium.com')
            e.click('.dz-open')
            e.locator('.dz-invite:not([hidden])').wait_for(timeout=10000)
            check('…and carrying on as that account opens no window', e.evaluate('window.__fakeAuth.signIns') == [])
            ce.close()
            # A page with another version of the house: the table doesn't start, and both pages say why.
            ce, e = computer()
            cf, f2 = computer()
            link2 = open_table(e, 'pyxorium.com')
            sit(f2, link2.replace('/index.html', '/other.html'), 'thunderbirdwine.bsky.social')
            e.wait_for_function("() => document.querySelector('.dz-status').textContent.includes('different version')", timeout=10000)
            f2.wait_for_function("() => document.querySelector('.dz-status').textContent.includes('different version')", timeout=10000)
            time.sleep(2.5)
            check('pages running different houses both say so, and the table doesn\'t start (no tiles to play on)',
                  e.evaluate("window.__daisy.mismatch") and f2.evaluate("window.__daisy.mismatch") and phase(e) in (None, 'seating', 'picking')
                  and e.locator('.dz-table').is_hidden() and f2.locator('.dz-table').is_hidden()
                  and e.evaluate("!window.__daisy.snapshot || !window.__daisy.snapshot.shared.commitments || window.__daisy.snapshot.shared.commitments.filter(Boolean).length < 2"))
            shot(f2, 's08-other-version')
            ce.close(); cf.close()

            # ---------------- phone width ----------------
            b.set_viewport_size({'width': 390, 'height': 900})
            b.wait_for_timeout(300)
            boxes = b.evaluate("['.dz-mine','.dz-theirs'].map(s => document.querySelector(s).getBoundingClientRect().top)")
            overflow = b.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
            check('on a phone the tiles stack, yours at the bottom, with no sideways scroll', boxes[0] > boxes[1] and not overflow, f'{boxes} {overflow}')
            b.wait_for_timeout(1000)
            check('…and both tiles still draw there', tile(b, 'mine').locator('#handle').is_visible() and tile(b, 'theirs').locator('#handle').is_visible())
            if SHOTS:
                b.screenshot(path=os.path.join(SHOTS, 's04-phone-b.png'))
                b.mouse.wheel(0, 700); b.wait_for_timeout(500)
                b.screenshot(path=os.path.join(SHOTS, 's04-phone-b-lower.png'))
            ca.close(); cb.close()

            # ---------------- short timers: away forfeits ----------------
            print('Short timers:', flush=True)
            ca, a = computer()
            cb, b = computer()
            link = open_table(a, 'pyxorium.com', '&timers=short')
            check('the short timers travel with the link', 'timers=short' in link)
            sit(b, link, 'thunderbirdwine.bsky.social')
            ready(a); ready(b)
            pick(a, 'bone'); pick(b, 'glow')
            a.wait_for_function("() => window.__daisy.phase === 'playing'", timeout=10000)
            check('both pages agree on the short timers', json.loads(shared(a))['timerSet'] == 'short' and agree(a, b))
            cb.close()
            a.wait_for_function("() => document.querySelector('.dz-status').textContent.includes('lost connection')", timeout=8000)
            check('the other page going away shows a countdown', 'Waiting…' in a.inner_text('.dz-status'))
            shot(a, 's05-away-a')
            a.wait_for_function("() => window.__daisy.phase === 'over'", timeout=30000)
            r = a.evaluate('window.__daisy.result')
            check('after 20 s away, the match goes to the player still here (short timers)', r['ending'] == 'forfeit' and r['forfeitReason'] == 'away' and r['winner'] == 1, str(r))
            tile(a, 'mine').locator('#end:not([hidden])').wait_for(timeout=5000)
            check('the end screen says why', 'away too long' in tile(a, 'mine').locator('#end-note').inner_text())
            ca.close()

            # The turn timer: the player whose turn it is does nothing.
            ca, a = computer()
            cb, b = computer()
            link = open_table(a, 'pyxorium.com', '&timers=short')
            sit(b, link, 'thunderbirdwine.bsky.social')
            ready(a); ready(b)
            pick(a, 'brick'); pick(b, 'midnight')
            a.wait_for_function("() => window.__daisy.phase === 'playing'", timeout=10000)
            first = json.loads(shared(a))['coin']['first']
            idle = a if first == 1 else b
            tile(idle, 'mine').locator('#nudge:not([hidden])').wait_for(timeout=15000)
            check('after 10 s the turn timer nudges (short timers)', 'within' in tile(idle, 'mine').locator('#nudge').inner_text())
            shot(idle, 's06-nudge')
            a.wait_for_function("() => window.__daisy.phase === 'over'", timeout=30000)
            b.wait_for_function("() => window.__daisy.phase === 'over'", timeout=10000)
            r = a.evaluate('window.__daisy.result')
            check('after 30 s the waiting page claims the turn timeout, and both agree', r['forfeitReason'] == 'turn-timeout' and r['winner'] == (2 if first == 1 else 1) and agree(a, b), str(r))
            ca.close(); cb.close()

            # Different timers on the two pages: the table doesn't start.
            ca, a = computer()
            cb, b = computer()
            link = open_table(a, 'pyxorium.com', '&timers=short')
            sit(b, link.replace('&timers=short', '').replace('timers=short&', ''), 'thunderbirdwine.bsky.social')
            b.wait_for_function("() => document.querySelector('.dz-status').textContent.includes('different timers')", timeout=15000)
            check('pages with different timers are told, and the table doesn\'t start', True)
            ca.close(); cb.close()

            # ---------------- step 4: the published tiles, pinned ----------------
            print('The published tiles, pinned:', flush=True)
            pub_url = base.replace('/index.html', '/pub.html')
            ca, a = computer()
            cb, b = computer()
            link = open_table(a, 'pyxorium.com', url=pub_url)
            sit(b, link, 'thunderbirdwine.bsky.social')
            ready(a); ready(b)
            check('the page plays the published tiles', a.get_attribute('#daisy', 'data-tiles') == 'published')
            check('…read from the account\'s server: both records and their files', PDS['served']['records'] >= 2 and PDS['served']['blobs'] >= 10, str(PDS['served']))
            talk = [tile_frame(a, r).evaluate('document.documentElement.dataset.talk') for r in ('house', 'mine', 'theirs')]
            check('all three published tiles talk through data.js', talk == ['data.js'] * 3, str(talk))
            check('both pages name the same house (its record CID) and the table starts', a.evaluate('window.__daisy.myHouse') == pinned['house']['cid'] and not a.evaluate('window.__daisy.mismatch'))
            time.sleep(2)
            alone_on_page = [tile_frame(pg, r).evaluate("document.documentElement.dataset.alone || ''") for pg in (a, b) for r in ('house', 'mine', 'theirs')]
            check('on the Daisy page no tile shows its card picture (the page sets each one up)', alone_on_page == [''] * 6, str(alone_on_page))
            pick(a, 'jade'); pick(b, 'midnight')
            a.wait_for_function("() => window.__daisy.phase === 'playing'", timeout=10000)
            play([a, b], until=lambda: phase(a) == 'over', bank_at=12)
            check('a whole match on the published tiles', phase(a) == 'over' and agree(a, b))
            tile(a, 'mine').locator('#save').click()
            a.locator('.dz-dialog:not([hidden])').wait_for(timeout=5000)
            a.click('.dz-dialog-yes')
            a.wait_for_function("() => document.querySelector('.dz-dialog-status').textContent.includes('Saved')", timeout=5000)
            rec = a.evaluate('window.__fakeAuth.saved')[-1]['record']
            check('the saved record names the house tile that refereed (address and record CID)', rec.get('house') == pinned['house'], str(rec.get('house')))
            shot(a, 's09-published-saved')
            a.click('.dz-dialog-no')
            csp_errors = [x for x in errors if 'Content Security Policy' in x or 'Refused to' in x]
            check('the page\'s security policy blocks nothing it needs', not csp_errors, '; '.join(csp_errors[:3]))
            PDS['tamper'] = 'player'
            ca.close(); cb.close()
            PDS['tamper'] = None
            # On their own, as in a tile gallery: each tile shows its card picture after a moment.
            cz, z = computer()
            z.goto(base.split('/index.html')[0] + '/alone.html')
            z.wait_for_function("() => window.__aloneReady === true", timeout=20000)
            got = {}
            for which in ('house', 'player'):
                end = time.time() + 15                     # the tile loads, finds no Daisy page, waits 1.5 s
                fr = None
                while time.time() < end:
                    kids = z.locator(f'#{which}').element_handle().content_frame().child_frames
                    fr = kids[0] if kids else None
                    if fr and fr.evaluate("document.documentElement.dataset.alone || ''"):
                        break
                    time.sleep(0.25)
                time.sleep(0.5)
                got[which] = fr.evaluate("(() => { const i = document.getElementById('card-pic'); return { alone: document.documentElement.dataset.alone || '', shown: !document.getElementById('card').hidden, w: i.naturalWidth, cap: document.querySelector('#card figcaption').textContent }; })()")
            check('on its own (as in a tile gallery) the house shows its card picture and the line',
                  got['house']['alone'] == '1' and got['house']['shown'] and got['house']['w'] == 1280 and 'referee' in got['house']['cap'], str(got['house']))
            check('…and so does the player tile', got['player']['alone'] == '1' and got['player']['shown'] and got['player']['w'] == 1280 and 'thunderbird.cafe/webtiles/daisy/' in got['player']['cap'], str(got['player']))
            if SHOTS:
                os.makedirs(SHOTS, exist_ok=True)
                z.screenshot(path=os.path.join(SHOTS, 's10-alone.png'))
            cz.close()
            PDS['tamper'] = 'player'
            ca, a = computer()
            cb, b = computer()
            link = open_table(a, 'pyxorium.com', url=pub_url)
            a.locator('.dz-mine .dz-tile-status:not([hidden]) p').wait_for(timeout=15000)
            a.wait_for_function("() => document.querySelector('.dz-mine .dz-tile-status p').textContent.includes('changed')", timeout=15000)
            check('a tile whose record changed since it was pinned is refused', 'changed since the table was set up' in a.inner_text('.dz-mine .dz-tile-status'))
            PDS['tamper'] = None
            ca.close(); cb.close()

            # No WebGL on one computer: that page plays with the flat die, the other with the 3D die.
            print('Without WebGL:', flush=True)
            ca, a = computer()
            cb = browser.new_context(viewport={'width': 1120, 'height': 1000})
            cb.route('https://public.api.bsky.app/**', lookups)
            cb.route('https://typeahead.waow.tech/**', suggestions)
            cb.add_init_script("HTMLCanvasElement.prototype.getContext = ((orig) => function (t, o) { return /webgl/.test(t) ? null : orig.call(this, t, o); })(HTMLCanvasElement.prototype.getContext);")
            b = cb.new_page()
            b.on('pageerror', lambda e: errors.append(str(e)))
            link = open_table(a, 'pyxorium.com')
            sit(b, link, 'thunderbirdwine.bsky.social')
            ready(a); ready(b)
            pick(a, 'glow'); pick(b, 'brick')
            a.wait_for_function("() => window.__daisy.phase === 'playing'", timeout=10000)
            kinds = (die(a, 'mine')['kind'], die(b, 'mine')['kind'])
            check('without WebGL the page falls back to the flat die; the other page keeps the 3D one', kinds == ('webgl', 'flat'), str(kinds))
            play([a, b], until=lambda: len(json.loads(shared(a))['history']) >= 6 or phase(a) == 'over')
            check('…and the two still play the same game', agree(a, b))
            shot(b, 's05-flat-b'); shot(a, 's05-glow-a')
            ca.close(); cb.close()

            # ---------------- step 6: the lounge ----------------
            if os.path.exists(os.path.join(RELAY_DIR, 'test', 'lounge-standin.mjs')):
                print('The lounge (step 6):', flush=True)
                PA, PB, PC = DIDS['pyxorium.com'], DIDS['thunderbirdwine.bsky.social'], DIDS['colorado.atprotocol.space']
                lounge_relay = start_lounge_relay(blocks=f'{PA}>{PC}')                   # pyxorium.com blocks colorado
                time.sleep(1.2)
                lurl = base + f'&relay=ws://127.0.0.1:{LOUNGE_PORT}/&timers=short'
                try:
                    def mingle(page, handle):
                        page.goto(lurl)
                        page.fill('.dz-handle', handle)
                        page.click('.dz-switch')
                        page.locator('.dz-ldialog:not([hidden])').wait_for(timeout=5000)
                        page.click('.dz-ldialog-yes')
                        page.wait_for_function("() => document.getElementById('daisy').dataset.lounge === 'here'", timeout=10000)

                    def who(page):
                        page.click('.dz-who-ask')
                        page.wait_for_function("() => !/Looking/.test(document.querySelector('.dz-who-note').textContent)", timeout=5000)
                        page.wait_for_timeout(300)
                        return page.evaluate("[...document.querySelectorAll('.dz-person .dz-person-handle')].map(e => e.textContent)")

                    ca, la = computer(); cb, lb = computer(); cc, lc = computer()
                    la.goto(lurl)
                    la.locator('.dz-lounge').wait_for(timeout=5000)
                    check('the lounge panel sits under "Open a table", mingling off',
                          la.is_visible('.dz-lounge') and la.get_attribute('.dz-switch', 'aria-checked') == 'false' and 'Off.' in la.inner_text('.dz-lounge-note'))
                    la.fill('.dz-handle', 'pyxorium.com')
                    la.click('.dz-switch')
                    la.locator('.dz-ldialog:not([hidden])').wait_for(timeout=5000)
                    text = la.inner_text('.dz-ldialog')
                    check('turning it on shows our explanation first (before any sign-in window)',
                          'Turn on mingling?' in text and 'it only says that you\'ve chosen to mingle, not whether you\'re here or signed in' in text
                          and la.evaluate('window.__fakeAuth.signIns.length') == 0)
                    la.click('.dz-ldialog-no')
                    check('…"Not now" closes it and leaves mingling off', la.is_hidden('.dz-ldialog') and la.get_attribute('.dz-switch', 'aria-checked') == 'false')
                    mingle(la, 'pyxorium.com')
                    asked = la.evaluate('window.__fakeAuth.scopesAsked')
                    check('Continue: one sign-in asking for "Daisy lounge" (with "Play Daisy"), the lounge record written, in the lounge',
                          asked == ['atproto include:cafe.thunderbird.daisy.authPlay include:cafe.thunderbird.daisy.authLounge?aud=did:web:relay.daisy.thunderbird.cafe%23daisy_relay']
                          and PA in LOUNGE and la.get_attribute('.dz-switch', 'aria-checked') == 'true', f'{asked} {LOUNGE}')
                    check('…the relay accepted its pass: "Mingling … (as @pyxorium.com)"', 'as @pyxorium.com' in la.inner_text('.dz-lounge-note'))
                    got = who(la)
                    check('alone: "Nobody else is mingling here right now"', got == [] and 'Nobody else' in la.inner_text('.dz-who-note'), str(got))
                    mingle(lb, 'thunderbirdwine.bsky.social')
                    mingle(lc, 'colorado.atprotocol.space')
                    la.wait_for_timeout(400)
                    got_a, got_c, got_b = who(la), who(lc), who(lb)
                    check('who else: pyxorium.com sees thunderbirdwine only (colorado is blocked)', got_a == ['@thunderbirdwine.bsky.social'], str(got_a))
                    check('…and the block works both ways: colorado sees thunderbirdwine only', got_c == ['@thunderbirdwine.bsky.social'], str(got_c))
                    check('…thunderbirdwine sees both (blocks are only between the two)', sorted(got_b) == ['@colorado.atprotocol.space', '@pyxorium.com'], str(got_b))
                    check('…with the time of the snapshot', 'press again to refresh' in la.inner_text('.dz-who-time'))
                    # An invitation, Not now, and "No answer" (4 s with short timers).
                    la.click('.dz-person:has-text("thunderbirdwine") button')
                    check('Invite → "Invite sent"', 'Invite sent' in la.inner_text('.dz-person:has-text("thunderbirdwine")'))
                    lb.locator('.dz-knock:not([hidden])').wait_for(timeout=5000)
                    check('the invitation card: "@pyxorium.com invites you to a game of Daisy."', lb.inner_text('#dz-knock-text') == '@pyxorium.com invites you to a game of Daisy.', lb.inner_text('#dz-knock-text'))
                    lb.click('.dz-knock-no')
                    check('Not now closes the card', lb.is_hidden('.dz-knock'))
                    la.wait_for_function("() => /No answer/.test(document.querySelector('.dz-person').textContent)", timeout=8000)
                    check('…and the inviter only ever sees "No answer"', True)
                    # A blocked invitation goes nowhere; the inviter can't tell.
                    lc.click('.dz-person:has-text("thunderbirdwine") button')
                    lb.locator('.dz-knock:not([hidden])').wait_for(timeout=5000)
                    lb.click('.dz-knock-no')
                    lc_list = lc.evaluate("[...document.querySelectorAll('.dz-person-handle')].map(e => e.textContent)")
                    check('colorado can\'t even list pyxorium.com to invite (blocked)', '@pyxorium.com' not in lc_list, str(lc_list))
                    # Reload while mingling: back in the lounge by itself.
                    lc.reload()
                    lc.wait_for_function("() => document.getElementById('daisy').dataset.lounge === 'here'", timeout=10000)
                    check('a reload while mingling joins the lounge again by itself (no window)', lc.evaluate('window.__fakeAuth.signIns.length') == 0)
                    # Mingling off: the record is deleted.
                    lc.click('.dz-switch')
                    lc.wait_for_function("() => document.getElementById('daisy').dataset.lounge === 'off'", timeout=8000)
                    check('turning mingling off deletes the lounge record', PC not in LOUNGE and lc.get_attribute('.dz-switch', 'aria-checked') == 'false', str(LOUNGE))
                    # Invite again and Play: both pages go to one new table, inviter at seat 1.
                    la.wait_for_function("() => /Invite/.test(document.querySelector('.dz-person').textContent)", timeout=10000)
                    who(la)
                    la.click('.dz-person:has-text("thunderbirdwine") button')
                    lb.locator('.dz-knock:not([hidden])').wait_for(timeout=5000)
                    lb.click('.dz-knock-play')
                    la.wait_for_function("() => window.__daisy.me && window.__daisy.me.seat === 1", timeout=10000)
                    lb.wait_for_function("() => window.__daisy.me && window.__daisy.me.seat === 2", timeout=10000)
                    ta = urllib.parse.parse_qs(urllib.parse.urlparse(la.url).query).get('table')
                    tb = urllib.parse.parse_qs(urllib.parse.urlparse(lb.url).query).get('table')
                    check('Play: both pages go to the same new table, the inviter at seat 1, the other at seat 2', ta and ta == tb, f'{ta} {tb}')
                    check('…the lounge panel and the link to send are gone; "Waiting…" is not asking for a link',
                          la.is_hidden('.dz-lounge') and la.is_hidden('.dz-invite') and lb.is_hidden('.dz-lounge'))
                    ready(la); ready(lb)
                    la.wait_for_function("() => window.__daisy.phase === 'picking'", timeout=15000)
                    pick(la, 'bone'); pick(lb, 'jade')
                    la.wait_for_function("() => window.__daisy.phase === 'playing'", timeout=15000)
                    check('…and the two play: glazes and the coin, through the real relay', agree(la, lb))
                    # Back to the start during a match: asked first; Stay stays; Leave goes to the start screen and the lounge.
                    la.click('.dz-home')
                    check('"Back to the start" mid-match asks first ("Leave this match? … within 2 minutes … forfeit")',
                          la.is_visible('.dz-leave') and 'within 2 minutes' in la.inner_text('.dz-leave'))
                    la.click('.dz-leave-no')
                    check('…Stay keeps the table', la.is_hidden('.dz-leave') and 'table=' in la.url)
                    la.click('.dz-home')
                    la.click('.dz-leave-yes')
                    la.wait_for_function("() => document.getElementById('daisy') && document.getElementById('daisy').dataset.lounge === 'here'", timeout=15000)
                    check('…Leave: the start screen (no table in the address, the relay and timers kept) and back in the lounge by itself',
                          'table=' not in la.url and 'relay=' in la.url and la.is_visible('.dz-lounge'), la.url)
                    ca.close(); cb.close(); cc.close()
                finally:
                    lounge_relay.terminate()
            else:
                print('  (the lounge checks need C:\\thunderbird-cafe\\daisy-relay beside this folder: skipped)')

            # The six glazes, faces 1 to 6 (a sheet drawn with die3d.js itself).
            sheet = browser.new_page(viewport={'width': 760, 'height': 520})
            sheet.goto(f'http://127.0.0.1:{srv.server_address[1]}/glazes.html')
            sheet.wait_for_function("() => window.__sheet && window.__sheet.length === 6", timeout=10000)
            time.sleep(0.8)
            shows = sheet.evaluate("[...document.querySelectorAll('canvas')].map(c => +c.dataset.showing)")
            check('each glaze draws, each face shows its value (sheet)', shows == [1, 2, 3, 4, 5, 6], str(shows))
            if SHOTS:
                sheet.screenshot(path=os.path.join(SHOTS, 's06-glazes.png'))
            sheet.close()

            noise = [e for e in errors if 'form-src' not in e and 'favicon' not in e and 'TileChanged' not in e   # the refused tile above is on purpose
                     and 'collection=cafe.thunderbird.daisy.lounge' not in e]                          # "no lounge record" is a 400 answer
            check('no errors in the console', not noise, '; '.join(noise[:5]))
            browser.close()
    finally:
        replica.terminate()
        try:
            relay.terminate()
        except Exception:
            pass
    print(f'\n{len(passed)} passed, {len(failed)} failed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
