"""Browser checks for Daisy's coin toss (Raku step 5c, Oct 21 2026), in Chromium with Playwright.

Serves this folder and opens test/coin-harness.html: your house, your player tile, the copy watching the
bot's seat and the bot's house, wired with the game's own router (page/router.js), against the bot. Checks:
the toss on both copies (its own canvas over the die's box, the die hidden), Roll locked until the end of
the sequence, the words at the landing, the keepsake by the first player's score (and no "went first"),
the bot's first roll 1.2 s after Roll is free, a tile reloaded mid-toss joining it on the same clock,
reduced motion (a still coin for the same time), no WebGL (the flat coin), no errors.

Usage: python3 test/check_coin.py [--shots DIR]
"""
import functools, http.server, os, socketserver, sys, threading, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = sys.argv[sys.argv.index('--shots') + 1] if '--shots' in sys.argv else None
PORT = 8131
URL = f'http://127.0.0.1:{PORT}/test/coin-harness.html'
passed, failed = [], []


def check(name, cond, detail=''):
    (passed if cond else failed).append(name)
    print(('  ok  ' if cond else '  FAIL ') + name + (f'  ({detail})' if detail and not cond else ''), flush=True)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header('cache-control', 'no-store')
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(('127.0.0.1', PORT), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()


def frame(page, role):
    return page.frame_locator(f'iframe[data-role="{role}"]')


def start(browser, **ctx):
    c = browser.new_context(viewport={'width': 1000, 'height': 700}, **ctx)
    p = c.new_page()
    errs = []
    p.on('pageerror', lambda e: errs.append(str(e)))
    # Expected here: talk.js first tries the tile loader's /.well-known/web-tiles/data.js (404 without a
    # loader), and the harness has no favicon. Those requests are left out; anything else counts.
    p.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    p.on('response', lambda r: errs.append(f'{r.status} {r.url}') if r.status >= 400 and not r.url.endswith(('/.well-known/web-tiles/data.js', '/favicon.ico')) else None)
    p.goto(URL)
    mine = frame(p, 'mine')
    mine.locator('.glaze[data-id="jade"]').click(timeout=15000)
    p.wait_for_function('() => window.__h.flips.length > 0', timeout=15000)
    flip = p.evaluate('window.__h.flips[0]')
    return c, p, errs, flip


def html_data(page, role, key):
    return page.evaluate(f'''() => {{ const f = document.querySelector('iframe[data-role="{role}"]'); return f && f.contentDocument ? f.contentDocument.documentElement.dataset.{key} || null : null; }}''')


def q(page, role, js):
    return page.evaluate(f'''() => {{ const f = document.querySelector('iframe[data-role="{role}"]'); const d = f && f.contentDocument; if (!d) return null; return ({js})(d); }}''')


def now(page):
    return page.evaluate('Date.now()')


TOTAL = 5184   # coin.js coinPlan() with the owner's timings (checked in test/coin.test.mjs)
LANDS = 1800

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'])

    seen_first = set()
    bot_checked = False
    roll_checked = False
    for attempt in range(6):
        c, p, errs, flip = start(browser)
        first, at = flip['first'], flip['at']
        seen_first.add(first)
        if attempt == 0:
            print(f'flip: first={first} seed={flip["seed"]}', flush=True)
            check('the flip carries a seed, the moment and the timings', isinstance(flip.get('seed'), int) and isinstance(at, (int, float)) and flip.get('timings', {}).get('air') == 1500, str(flip))
            p.wait_for_timeout(300)
            for role in ('mine', 'theirs'):
                check(f'{role}: the coin has its own canvas over the die box, the die hidden',
                      q(p, role, "d => !!d.getElementById('coin3d') && d.getElementById('die3d').hidden") is True)
                check(f'{role}: drawn in 3D', html_data(p, role, 'coin') == 'webgl')
            check('no words before the landing', q(p, 'mine', "d => d.getElementById('value').textContent.trim()") in ('', None))
            # mid-air pictures
            p.wait_for_function(f'() => Date.now() > {at} + 1000')
            ph = [html_data(p, r, 'coinPhase') for r in ('mine', 'theirs')]
            check('both copies are in the air together', ph == ['air', 'air'], str(ph))
            if SHOTS: p.screenshot(path=os.path.join(SHOTS, 'coin-air.png'))
            # reload your tile mid-toss: it joins where the toss is
            p.evaluate("window.__h.reload('mine')")
            p.wait_for_function("() => { const f = document.querySelector('iframe[data-role=mine]'); return f.contentDocument && f.contentDocument.getElementById('coin3d'); }", timeout=5000)
            joined_at = now(p) - at
            ph2 = html_data(p, 'mine', 'coinPhase')
            check('a tile reloaded mid-toss joins it where it is (not from the start)', ph2 in ('air', 'bounce', 'settle') and joined_at > 1000, f'{ph2} at {joined_at}')
            p.wait_for_function(f'() => Date.now() > {at} + {LANDS} + 300')
            words = q(p, 'mine', "d => d.getElementById('value').textContent")
            check('the words at the landing: who goes first', 'first' in (words or ''), words)
            if SHOTS: p.screenshot(path=os.path.join(SHOTS, 'coin-rest.png'))
            if first == 1:
                dis = q(p, 'mine', "d => { const b = d.getElementById('roll'); return !b.hidden && b.disabled; }")
                check('your turn first: Roll is shown but locked during the toss', dis is True)
            # the end of the sequence, on one clock
            p.wait_for_function("() => { const f = document.querySelector('iframe[data-role=mine]'); return !f.contentDocument.getElementById('coin3d'); }", timeout=8000)
            gone = now(p) - at
            check('the toss ends with the sequence (about 5.2 s from the flip), the reloaded tile too', TOTAL - 50 <= gone <= TOTAL + 400, str(gone))
            p.wait_for_timeout(200)
            check("the watching copy's toss ended too", q(p, 'theirs', "d => !d.getElementById('coin3d')") is True)
            for role in ('mine', 'theirs'):
                k = q(p, role, f"d => {{ const k = d.querySelector('.score[data-seat=\"{first}\"] .keep'); const o = d.querySelector('.score[data-seat=\"{3 - first}\"] .keep'); return [k.classList.contains('off'), k.getAttribute('title'), o.classList.contains('off')]; }}")
                want = 'You went first' if first == 1 else '@dicesprite.thunderbird.cafe went first'
                check(f'{role}: the keepsake by the first player\'s score, titled "{want}"', k == [False, want, True], str(k))
                sub = q(p, role, "d => d.getElementById('sub').textContent")
                check(f'{role}: no "went first" under the handle', 'went first' not in (sub or ''), sub)
                check(f'{role}: the die is back', q(p, role, "d => !d.getElementById('die3d').hidden") is True)
            if first == 1:
                en = q(p, 'mine', "d => !d.getElementById('roll').disabled")
                check('Roll is free once the toss is over', en is True)
                roll_checked = True
            if SHOTS: p.screenshot(path=os.path.join(SHOTS, 'coin-after.png'))
        if first == 1 and not roll_checked:
            roll_checked = True
            p.wait_for_function(f'() => Date.now() > {at} + 2500')
            dis = q(p, 'mine', "d => { const b = d.getElementById('roll'); return !b.hidden && b.disabled; }")
            check('you go first: Roll is shown but locked during the toss', dis is True)
            p.wait_for_function(f'() => Date.now() > {at} + {TOTAL} + 300')
            check('…and free once the toss is over', q(p, 'mine', "d => !d.getElementById('roll').disabled") is True)
        if first == 2 and not bot_checked:
            bot_checked = True
            p.wait_for_function("() => (window.__h.events || []).some((e) => e.kind === 'rolling')", timeout=10000)
            t = p.evaluate("window.__h.events.find((e) => e.kind === 'rolling').t") - at
            check('the bot rolls about 1.2 s after Roll is free', TOTAL + 1100 <= t <= TOTAL + 1900, str(t))
        check(f'no errors (match {attempt + 1})', not errs, '; '.join(errs[:3]))
        c.close()
        if attempt >= 1 and seen_first == {1, 2} and bot_checked and roll_checked:
            break
    check('both seats went first in some match (both cases seen)', seen_first == {1, 2}, str(seen_first))

    # Reduced motion: a still coin on the winner's face for the same time, the words at once.
    c, p, errs, flip = start(browser, reduced_motion='reduce')
    at = flip['at']
    p.wait_for_timeout(400)
    check('reduced motion: the coin lies still on the winning face', html_data(p, 'mine', 'coinPhase') == 'rest')
    check('reduced motion: the words at once', 'first' in (q(p, 'mine', "d => d.getElementById('value').textContent") or ''))
    p.wait_for_function(f'() => Date.now() > {at} + 2500')
    check('reduced motion: still the same coin, still still', html_data(p, 'mine', 'coinPhase') == 'rest')
    p.wait_for_function("() => { const f = document.querySelector('iframe[data-role=mine]'); return !f.contentDocument.getElementById('coin3d'); }", timeout=8000)
    gone = now(p) - at
    check('reduced motion: the same length as everyone else\'s toss', TOTAL - 50 <= gone <= TOTAL + 400, str(gone))
    check('no errors (reduced motion)', not errs, '; '.join(errs[:3]))
    c.close()
    browser.close()

    # No WebGL: the flat coin on the flat die's canvas, on the same clock.
    browser = pw.chromium.launch(args=['--disable-webgl', '--disable-3d-apis'])
    c, p, errs, flip = start(browser)
    at = flip['at']
    p.wait_for_timeout(600)
    check('no WebGL: the flat coin', html_data(p, 'mine', 'coin') == 'flat' and q(p, 'mine', "d => !d.getElementById('die').hidden && !d.getElementById('coin3d')") is True)
    if SHOTS:
        p.wait_for_function(f'() => Date.now() > {at} + 1000')
        p.screenshot(path=os.path.join(SHOTS, 'coin-flat.png'))
    p.wait_for_function(f'() => Date.now() > {at} + {TOTAL} + 300')
    first = flip['first']
    k = q(p, 'mine', f"d => !d.querySelector('.score[data-seat=\"{first}\"] .keep').classList.contains('off')")
    check('no WebGL: the keepsake after the toss', k is True)
    check('no errors (no WebGL)', not [e for e in errs if 'WebGL' not in e], '; '.join(errs[:3]))
    c.close()
    browser.close()

srv.shutdown()
print(f'\n{len(passed)} passed, {len(failed)} failed')
sys.exit(1 if failed else 0)
