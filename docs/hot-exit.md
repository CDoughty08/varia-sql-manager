# Hot exit and query tabs

VS Code-style hot exit: closing Varia SQL Manager keeps the open query tabs instead of asking to save them, and the next
start reopens them. Tabs can be renamed without saving a file. Agreed with the owner on 2026-11-04 (tabs/docking
roadmap: "name tabs without saving, remembered between sessions").

## Setting

Tools › Options › Environment › Documents › **Restore open queries on startup** (`environment.documents.hotExit`), on by
default. While it is off, pinned tabs still reopen, and a close asks about unsaved changes in unpinned tabs.

## Pinned shelf

- The pin button moves a query or other text tab to the shelf above the unpinned tabs. Click it again to unpin the tab.
  Drag or use Move Left and Move Right to reorder tabs within either shelf.
- Hold Ctrl and scroll down over either shelf to add rows there. Scroll up to remove rows. The row buttons do the same,
  and the overflow button lists tabs that are out of view.
- The SID badge to the right of a query name shows its SQL Server session ID as soon as execution acquires a session.
  A dash means there is no known live session. Restored queries start disconnected.
- View › Reload Window keeps pinned tabs and reopens them disconnected. Unpinned tabs follow the workbench's existing
  reload and AutoRecover behavior. The checkpoint uses the pinned text as the page unloads, including edits made
  while a reload is pending.
- If the renderer crashes while reopening tabs at startup or after Reload Window, choosing Reload in the crash dialog
  retries the same checkpoint, including its unsaved text.

## What a close keeps

- Every text tab (queries, and XML, JSON and plan values opened from results), in strip order, including which are
  pinned and which one is active. Pinned tabs are first in their group's strip.
- The editor groups the kept tabs are in, when there are two or more (docs/editor-groups.md, *Persistence*): splits,
  sizes, floating groups and each group's shown tab, naming tabs by their place in the kept list.
- An untitled tab, or one with unsaved changes, keeps its text and unsaved state. A clean tab with a file keeps only
  its file's path and reopens by reading the file again (a file that is gone is named in a notice). An unsaved tab
  whose file is gone reopens with its text, without the file.
- A kept buffer with a file carries the disk fingerprint it was based on. With external-change detection enabled,
  saving asks before replacing newer disk contents. Older kept buffers without a fingerprint also ask before replacing an existing file.
- The tab's name, the user's rename, its line ending, and for a connected query the server name and database.
- Never results, connections, logins, passwords or connection strings.
- Table designers, Database Properties, monitors and other custom tabs are not kept; one with unsaved changes still
  asks. Unpinned tabs past the caps (64 tabs, 64 MB as written) are skipped, and those with unsaved changes still ask.
  If a pin cannot be kept, Varia leaves the window open and names the tab.
- Open transactions and running queries are still asked about (the connections close either way).
- If main cannot write the session, the window stays open and the banner says so; nothing is lost.

## Storage

`<userData>/Session/session.json` (`src/main/session-store.ts`): 0700 folder and 0600 file on POSIX, atomic writes,
strict zod schemas on both the request and the file, invalid files quarantined. The next start takes it and renames it
`previous.json`, kept until that run closes. A new session replaces both, or a close with nothing to reopen deletes both. A run that
crashes after restoring leaves `previous.json`, and the next process's first page reopens it again, while AutoRecover
offers what changed since in its Recover dialog: a restore never loses text. A renderer crash after the restore is the
same: Reload in the crash dialog reopens `previous.json` (it holds the only copy of the restored text until a close keeps
the tabs again or AutoRecover's interval comes round), and a later close then keeps or asks about those tabs as usual.
A reload of the page within one process otherwise reopens only a session written since (macOS: closing the window and
opening a new one).

AutoRecover is unchanged: a hot-exit close counts as handling every query, so AutoRecover's copies are deleted and the
next start shows no Recover dialog.

## Windows shutdown, restart and log off

Windows ends its session without the quit that starts the close everywhere else (Electron emits no `before-quit`), so
main handles the window's `query-session-end`: it asks the page for AutoRecover's copies of every unsaved query at once
(`file.autoRecoverNow`, whatever the interval; nothing while AutoRecover is off), holds the end, and asks the page to
close as a quit does. Hot exit then keeps the tabs, or with it off the unsaved-query prompts ask, and the app quits once
the close is done, which lets Windows go on. While a prompt is open, Windows shows that Varia SQL Manager is keeping it
from ending; Cancel there leaves the app open, and Shut down anyway ends it with AutoRecover's copies kept. A critical end
does not wait, so it is not held. `session-end` (the end can no longer wait) asks once more for AutoRecover's copies.

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
close flow, restore, remembered database), `tests/close-intent.test.ts` (which session ends are held),
`tests/recovery-service.test.ts` (`file.autoRecoverNow`), and `scripts/hot-exit-smoke.mjs` (rename three ways, quit,
relaunch, crashes during and after a restore, a Windows session end).
Other smoke suites run with `VARIA_TEST_HOT_EXIT=0` (the fixture's default) so their save prompts stay.
