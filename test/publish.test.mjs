import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPublish, ACCOUNT, tileToPublish, LEXICON_IDS, publishedLexicons } from '../scripts/publish.mjs';
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
  assert.deepEqual(r.lexiconsDue, LEXICON_IDS);
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
  for (const id of LEXICON_IDS) {
    const rec = pds.records.get(`com.atproto.lexicon.schema/${id}`);
    assert.ok(rec, `${id} published`);
    assert.equal(rec.value.id, id);
    assert.equal(out.lexicons[id].cid, rec.cid);
  }
  assert.equal(out.lexicon.uri, out.lexicons['cafe.thunderbird.daisy.match'].uri, 'the match lexicon also where step 4 kept it');
  assert.equal(r.writes.length, 2 + LEXICON_IDS.length, 'published.json kept after each step');
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

test('step 6: from the real published.json (step 4: tiles and the match lexicon), only the lounge record and the two permission sets are due', async () => {
  const real = JSON.parse(readFileSync(new URL('../published.json', import.meta.url), 'utf8'));
  const pds = createFakePds({ did: ACCOUNT, handle: 'thunderbird.cafe' });
  const r = await run(pds, { published: real, dryRun: true });
  assert.equal(r.plan.length, 0, 'the tiles are not published again');
  assert.deepEqual(r.lexiconsDue, ['cafe.thunderbird.daisy.lounge', 'cafe.thunderbird.daisy.authPlay', 'cafe.thunderbird.daisy.authLounge']);
  const done = await run(pds, { published: real });
  assert.equal(done.published.house.uri, real.house.uri);
  assert.equal(done.published.lexicon.uri, real.lexicon.uri, 'the match lexicon untouched');
  assert.deepEqual(Object.keys(publishedLexicons(done.published)).sort(), [...LEXICON_IDS].sort());
  assert.equal((await run(pds, { published: done.published })).changed, false, 'nothing left to publish');
});

test('step 6: the permission sets: wording, and permissions only inside cafe.thunderbird.daisy', () => {
  const read = (id) => JSON.parse(readFileSync(new URL(`../lexicons/${id}.json`, import.meta.url), 'utf8'));
  const play = read('cafe.thunderbird.daisy.authPlay').defs.main;
  const lounge = read('cafe.thunderbird.daisy.authLounge').defs.main;
  for (const set of [play, lounge]) {
    assert.equal(set.type, 'permission-set');
    assert.ok(set.title && set.detail);
    for (const p of set.permissions) {
      assert.equal(p.type, 'permission');
      for (const n of [...(p.collection || []), ...(p.lxm || [])]) assert.match(n, /^cafe\.thunderbird\.daisy\.[a-z][A-Za-z.]*$/);
      if (p.resource === 'rpc') { assert.equal(p.inheritAud, true); assert.equal(p.aud, undefined); }
    }
  }
  assert.equal(play.title, 'Play Daisy');
  assert.equal(play.detail, 'Save the Daisy matches you finish to your own account. Nothing else in your account is read or changed.');
  assert.deepEqual(play.permissions, [{ type: 'permission', resource: 'repo', collection: ['cafe.thunderbird.daisy.match'] }]);
  assert.equal(lounge.title, 'Daisy lounge');
  assert.equal(lounge.detail, "Let other mingling Daisy players see when you're at the table, and receive their invitations to play. Turning mingling off removes your lounge record.");
  assert.deepEqual(lounge.permissions.map((p) => p.resource), ['repo', 'rpc']);
  assert.deepEqual(lounge.permissions[1].lxm, ['cafe.thunderbird.daisy.lounge.enter']);
});
