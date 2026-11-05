# Hot exit and Rename Tab

VS Code-style hot exit: closing Varia SQL Manager keeps the open query tabs instead of asking to save them, and the next
start reopens them. Tabs can be renamed without saving a file. Agreed with the owner on 2026-11-04 (tabs/docking
roadmap: "name tabs without saving, remembered between sessions").

## Setting

Tools › Options › Environment › Documents › **Restore open queries on startup** (`environment.documents.hotExit`), on by
default. While it is off, a close asks about each query with unsaved changes as before, and deletes any kept session.

## What a close keeps

- Every text tab (queries, and XML, JSON and plan values opened from results), in strip order, and which one is active.
- An untitled tab, or one with unsaved changes, keeps its text and unsaved state. A clean tab with a file keeps only
  its file's path and reopens by reading the file again (a file that is gone is named in a notice). An unsaved tab
  whose file is gone reopens with its text, without the file.
- The tab's name, the user's rename, its line ending, and for a connected query the server name and database.
- Never results, connections, logins, passwords or connection strings.
- Table designers, Database Properties, monitors and other custom tabs are not kept; one with unsaved changes still
  asks. Tabs past the caps (64 tabs, 64 MB as written) are not kept, and those with unsaved changes ask as before.
- Open transactions and running queries are still asked about (the connections close either way).
- If main cannot write the session, the window stays open and the banner says so; nothing is lost.

## Storage

`<userData>/Session/session.json` (`src/main/session-store.ts`): 0700 folder and 0600 file on POSIX, atomic writes,
strict zod schemas on both the request and the file, invalid files quarantined. The next start takes it and renames it
`previous.json`, kept until that run closes (a new session replaces both, or hot exit off deletes both). A run that
crashes after restoring leaves `previous.json`, and the next process's first page reopens it again, while AutoRecover
offers what changed since in its Recover dialog: a restore never loses text. A reload of the page within one process
reopens only a session written since (macOS: closing the window and opening a new one).

AutoRecover is unchanged: a hot-exit close counts as handling every query, so AutoRecover's copies are deleted and the
next start shows no Recover dialog.

## Connections

Reopened tabs are disconnected; nothing auto-connects. A query remembers the server it was on (shown in its tooltip as
"Last connected to …"); its first connection to that server (by name, case-insensitive) keeps its database. Connecting
to another server uses that connection's database. Either way the memory is cleared.

## Rename Tab

- `document.rename`, **Rename Tab…**: the tab menu (`documentTab.context`), the palette, F2 while a tab has focus, and a
  double-click on a tab. The tab shows a text box: Enter or leaving the box keeps the name, Escape keeps the old one.
- Names are trimmed, control characters dropped, at most 128 characters (`tabNameChars`). An empty name, or the name the
  tab would have anyway, takes the rename away.
- The custom name wins wherever the tab is named (tab, close and session prompts, Save As's suggested file name). The
  file's path (or, for an untitled tab, its own name) is in the tooltip. Saving keeps the rename; the saved file's
  name becomes the name the tab returns to if the rename is taken away.
- Save As suggests `<custom name>.<extension>`, in Documents for an untitled tab and beside the file for a saved one.

## Tests

`tests/session-store.test.ts` (store, schemas, limits, Save As suggestion), `tests/hot-exit.test.ts` (rename, keeping,
close flow, restore, remembered database), and `scripts/hot-exit-smoke.mjs` (rename three ways, quit, relaunch).
Other smoke suites run with `VARIA_TEST_HOT_EXIT=0` (the fixture's default) so their save prompts stay.
