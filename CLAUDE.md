# CLAUDE.md

Guidance for working in this repo.

## What this is
**Southpaw Sessions** — a Firefox (MV3) session manager with a built-in link
library. Save/reopen sessions, autosave + crash recovery, bounded file backups,
import from older session managers, and one table of every saved link with
pruning and dead-link checking. It supersedes the MySessions add-on and the
retired `../firefox-session-analyzer` repo.

Single user, local only: no server, no accounts, no telemetry.

## Shape
- **No build step, no framework, no runtime dependencies.** `extension/` is
  loaded by Firefox as-is: vanilla ES modules, JSDoc types.
- Dev tooling only (`package.json`): `tsc` for type-checking the JS, `web-ext`
  for lint/run/build, `fake-indexeddb` + `node --test` for unit tests,
  `selenium-webdriver` for the Firefox end-to-end test.

## Commands
```
npm test        # unit tests                       (tests/*.test.mjs)
npm run check   # tsc --noEmit over extension/**/*.js
npm run lint    # web-ext lint
npm run e2e     # real headless Firefox, throwaway profile (tests/e2e/run.mjs)
npm start       # web-ext run
npm run build   # dist/*.zip
```
Run `npm test`, `npm run check` and `npm run lint` before calling a change
done; run `npm run e2e` for anything touching browser APIs or the UI. Lint runs
with `--self-hosted` (the manifest has an `update_url`, which the store-listed
ruleset rejects) and should report nothing.

## Releasing
Self-hosted, unlisted add-on — same scheme as `kpop-content-member-skipper`:
- `extension/manifest.json` carries the permanent ID
  `southpaw-sessions@kirk.local` and
  `update_url` → `updates.json` on `master` of
  `github.com/greatgreatasset/southpaw-sessions` (public; Firefox fetches it
  anonymously).
- `sign.bat` prompts for the AMO API key/secret (never stored), runs
  `web-ext sign --channel=unlisted`, then `tools/release.mjs`: copy the signed
  file to `dist/southpaw-sessions-<version>.xpi`, `gh release create
  v<version>`, append the version to `updates.json`, commit only that file,
  push. `planRelease()` in that script is the tested, side-effect-free part.
- Every release needs a new `version`; Mozilla signs a version once.
- Never commit `migration/` (personal data) — it is git-ignored. Test fixtures
  must use made-up names and URLs: this repository is public.

## File map
```
extension/
  manifest.json
  background.js          event page: autosave triggers, backup scheduling, RPC
  lib/
    model.js             session shape, ids, signatures, formatting
    db.js                IndexedDB (meta, data, checks, tombstones, undo)
    sessions.js          create/rename/trash, removeTabs + undo log
    importer.js          batch -> plan -> apply (the import rules)
    importers/           index.js (format sniffing), mysessions.js,
                         sessionstore.js (+ Session Manager), lz4.js
    library.js           fold sessions into unique links; sort/filter
    url.js, titles.js    canonicalize/classify; richest-title rule
    linkcheck/           checker.js, youtube.js, imgur.js, fetchx.js
    export.js            HTML/JSON link exports
    capture.js           live tabs -> session        (browser.*)
    restore.js           session -> live tabs        (browser.*)
    autosave.js          current/checkpoint/previous/closed snapshots
    backup.js            file backups via downloads API
    settings.js, rpc.js
  popup/                 toolbar popup
  pages/                 manager.{html,css,js} + import-dialog, settings-dialog,
                         trash-view; blocked.* (placeholder for unopenable URLs)
  ui/                    dom.js (h, add/fill, dialogs, menus), link-table.js,
                         base.css
tools/export-analyzer-state.mjs   one-time analyzer DB -> JSON (read-only)
tests/                   pure.test.mjs, db.test.mjs, e2e/
migration/               personal data from tools — gitignored
```
`lib/` modules above the `capture.js` line are pure or IndexedDB-only and run
under Node; keep `browser.*` out of them.

## Data model (`lib/model.js`, `lib/db.js`)
A session is two records with one id: `meta` (name, kind, dates, counts,
`originKey`, `fp`, `deletedAt`) and `data` (`windows[] -> tabs[]`, each tab has
a stable id `t`). Lists read only `meta`.

`kind`: `saved` (the library) · `current` (live autosave, fixed id
`auto:current`) · `checkpoint` · `previous` · `closed`.

Other stores: `checks` (verdict per canonical URL), `tombstones` (deleted
links: `global`, or `session`-scoped by `originKey`), `undo` (removal log).

Settings and small state live in `browser.storage.local` (`settings`,
`backupState`, `libraryChangedAt`, checkpoint stamps); the per-browser-run
marker lives in `browser.storage.session`.

## Design rules — do not regress
- **Nothing may depend on how often the background page loads.** Firefox
  reloads event pages at will. The add-on this replaces wrote a full backup in
  its start-up code and produced thousands of duplicate files. Here: listeners
  are registered at top level; `beginRun()` decides "new browser run?" from a
  `storage.session` marker plus the actual open tabs; backups are driven by the
  `libraryChangedAt` stamp, an interval, and a per-day filename.
- **Backups are bounded and never destructive**: skip when unchanged; one file
  per day (`conflictAction: 'overwrite'`); keep N; never write an empty
  library; a library that shrank by more than half goes to a `-shrunk-` file
  instead of overwriting.
- **Autosave never records an empty or half-closed browser**: `snapshot()`
  refuses zero tabs, waits 10 s after a window closes (a quitting browser
  closes windows one by one), and skips while a tab still reports
  `about:blank` + loading.
- **Identity.** Session = `originKey` (`mysessions:<folderId>`, …), with the
  name+minute fingerprint `fp` as a cross-format fallback. Link =
  `canonicalize(url)`; it must stay compatible with cached verdicts — plain
  fragments are dropped, `#!`/`#/` route fragments are kept.
- **Import rules** (`lib/importer.js`): newest file's copy of a session wins;
  sessions already in the library are kept unless overwrite is requested;
  sessions found only in older full backups are opt-in; tombstoned links are
  never re-added; importing twice is a no-op.
- **Removing links is always undoable, and the record is permanent.**
  `removeTabs` logs each removed tab (title, URL, position) in the `undo`
  store; `undo` restores them and removes only the tombstones that removal
  created. The log doubles as the archive of everything ever deleted: it is
  never trimmed by housekeeping, is shown and searchable in the Trash view,
  and travels in backups (`removed`, deduplicated by `uid`). Entries leave
  only via *Put back* or *Erase* (`forgetRemovals`, which also strips the
  titles from the matching tombstones). Tombstones carry `title`/`original`
  so deletions without a log entry (analyzer migration) stay recognisable.
  Sessions go to the trash (soft delete, purged after `trashDays`); only
  automatic snapshots are hard-deleted.
- **Only library changes** call `markLibraryChanged()` / emit `'sessions'`.
  Autosave writes emit `'auto'`, which listeners must treat as cheap (it fires
  every few seconds while browsing).

## Dead-link checking (`lib/linkcheck/`)
Calibrated against real responses in the old analyzer; re-verified for this
port against 28 recorded verdicts (2026-11).
- **YouTube**: oEmbed → 200 alive, 404 dead, else unknown. **401 is not dead**
  (embedding disabled / members-only): fall back to the watch page and read
  `"playabilityStatus"`: `OK` alive, `ERROR` dead, `LOGIN_REQUIRED` dead
  (private), `UNPLAYABLE` + members-only → `paywalled`. Search URLs are not
  checkable. Thumbnails are useless (200 even for members-only).
- **Imgur image**: the page is an SPA (200 even when removed). Fetch
  `i.imgur.com/<id>.png`; ending up on `removed.png` = dead.
- **Imgur album/gallery**: 200 alive; redirected to the homepage = gone.
- A browser cannot read a redirect's `Location` (`redirect: 'manual'` is
  opaque), so redirects are **followed** and the verdict comes from
  `response.url` / `response.redirected`.
- Generic sites are opt-in and conservative: 404/410 dead, 2xx alive, anything
  else `unknown`.
- `unknown` is retried every run; so are two legacy analyzer verdicts (imgur
  `not_checkable`, youtube `dead` + 401). A request cut off by Stop stores
  nothing.
- The checker runs in the manager page, not the background.

## Gotchas
- **Never use native `el.append()` with conditional children** — it renders
  `null` as the text "null". Use `add()` / `fill()` / `h()` from `ui/dom.js`.
- CSS: component classes set `display`, so `base.css` has
  `[hidden] { display: none !important }`.
- `permissions.request()` must be the first `await` in a click handler.
- Firefox tab facts: a tab cannot be created both `discarded` and `pinned`;
  `discarded` is refused for `about:` URLs; `file:`, `about:config`, `data:`,
  `javascript:` cannot be opened at all (→ `pages/blocked.html`, unwrapped
  again on save); an unloaded tab that is clicked reports `about:blank` until
  the page commits.
- A popup dies when it loses focus — window/tab work goes through
  `lib/rpc.js` to the background.
- `BroadcastChannel` never delivers to the context that posted; a page must
  refresh itself after its own writes.
- E2E harness: Firefox ≥ 138 only lets WebDriver open `moz-extension:` pages if
  geckodriver is started with `--allow-system-access`; the add-on UUID is
  pinned by pref; in-page scripts can use `browser.*` and `import()` the
  extension's modules.
- Unit tests: a `BroadcastChannel` keeps Node alive unless `unref()`'d
  (handled in `db.js`).
