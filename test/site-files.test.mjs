import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { siteFiles } from '../scripts/copy-to-site.mjs';
import { fingerprint } from '../scripts/tiles.mjs';
import { isHouseVersion } from '../relay/tables.js';

const PUBLISHED = {
  account: 'did:plc:6vxjigxrqizmbo56gojxico3', handle: 'thunderbird.cafe',
  house: { uri: 'at://did:plc:6vxjigxrqizmbo56gojxico3/ing.dasl.masl/3mzzzzzzzzzh1', cid: 'bafyreihouse', manifestCid: 'x', publishedAt: 'y' },
  player: { uri: 'at://did:plc:6vxjigxrqizmbo56gojxico3/ing.dasl.masl/3mzzzzzzzzzp1', cid: 'bafyreiplayer', manifestCid: 'x', publishedAt: 'y' },
};

test('the site copy: not published → no pins (the memory copies); published → pinned to address and record CID only', () => {
  assert.match(siteFiles(null).files['published.generated.js'], /export const PUBLISHED = null;/);
  const { files, pinned } = siteFiles(PUBLISHED);
  assert.deepEqual(pinned, { account: PUBLISHED.account, house: { uri: PUBLISHED.house.uri, cid: 'bafyreihouse' }, player: { uri: PUBLISHED.player.uri, cid: 'bafyreiplayer' } });
  assert.ok(files['published.generated.js'].includes('"cid": "bafyreihouse"'));
});

test('the memory house has a fingerprint the relay passes on, and it changes when the house does', () => {
  const v = fingerprint('house');
  assert.ok(isHouseVersion(v), v);
  assert.match(siteFiles(null).files['tiles.generated.js'], new RegExp(`MEMORY_HOUSE_VERSION = "${v}"`));
  assert.notEqual(fingerprint('player'), v);
});

test('the site\'s record.js runs from its own folder (with shared/ beside it) and still re-checks the dice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daisy-site-'));
  mkdirSync(join(dir, 'shared'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  for (const [name, text] of Object.entries(siteFiles(null).files)) if (name === 'record.js' || name.startsWith('shared/')) writeFileSync(join(dir, name), text);
  const site = await import(pathToFileURL(join(dir, 'record.js')).href);
  const here = await import('../page/record.js');
  assert.equal(site.COLLECTION, 'cafe.thunderbird.daisy.match');
  assert.equal(site.checkRecord({}), '$type');
  assert.equal(typeof here.checkRecord, 'function');
});
