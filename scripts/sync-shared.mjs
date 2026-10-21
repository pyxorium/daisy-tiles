// Copies the files in shared/ into each tile's folder (tiles can't share files once published).
// Run after changing anything in shared/:  node scripts/sync-shared.mjs
// (Modelled on C:\thunderbird-cafe\sevenup-tiles\scripts\sync-shared.mjs. Here each tile takes only the
// shared files it uses: the house runs the referee, the player only draws.)
import { readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SHARED = readdirSync(join(root, 'shared')).filter((f) => f.endsWith('.js'));
export const SHARED_FOR = {
  house: SHARED,
  player: ['talk.js', 'dice.js', 'sha256.js', 'coin.js'],
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [tile, files] of Object.entries(SHARED_FOR)) {
    for (const f of files) copyFileSync(join(root, 'shared', f), join(root, tile, f));
    console.log(`copied ${files.join(', ')} into ${tile}`);
  }
}
