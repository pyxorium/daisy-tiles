// tiles.mjs: what goes into each Daisy tile (modelled on sevenup-tiles/scripts/tiles.mjs), shared by
// copy-to-site.mjs (memory copies for the site) and publish.mjs (the published records).
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TABLE_URL = 'https://thunderbird.cafe/webtiles/daisy/';

export const TILES = {
  house: {
    name: 'Daisy house',
    description: 'The referee for one seat at a two-computer Daisy dice table: it keeps the rules and its half of the commit-reveal dice. It runs hidden at thunderbird.cafe/webtiles/daisy/, so on its own there is little to see.',
    sizing: { width: 420, height: 200 },
    files: ['index.html', 'house.css', 'house.js', 'referee.js', 'rules.js', 'dice.js', 'sha256.js', 'tid.js', 'talk.js', 'bot.js', 'coin.js'],
  },
  player: {
    name: 'Daisy',
    description: 'One seat at a two-computer Daisy dice table: one die, roll or bank, a 1 loses the turn, first to 25 wins. Play at thunderbird.cafe/webtiles/daisy/.',
    sizing: { width: 420, height: 560 },
    files: ['index.html', 'player.css', 'player.js', 'die3d.js', 'coin3d.js', 'coin.js', 'dice.js', 'sha256.js', 'talk.js'],
  },
};
// Card pictures, made by scripts/make-card-art.py (only in published tiles; the memory copies don't need them).
export const CARD_FILES = ['icon.png', 'banner.png'];

// The Foundry's one fixed type per kind of file (web-tile-foundry/src/core/fileset.js CONTENT_TYPES).
export const PUBLISH_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

// The tile's own security policy, from its page's <meta> tag (it also goes in the record, as the Foundry does).
export function cspOf(html) {
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
  if (!m) throw new Error('The tile page has no security policy.');
  return m[1];
}

// A tile's files for publishing: [{ path, bytes, contentType }], "/" being its page.
export function publishFiles(id) {
  const t = TILES[id];
  const out = [];
  for (const f of [...t.files, ...CARD_FILES]) {
    const file = join(ROOT, id, f);
    if (!existsSync(file)) throw new Error(`Missing ${id}/${f}${CARD_FILES.includes(f) ? ' (run: python3 scripts/make-card-art.py)' : ''}`);
    const path = f === 'index.html' ? '/' : `/${f}`;
    out.push({ path, bytes: new Uint8Array(readFileSync(file)), contentType: PUBLISH_TYPES[extname(f)] });
  }
  return out;
}

// A short fingerprint of a tile's own files (not the card pictures): names the memory copy's version
// for the house version check, the way a published tile's record CID names a published one.
export function fingerprint(id) {
  const h = createHash('sha256');
  for (const f of TILES[id].files) { h.update(f); h.update('\0'); h.update(readFileSync(join(ROOT, id, f))); h.update('\0'); }
  return 'memory:' + h.digest('hex').slice(0, 24);
}
