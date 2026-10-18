"""Makes the card pictures for both Daisy tiles (house/icon.png, house/banner.png, player/icon.png,
player/banner.png) by screenshotting scripts/card-art.html in Chromium, which draws them with the player
tile's own 3D die. Needs Playwright for Python. The pictures are kept in the folder, so this only needs
running again when the look changes (then publish the tiles again).

Usage: python3 scripts/make-card-art.py
"""
import functools, http.server, os, socketserver, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = {'player-banner': 'player/banner.png', 'house-banner': 'house/banner.png', 'player-icon': 'player/icon.png', 'house-icon': 'house/icon.png'}


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


srv = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
with sync_playwright() as p:
    # Software WebGL where there's no graphics card (as in the browser checks).
    b = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = b.new_page(viewport={'width': 1400, 'height': 1900}, device_scale_factor=1)
    page.goto(f'http://127.0.0.1:{srv.server_address[1]}/scripts/card-art.html')
    page.wait_for_function('window.cardsReady === true', timeout=20000)
    page.wait_for_timeout(300)
    for el, path in CARDS.items():
        page.locator('#' + el).screenshot(path=os.path.join(ROOT, path))
        print(f'wrote {path} ({os.path.getsize(os.path.join(ROOT, path)) // 1024} KB)')
    b.close()
srv.shutdown()
