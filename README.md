# Southpaw Sessions

A Firefox session manager with a link library built in.

- **Save** every open tab as a named session — all windows, one window, or just
  the selected tabs — and optionally close them to free memory.
- **Reopen** a session later, in new windows or into the current one. Tabs are
  created *unloaded*, so a 150-tab session opens in about a second and uses
  almost no memory until you click a tab.
- **Browse everything at once.** "All links" folds every saved session into one
  searchable, sortable table of unique links. Remove a link from one session,
  or delete it from all of them — both with undo.
- **Find dead links.** YouTube and Imgur links are checked with calibrated
  rules; other sites can be checked opt-in. Verdicts are cached and the scan is
  resumable.
- **Never lose the browser's state.** Autosave keeps a rolling record of open
  tabs; after a crash or restart the previous browser session is one click
  away, and so are recently closed windows.
- **Backups that behave.** The library is written to
  `Downloads/SouthpawSessions/` only when it actually changed — one file per
  day, old files rotated out.
- **Import** from MySessions (`.mysessions`), Session Manager (`.session`),
  Firefox's own session files (`sessionstore*.jsonlz4`), and Southpaw backups.

It replaces two things: the unmaintained *MySessions* add-on, and the separate
`firefox-session-analyzer` tool (now retired — everything it did happens inside
the extension).

---

## Install

The extension is plain JavaScript; there is no build step.

**Try it (temporary, gone after a restart):**
`about:debugging` → *This Firefox* → *Load Temporary Add-on…* → pick
`extension/manifest.json`. Or `npm install && npm start`, which launches a
separate Firefox with the extension loaded.

> **A temporary add-on loses its data when Firefox closes.** Firefox removes
> it, storage included, on exit. To keep what you imported or saved while
> trying it out: Settings → *Back up now* (or *Download a copy…*) before
> closing Firefox, then *Import* that backup file into the signed install.

**Install it for good.** Download the newest signed `.xpi` from
[Releases](https://github.com/greatgreatasset/southpaw-sessions/releases/latest)
and open it in Firefox (`about:addons` → ⚙ → *Install Add-on From File…*).
Installed copies update themselves: Firefox checks `updates.json` in this
repository about once a day.

### Releasing a new version

Release Firefox only installs add-ons signed by Mozilla. Signing your own
add-on is free and automatic and does not list it in the add-on store.

1. Raise `version` in `extension/manifest.json` (Mozilla signs each version
   once).
2. Run `sign.bat`. It asks for your addons.mozilla.org API key and secret
   (<https://addons.mozilla.org/developers/addon/api/key/> — one key pair per
   Mozilla account, valid for all your add-ons; nothing is stored), has Mozilla
   sign the extension as *unlisted*, then runs `tools/release.mjs`, which
   attaches the `.xpi` to a GitHub release and adds the version to
   `updates.json`.

Needs the GitHub CLI (`gh`) logged in with push access. Without Windows:
`WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… npm run sign && npm run release`.

The add-on ID (`southpaw-sessions@kirk.local`) and the `update_url` are set in
`extension/manifest.json`. Stored data and updates belong to that ID; a fork
must change both before signing.

> Firefox Developer Edition, Nightly and ESR can instead install the unsigned
> `npm run build` archive after setting `xpinstall.signatures.required` to
> `false` in `about:config`.

---

## Moving in from MySessions and the Session Analyzer

Open the manager (toolbar button → *Manage sessions & links*) → **Import**.

1. **Analyzer state** (links deleted and dead-link verdicts recorded in the old
   analyzer). Export it once:
   ```
   npm run migrate:analyzer            # reads ../firefox-session-analyzer, read-only
   ```
   and import the resulting `migration/analyzer-state.json`.
2. **Sessions.** Choose the whole `MySessions` backup folder. Identical files
   are skipped, and when several backups contain the same session the newest
   backup's copy wins. Sessions that exist only in *older* backups (deleted in
   MySessions later) are listed separately and imported only if you tick the
   box.
3. **Older archives** — a folder of Session Manager `.session` files or Firefox
   `sessionstore` files — import the same way.

The order does not matter: links you deleted in the analyzer stay deleted
whether the state file arrives before or after the sessions. Importing is
idempotent; doing it twice changes nothing.

After a browser malfunction, Firefox's own
`<profile>/sessionstore-backups/recovery.jsonlz4` can be imported too.

---

## How it behaves

**Sessions vs. links.** A session keeps its tabs exactly as saved (windows,
order, pinned tabs, tab groups). The *All links* view groups tabs by a
normalized URL (tracking parameters and plain `#anchors` dropped), shows the
richest title any copy was saved with, and tells you how many sessions hold
each link.

**Deleting.**
- *Remove from this session* takes the tab out of one session.
- *Delete from all sessions* takes the link out of every saved session.
- Both are recorded in **Trash → Removed links**, with each link's title and
  address. The record is kept until you erase it — it is never trimmed
  automatically — so anything you deleted can still be looked through,
  searched, opened, or put back in its original position.
- Deleted links are also remembered so re-importing an old backup never brings
  them back (Settings → Housekeeping → *Forget them* turns that off).
- Deleted sessions sit in the trash for 30 days.

**Autosave and recovery.** The open tabs are recorded a few seconds after they
change. Under *Automatic* in the sidebar:
*Live autosave* (now), *Autosave checkpoints* (every 15 minutes, last 8),
*Previous browser session* (what was open when the browser last went away, last
10), *Closed window* (last 15). Any of them can be opened or kept as a regular
session.

**Backups.** A backup contains everything: sessions, trash, the removed-links
record, deleted-link records, dead-link verdicts and settings.
- Written only after the library changed, at most once an hour.
- One file per day (`southpaw-backup-YYYY-MM-DD.json.gz`); the day's file is
  overwritten, the newest 30 are kept.
- If the library suddenly shrinks by more than half, that state goes to a
  separate `…-shrunk-HHMM` file and the earlier backups are left alone. An
  empty library is never backed up.
- *Back up now*, *Download a copy…* and *Restore from a backup…* are in
  Settings. Clearing Firefox's download history makes it forget which backup
  files it wrote; they stay on disk but are no longer rotated.

**Dead links.** *Check dead links* checks the links of the current view.
Settled verdicts are kept; only unchecked and uncertain (`?`) links are
contacted. Closing the page pauses the scan; running it again resumes.
- YouTube: oEmbed, falling back to the watch page (distinguishes removed,
  private, embedding-disabled, members-only).
- Imgur: the direct image (redirects to `removed.png` when gone); albums and
  galleries by whether they redirect to the homepage.
- Other sites (opt-in in Settings): only 404/410 counts as dead, only 2xx as
  alive; everything else stays `?`.

**Addresses Firefox will not open.** Extensions may not open `file:`,
`about:config` and similar addresses. Such tabs come back as a small page
showing the address to copy; saving again keeps the original address.

**Shortcuts.** `Alt+Shift+S` opens the popup, `Alt+Shift+Q` saves all windows
immediately. Change them in `about:addons` → ⚙ → *Manage Extension Shortcuts*.

**Not supported (yet).** Container tabs reopen in the default container; window
positions and tab history are not saved; private windows are only included if
you turn that on and allow the extension in private windows.

---

## Development

```
npm install
npm test          # unit tests (Node + fake-indexeddb)
npm run check     # type-check the JavaScript (JSDoc types, tsc)
npm run lint      # Mozilla's add-on linter
npm run e2e       # drives the real extension in a headless Firefox
npm start         # Firefox with the extension loaded
npm run build     # zip into dist/
```

`npm run e2e` uses a throwaway profile and download folder; it never touches
your Firefox profile. `node tests/e2e/real-data.mjs <files-or-folders>` imports
real data into such a throwaway profile and prints counts and timings.

See [CLAUDE.md](CLAUDE.md) for the architecture and the design rules.
