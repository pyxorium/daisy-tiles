// For test/check_site.py --published: publishes both tiles and the lexicon to the stand-in PDS with the
// real publish.mjs, and writes what the PDS then holds plus the resulting published.json to one file.
// Usage: node test/make-published-fixture.mjs <out.json>
import { writeFileSync } from 'node:fs';
import { runPublish, ACCOUNT } from '../scripts/publish.mjs';
import { createFakePds } from './fake-pds.mjs';

const pds = createFakePds({ did: ACCOUNT, handle: 'thunderbird.cafe' });
let published = {};
await runPublish({ fetchImpl: pds.fetchImpl, log: () => {}, ask: async () => 'y', askHidden: async () => 'right-password',
  readPublished: () => published, writePublished: (o) => { published = o; } });
writeFileSync(process.argv[2], JSON.stringify({ pds: pds.dump(), published }));
console.log(`fixture: house ${published.house.uri}, player ${published.player.uri}`);
