import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPublish, ACCOUNT, tileToPublish } from '../scripts/publish.mjs';
import { pinnedFrom } from '../scripts/copy-to-site.mjs';
import { createFakePds } from './fake-pds.mjs';
import { dagCborCid } from '../scripts/lib/dagcbor.js';
import { rawCid } from '../scripts/lib/cid.js';

const quiet = () => {};
function run(pds, opts = {}) {
  let published = opts.published || {};
  const writes = [];
  return runPublish({
    fetchImpl: pds.fetchImpl, log: quiet, ask: async () => opts.answer ?? 'y', askHidden: async () => opts.password ?? 'right-password',
    readPublished: () => published, writePublished: (o) => { published = o; writes.push(structuredClone(o)); },
    now: () => '2026-10-16T12:00:00.000Z', ...opts,
  }).then((r) => ({ ...r, writes, published }));
}

test('a dry run writes nothing and asks nothing', async () => {
  const pds = createFakePds({ did: ACCOUNT, handle: 'thunderbird.cafe' });
  const r = await run(pds, { dryRun: true, askHidden: async () => { throw new Error('asked'); } });
  assert.equal(r.changed, false);
  assert.equal(r.plan.length, 2);
  assert.ok(r.lexiconDue);
  assert.ok(!pds.calls.some((c) => c.includes('uploadBlob') || c.includes('Record')));
});

test('publishing: both tiles as Foundry-shaped records, read back, and the lexicon', async () => {
  const pds = createFakePds({ did: ACCOUNT, handle: 'thunderbird.cafe' });
  const r = await run(pds);
  assert.equal(r.changed, true);
  const out = r.published;
  for (const id of ['house', 'player']) {
    const p = out[id];
    assert.match(p.uri, new RegExp(`^at://${ACCOUNT}/ing.dasl.masl/`));
    const rec = pds.records.get(`ing.dasl.masl/${p.uri.split('/').pop()}`);
    assert.equal(rec.cid, p.cid, 'pinned to the record CID the server gave');
    const value = rec.value;
    assert.equal(value.$type, 'ing.dasl.masl');
    assert.equal(value.cid, await dagCborCid(value.tile), 'the manifest address recomputes, as the Foundry checks');
    assert.equal(value.cid, p.manifestCid);
    assert.deepEqual(value.tile.icons, [{ src: '/icon.png' }]);
    assert.deepEqual(value.tile.screenshots, [{ src: '/banner.png' }]);
    assert.equal(value.tile.generator, 'Daisy');
    assert.ok(value.tile.description.includes('thunderbird.cafe/webtiles/daisy/'));
    const root = value.tile.resources['/'];
    assert.equal(root['content-type'], 'text/html');
    assert.match(root['content-security-policy'], /default-src 'self' blob: data:/);
    for (const [path, entry] of Object.entries(value.tile.resources)) {
      const b = pds.blobs.get(entry.src.ref.$link);
      assert.ok(b, `${path} uploaded`);
      assert.equal(await rawCid(b.bytes), entry.src.ref.$link);
    }
  }
  assert.ok(pds.records.has('com.atproto.lexicon.schema/cafe.thunderbird.daisy.match'));
  const lex = pds.records.get('com.atproto.lexicon.schema/cafe.thunderbird.daisy.match').value;
  assert.equal(lex.$type, 'com.atproto.lexicon.schema');
  assert.equal(lex.id, 'cafe.thunderbird.daisy.match');
  assert.equal(r.writes.length, 3, 'published.json kept after each step');
  assert.deepEqual(pinnedFrom(out), { account: ACCOUNT, house: { uri: out.house.uri, cid: out.house.cid }, player: { uri: out.player.uri, cid: out.player.cid } });
});

test('nothing published twice; --again makes new tile records; a changed lexicon is put again', async () => {
  const pds = createFakePds({ did: ACCOUNT, handle: 'thunderbird.cafe' });
  const first = await run(pds);
  const again = await run(pds, { published: first.published });
  assert.equal(again.changed, false);
  const lexicon = JSON.parse(readFileSync(new URL('../lexicons/cafe.thunderbird.daisy.match.json', import.meta.url), 'utf8'));
  lexicon.description += ' (changed)';
  const lex = await run(pds, { published: first.published, lexicon });
  assert.equal(lex.changed, true);
  assert.equal(lex.published.house.uri, first.published.house.uri, 'tiles untouched');
  const fresh = await run(pds, { published: first.published, again: true });
  assert.notEqual(fresh.published.house.uri, first.published.house.uri);
});

test('a wrong password or a No publishes nothing', async () => {
  const pds = createFakePds({ did: ACCOUNT, handle: 'thunderbird.cafe' });
  await assert.rejects(run(pds, { password: 'wrong' }), /Invalid identifier or password/);
  const no = await run(pds, { answer: 'n' });
  assert.equal(no.changed, false);
  assert.ok(!pds.calls.some((c) => c.includes('uploadBlob')));
});

test('a file the server already holds under another type: the Foundry\'s retry', async () => {
  const tile = await tileToPublish('player');
  const css = tile.files.find((f) => f.path === '/player.css');
  const pds = createFakePds({ did: ACCOUNT, handle: 'thunderbird.cafe', storedTypes: { [css.cid]: 'application/octet-stream' } });
  const r = await run(pds);
  const rec = pds.records.get(`ing.dasl.masl/${r.published.player.uri.split('/').pop()}`).value;
  assert.equal(rec.tile.resources['/player.css'].src.mimeType, 'application/octet-stream');
  assert.equal(rec.cid, await dagCborCid(rec.tile));
});
