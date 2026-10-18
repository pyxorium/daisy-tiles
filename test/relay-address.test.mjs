// Step 5: which relay the site's page uses (needs C:\thunderbird-cafe\pyxorium.github.io beside this folder).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const CONFIG = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'pyxorium.github.io', 'src', 'daisy', 'config.js');
const skip = !existsSync(CONFIG) && 'the site folder is not beside this one';
const at = (href) => new URL(href);

test('the live page plays through the real relay; on this computer the stand-in stays the default, ?relay= tries another', { skip }, async () => {
  const { RELAY_URL, relayUrl, pageCsp } = await import(pathToFileURL(CONFIG).href);
  assert.equal(RELAY_URL, 'wss://relay.daisy.thunderbird.cafe/');
  assert.equal(relayUrl(at('https://thunderbird.cafe/webtiles/daisy/?table=k7q3m2xw9a')), RELAY_URL);
  assert.equal(relayUrl(at('https://thunderbird.cafe/webtiles/daisy/?relay=wss://evil.example/')), RELAY_URL);   // never from the link on the live page
  assert.equal(relayUrl(at('http://127.0.0.1:4321/webtiles/daisy/')), 'ws://127.0.0.1:8787/');
  assert.equal(relayUrl(at('http://127.0.0.1:4321/webtiles/daisy/?relay=wss://relay.daisy.thunderbird.cafe/')), RELAY_URL);
  assert.match(pageCsp(), /connect-src 'self' https: wss:/);                  // the page's policy lets it connect
});
