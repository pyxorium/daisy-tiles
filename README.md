# Daisy tiles

Daisy is a two-computer dice game: Pig, renamed. There's one die; you roll or bank, a 1 loses the
turn, and the first to 25 wins at once. It's played with web tiles at `thunderbird.cafe/webtiles/daisy/`.
Both players' pages run the same pinned **house** tile, and the dice are **commit-reveal**, so neither
player can choose them and anyone can re-check a saved match. Design and status are in
`claude/daisy-plan.md` (project doc). This folder is modelled on `C:\thunderbird-cafe\sevenup-tiles`.

**Status: build step 6 of 7 (Oct 18 2026): the lounge (step 5, the real relay on Fly.io, is done).** Steps 1 (rules and dice), 2 (two
pages through a stand-in relay), 3 (the 3D die) and 4 (signing in to sit, saving, publishing and pinning)
are done. You sign in with your atproto account to sit (handle suggestions as you type; the permission
asked is only to save Daisy matches), save a finished match to your own repo when you ask (the page's own
prompt), and the page loads exactly the published tiles (pinned by record CID). The two pages check they
run the same house before the table starts. The page lives in the site at `/webtiles/daisy/` (files in
`src/daisy/`; hidden: noindex, out of the sitemap). **The live page plays through the real relay,
`wss://relay.daisy.thunderbird.cafe/`** (its own Fly app and folder, `C:\thunderbird-cafe\daisy-relay`,
which runs a copy of this folder's `relay/tables.js`); on this computer the stand-in stays the default.

## Try it (on this computer)

1. In this folder: `node scripts/sync-shared.mjs`, then `node scripts/copy-to-site.mjs C:\thunderbird-cafe\pyxorium.github.io`
   (only after changing a tile; the site already has the current copies).
2. In this folder, in its own terminal: `node scripts/relay-standin.mjs` (leave it running; Ctrl+C stops it).
3. In `C:\thunderbird-cafe\pyxorium.github.io`: `npm run dev`.
4. Open http://127.0.0.1:4321/webtiles/daisy/ (at 127.0.0.1, not localhost) in a normal window, type a
   handle, **Open a table**, sign in in the small window, copy the link.
5. Open the link in a **private window** (its own storage, like a second computer), type the other handle,
   **Take a seat**, sign in. Choose glazes and play. At the end, **Save this match** saves your copy to
   your account. Before publishing (or with `&tiles=memory`) the page uses its memory copies of the tiles. Drag your die to turn it, scroll or pinch to zoom: the other
   window's copy follows. Add `&timers=short` to the first address (before opening the
   table) to try the forfeits quickly: 10 s nudge, 30 s turn, 20 s away. The link carries it.

"What passes between the pages" at the bottom of each page lists the messages.

**The real relay from this computer:** add `?relay=wss://relay.daisy.thunderbird.cafe/` to the first
address (the table link carries it to the second window). The relay accepts pages from
`http://127.0.0.1:4321` during step 5 (`ALLOWED_ORIGINS` in `C:\thunderbird-cafe\daisy-relay\fly.toml`).

## Run the tests

```
npm test
```

There are 75 tests (about 10 seconds). Nothing to install: Node only (the relay test over real
WebSockets needs Node 22 or later and is skipped on older ones).

The browser checks (sandbox, Playwright for Python): `python3 test/check_page.py --site <site folder>
--loader <tiles-loading-server folder> --modules <folder holding node_modules/@dasl/tile-loader>`. Two
separate browser contexts play through `test/loader-replica.mjs` (port 80) and the stand-in relay: a
whole match, a reload mid-match, a relay restart, rematch, a third visitor, a seat held from a browser
without its saved game, phone width, the short timers (away, turn timeout, mismatched timers), and the 3D
die (on every tile, landing on the agreed face on both pages, the shared view, the wilt on a 1, the flat
fallback without WebGL, a sheet of the six glazes); step 4: signing in to sit (a stand-in for the
sign-in library), the handle suggestions, saving (the prompt, the record, Not now, signed out then Sign in
and save), a sign-in for the wrong account, the house version check, and the published tiles pinned
(published with the real `publish.mjs` to a stand-in PDS, played under the page's security policy, the
record naming the house, a changed record refused, each tile on its own showing its card picture and never on the page); step 6, the lounge, against the real relay's server with stand-in lookups (`C:\thunderbird-cafe\daisy-relay\test\lounge-standin.mjs`, needs daisy-relay beside this folder with its packages installed): the explanation before signing in, the "Daisy lounge" sign-in and the lounge record, who else is mingling, blocks both ways, an invitation with Not now and "No answer", a reload while mingling, mingling off deleting the record, and Play sending both pages to one table; "Back to the start" from a table (asked first mid-match) and "Back to the lounge" after it; the start screen's one sign-in (Open a table and the lounge wait for it; mingling asks once more), the lounge card's "Joining the lounge requires one additional authorization", and the start screen's "You have a match in progress with @x. Back to the table". 109 checks. (The main checks use the memory tiles: the site's own pins point at the real published tiles, which only the real PDS serves.) Chromium needs
`--use-angle=swiftshader --enable-unsafe-swiftshader` for WebGL without a GPU (the script passes them).

## Folders

- `shared/`: copied into each tile by `node scripts/sync-shared.mjs` (a test checks the copies).
  - `sha256.js`: a small SHA-256, so the dice run the same everywhere with no waiting. Checked against
    the standard test values and Node's own hash.
  - `dice.js`: the six glazes and the hash chain (seed, commitment, reveals, the fair 1 to 6, the coin).
  - `rules.js`: Pig as plain functions (roll, bank, bust, the win at the target, forfeits, replay).
  - `verify.js`: `verifyMatch(record)` re-checks a finished match from its record alone.
  - `bot.js`: the bot banks at 20 and agrees to a rematch when asked.
  - `tid.js`: match ids as TIDs (copied from Seven-Up).
- `house/`: the house tile (hidden, one per page). `referee.js` is the referee for one seat
  (`step(state, message, ctx)`, with the clock and random bytes passed in; `resumeFrom` after a
  reload); `house.js` wires it to the page.
- `player/`: the player tile, used twice on each page: yours (glaze picker, the die, Roll and Bank,
  scores, the nudge, the end screen) and a copy watching the other seat (no buttons). `die3d.js` is the
  3D die: a rounded cube in the glaze, round pips with a daisy for the 1, tumble and landing on the
  agreed face, a leaning, dimmed "wilt" on a 1, a soft glow (Glow always glows a little), rotate with
  one pointer and zoom with the wheel or a pinch, the shared view (15 a second). No WebGL: the flat die.
- `relay/tables.js`: the relay's rules (seats per table, passing messages, presence), no network parts.
  `scripts/relay-standin.mjs` runs them over plain WebSockets, hand-made, no packages.
  **The real relay** (`C:\thunderbird-cafe\daisy-relay`, on Fly.io) runs a byte-for-byte copy: after
  changing `tables.js` here, run `npm run sync` there, test, commit and `fly deploy --ha=false`. (Its own
  tests check the copy matches and that the stand-in and the real relay answer alike.)
- `page/router.js`: the page's routing between its three tiles and the relay; copied into the site.
- `page/record.js`: the record one player saves (`recordFor`, `checkRecord`, which also runs the
  dice check); copied into the site with the shared files it needs.
- `lexicons/`: `cafe.thunderbird.daisy.match` (key `tid`, published in step 4) and a draft of
  `cafe.thunderbird.daisy.lounge` (key `literal:self`, for step 6).
- `scripts/`: `sync-shared.mjs`, `tiles.mjs` (each tile's files), `copy-to-site.mjs` (the tiles, the pins,
  the routing and the record check into the site), `relay-standin.mjs`, `publish.mjs` (with `lib/`, copied
  from Seven-Up), `make-card-art.py` and `card-art.html` (the card pictures, drawn with the real die).
- `published.json`: written by `publish.mjs` (what was published, and pinned). Keep it.
- `test/`: `table-sim.mjs` (two houses joined by a stand-in relay, with a seeded random generator),
  the Node test files, `check_page.py` and `loader-replica.mjs` (a copy of Seven-Up's).

## Publishing (step 4)

From the thunderbird.cafe account, once, after the owner's test with the memory tiles:

1. `node scripts/publish.mjs --dry-run`: shows what would be published (both tiles with their card
   pictures, and the match lexicon); asks nothing, writes nothing.
2. Make an app password for thunderbird.cafe, then `node scripts/publish.mjs`: it asks for it (hidden as
   you type) and once more before writing, publishes, reads everything back to check, and writes
   `published.json`.
3. `node scripts/copy-to-site.mjs C:\thunderbird-cafe\pyxorium.github.io`: points the page at the
   published tiles (`src/daisy/published.generated.js`).
4. At Wix, add a TXT record: host `_lexicon.daisy`, value `did=did:plc:6vxjigxrqizmbo56gojxico3`.
5. Delete the app password.

**Lexicons (step 6):** `publish.mjs` publishes every lexicon in `LEXICON_IDS`, each only when it's new or
changed: the match and lounge records, and two **permission sets**, `cafe.thunderbird.daisy.authPlay`
("Play Daisy": the match records) and `cafe.thunderbird.daisy.authLounge` ("Daisy lounge": the lounge
record and the relay pass, asked for as
`include:cafe.thunderbird.daisy.authLounge?aud=did:web:relay.daisy.thunderbird.cafe%23daisy_relay`). Their
title and detail are what the Authorize screen is meant to show. The one Wix TXT record `_lexicon.daisy`
covers them all. Sign-in servers cache a set for up to a day, so a changed set may take that long to show.

After a change to a tile: `python3 scripts/make-card-art.py` if the look changed, then
`node scripts/publish.mjs --again` (new records, new addresses) and step 3 again. Pages running an older
house can't sit with pages running the new one (the house version check), so both players reload.

## How the dice work

1. Each house makes a secret 32-byte seed and hashes it 1,000 times. It sends only the top link
   (its **commitment**), before any roll.
2. **Roll n** (the coin is roll 0) reveals one link from each player, walking down the chain. Anyone
   checks a reveal by hashing it once: the result must be the link before it.
3. The value is SHA-256 over the match id, the roll number and both reveals, read fairly as 1 to 6
   (bytes of 252 and over are skipped), or as heads/tails for the coin.
4. A roll is one round trip: the roller sends `roll` with its reveal, and the other house answers with
   its own.
5. If a chain runs out, both houses send fresh commitments before either new link is revealed. The
   record then lists those as `rechains`.
6. The record keeps both commitments and each player's **last revealed link**. Hashing forward from that
   link rebuilds every reveal, so the coin and every roll can be recomputed, even after a forfeit.

## Messages between the two houses

Each message is `{ kind, matchNo, seq, … }`. `seq` counts up per sender: repeats are ignored, and a gap
gets a `{ kind: "resend", after }` request. A reconnecting page can send the same request.

| Kind | When |
|---|---|
| `commit` | each chain's commitment (seat 1's first one carries `matchId` and `target`) |
| `pick` | a glaze (a clash goes to seat 1; seat 2's player hears `taken`) |
| `reveal` | the coin (`n: 0`), or the answer to a roll |
| `roll` | the roller's reveal for roll `n` |
| `bank` | with `h`, the length of the history it banks after |
| `rematch` | asks for a rematch; when both have asked, a new match starts with the same glazes |
| `forfeit` | a claim against the other seat: `reason`, and `at` (the history length the claimant saw) |
| `abandon` | a player left before play started |

Also between the pages, around the houses: `die-view` `{ q, z }` (your die's orientation and zoom, from
your player tile to the other page's watching copy; latest wins, never recorded).

From the page: `setup` (the seat, the timer set, a kept snapshot), `seated`, `presence` (`gone`/`back`,
about the other seat), `tick`, `reconnected` (ask the other house for anything missed). From this
seat's player: `pick`, `roll`, `bank`, `rematch`. To the player: `picking`, `taken`, `flipping`, `flip`,
`turn`, `rolling`, `rolled`, `bust`, `banked` (`big` for the 🌼 burst), `win`, `nudge`, `forfeit`,
`match-over`, `rematch-asked`, `rematch`, `abandoned`. To the page: `result`.
