# Editor groups

The query editor panel holds the open documents in editor groups, as VS Code does: each group has its own tab strip and
Monaco editor, and groups split side by side, stack, or float over the editor area.

## In the editor

- **Per-query bar.** Each SQL document mounts its own `QueryBar` directly below its editor group's tab strip (unless
  the classic toolbar is enabled), scoped to that tab's connection, database/dataset, selection and execution state.
  Split editor groups show independent query bars side by side; clicking any control in an inactive group's bar
  activates that group first and preserves focus return to its editor, while switching to non-query documents (Activity
  Monitor, Table Designer, Properties, XML/JSON values) leaves the tab strip anchored at the top with no vertical jump.
  Connected bars paint a `1 px` top hairline, soft leading wash and tinted connection-pill border from the connection's
  color (neutral when unset), and show the connection's friendly alias in the collapsed server box with full host
  details in the dropdown options and tooltip.
- **Execute, Cancel and Plan menu.** While idle, the primary button reads **Execute** (paired with a muted **All** scope
  pill) or, with text selected, **Run Selection** paired with a warning-tinted line-range pill (`Line N` / `Lines N–M`; a
  click inside the selection clears it and places the caret). While that tab's query is running, the primary button
  morphs in place into an error-tinted **Cancel** button with a live elapsed timer (`1.4s`), keeping keyboard focus across
  the transition. One unified **Plan ▾** menu consolidates **Include Actual Plan**, **Include Live Plan**, and
  **Display Estimated Plan** with distinct icons and active trigger labels (`Plan`, `Actual Plan`, `Live Plan`, or
  `Actual + Live`); the classic toolbar keeps its existing separate buttons (`QueryBar.tsx`).
- **Zoom.** Ctrl+wheel over the editor (Cmd+wheel also works on macOS) enlarges or shrinks the text in every editor tab
  for this session. The **View** menu's zoom commands resize the whole workbench.
- **Documents without query output.** Activity Monitor, Properties, Table Designer, New Database, the SSIS pages and
  values opened from the results have no query output, so while one is active the Results, Messages and Execution plan
  panels docked below the editor hide and it fills the area. They come back at their size when a query is active.
  While a query shows in another editor group the panels stay. Output panels you moved elsewhere, floated or put in their
  own window stay where they are, as do panels with another panel docked below or beside them. **Window › Results** or
  **Toggle Results Pane** (Ctrl+R) shows the docked panels over such documents until a query is active again.
- **Status bar.** Click **Ln/Col** to go to a line, or **INS/OVR** to switch between insert and overtype mode.
- **SSMS query shortcuts.** SSMS's Alt+F1 `sp_help`, Ctrl+1 `sp_who` and Ctrl+2 `sp_lock` are the palette commands
  **New Query with sp_help**, **New Query with sp_who** and **New Query with sp_lock**. Each opens a new query on the
  connection and database New Query would use, holding the `EXEC` call, ready to run with F5. `sp_lock` is deprecated
  and does not exist in Azure SQL Database; query `sys.dm_tran_locks` there. The commands have no keys: Ctrl+1 to Ctrl+9
  (Cmd on macOS) pick query tabs and results, and Alt+F1 opens the desktop menu on some Linux desktops.

## Model

- **Editor area.** `src/renderer/src/editor-groups/EditorArea.tsx` is a Dockview nested in the workspace's "Query editor"
  panel. Each open document is one of its panels (panel id = document id); Dockview's tab element is the document's tab
  (role `tab`, name, selection, roving focus). Each group's pinned and unpinned shelves share a `tablist` named "Query
  documents", and each group is a region named "Editor group: " plus its shown document's name.
- **Tab keys.** Left, Right, Home and End on a focused tab choose the tab they reach (focus restored by a closing menu, or
  a right-click, chooses nothing); Delete or Backspace is File › Close. These are catalogue keys KeybindingService takes
  before Dockview. Keys on a focused tab (Delete, Ctrl+W, F2, Split Editor, the moves) act on that tab, shown or not:
  KeybindingService passes it as `tabId` (`keyArgs`) to the query tab menu's commands only (`actsOnTab`,
  `EditorGroupService.focusedDocument`). Other keys, such as F5, follow the shown document; menus and the palette act on
  the shown document even when a closing menu put focus on another tab.
- **One view per document.** A document is in exactly one group; Split Editor moves it into a new group, so its group
  must keep another tab. Two views of one model are not supported.
- **Order.** `DocumentService` lists open documents and the active one, ordered by the grid's groups, then floating ones,
  each in tab order. Ctrl+Tab, hot exit and AutoRecover keep that order.
- **Service.** `EditorGroupService` (`src/renderer/src/services/editor-groups.ts`) publishes the groups
  (`EditorGroupSnapshot`) and carries commands' moves to the editor area, the source of truth. Without an editor area
  (unit tests) the documents form one group.
- **Editors.** Each group creates its editor (`editor/create-editor.ts`) the first time it shows a text document; the
  editor moves into the panel shown and goes with the group. `DocumentService.showIn` swaps models and keeps each
  document's view state. Custom documents (Table Designer, properties, monitors, Object Search) render their own views.
- **Active document** is the active group's shown document; Results, Messages, the classic toolbar, the status bar's Ln
  and Col and every editing command follow it, while each visible SQL document keeps its own scoped `QueryBar`.
- **Focus** follows a new or moved document: focus requested before the group's editor shows it waits, unless focus goes
  elsewhere first (`dropPendingFocus`). A group editor moving into another panel takes the keyboard only when it had it,
  or when focus fell to the page from the editor area (menus, palette and dialogs aside). Focus in Object Explorer or a
  toast stays.
- **Limit.** At most 16 groups (`editorGroupLimits`); a drop that would make a 17th puts its documents back in the active
  group, with a warning.

## Moving documents

Drag a tab along a strip to reorder, onto another strip to move, onto the docking compass (the workspace's SSMS-style
guides over the group under the pointer) to tab into that group or split it, or Shift-drag to float. The drag stays inside
the window. While a workspace panel is dragged, the editor area ignores the pointer so the workspace's guides answer.

Commands (`src/shared/commands/catalog.ts`; Ctrl+1–9 pick query tabs as a browser's do, Go to Query 1 to 8 and Go to
Last Query, or results while focus is in the results pane):

| Command | Keys (Windows/Linux) | Keys (macOS) | Where |
| --- | --- | --- | --- |
| Split Editor Right | Ctrl+\ | Cmd+\ | Window menu, tab menu |
| Split Editor Down | Ctrl+K Ctrl+\ | Cmd+K Cmd+\ | Window menu, tab menu |
| Move Editor into Next Group | Ctrl+Alt+Right | Ctrl+Cmd+Right | tab menu |
| Move Editor into Previous Group | Ctrl+Alt+Left | Ctrl+Cmd+Left | tab menu |
| Focus Next Editor Group | Ctrl+K Ctrl+Right | Cmd+K Cmd+Right | palette |
| Focus Previous Editor Group | Ctrl+K Ctrl+Left | Cmd+K Cmd+Left | palette |
| Join All Editor Groups | | | Window menu |
| Float Editor / Dock Editor | | | tab menu |

- Move Left and Move Right (Ctrl+Shift+PageUp/PageDown) move a tab within its strip. Move Editor into Next Group past the
  last group opens a new group on the right. Split Editor needs another tab in the group; the palette's greyed row says
  so.
- **Shelves.** Pinned text tabs sit on a dedicated shelf above the unpinned ones, distinguished by layout and accent pin
  buttons, not labels. Document tabs use the refined 2-line height (`40 px` Compact / `44 px` Comfortable) with a
  `196 px` default cell width target, omit the session chip when a query has no live SPID or remembered disconnected
  server, and keep Pin and Close in fixed `20 px` slots so buttons never shift horizontally on hover. Ctrl+scroll down
  over a shelf adds rows, up removes them; **Increase/Decrease Tab Stack Height** in a tab's menu change its shelf, in
  the palette the active document's. A brief hint reports the row count, when all tabs fit, or the one-row minimum. A
  one-row shelf scrolls horizontally; a taller one uses its last slot for **… N more**, listing tabs outside the shown
  rows (its entries have no tab context menu). Row counts and scroll positions are independent per shelf and group.
  Stacks can grow until every tab fits, with no window-height cap; a header taller than its group scrolls vertically
  (Ctrl+scroll still changes the height), and keyboard selection and rename reveal the tab.
- **Pins** stay first in their group's order (`EditorAreaController.keepPinsFirst`, after every layout change and
  reconcile); Move Left and Right never cross that boundary. A pinned tab dragged to another group joins its pinned shelf.
  Pins survive hot exit and Reload Window with the groups (docs/hot-exit.md).
- **Closing** a group's shown document shows the next one in that group (the one before at the strip's end):
  `DocumentService` asks `EditorGroupService.successor`, so the active document changes once. An emptied group goes and
  the next document in order shows. A tab closed while focused hands focus to the tab shown next.
- **New query.** Each group's **+**, or a double-click on empty strip space, opens a new query there with the shown
  document's server and database and focuses it (double-clicking a tab renames it). Ctrl+N (Cmd+N on macOS) also works.
- **Reopen Closed Query** (File or a tab's menu; Ctrl+Shift+T, Cmd+Shift+T on macOS) reopens the last successfully closed
  SQL query as an **unsaved, disconnected copy** with its name, text, first caret, line ending and database, but no saved
  file, SQL session, transaction or results (Save asks for a file). Reconnecting to its remembered server keeps the
  database. The in-memory history holds at most 20 queries and 4,000,000 text characters in total, oldest discarded first,
  omitting a query larger than the budget. Value and custom tabs are excluded; the history ends when the workbench window
  closes.

## Floating and popouts

- Float Editor puts a document in a floating group over the editor area (inside the main window) with its own strip and
  editor; Dock Editor puts it back. Float Editor never floats the only docked document, but Dockview's own float
  (Shift-drag, a tab released outside the area) can; the grid then keeps an empty group saying the open queries float,
  with Dock query, until another grid group shows a document or no document is left. At the 16-group cap there is no room
  for that group, so the floating group docks once the Shift-drag is released (`afterPointer`, also released by window
  blur). Hot exit keeps such a layout as an empty grid plus its floating groups.
- Documents do not pop out into OS windows: Monaco binds its DOM, focus, IME, clipboard and workers to the window that
  created it (docs/popout-windows.md, *Limits*). The tab menu has no Move to New Window, and dragging a tab out of the
  window floats it instead.

## Persistence

- Hot exit (docs/hot-exit.md) keeps the groups with the documents it keeps, as a compact tree naming each document by its
  place in the kept list (`EditorGroupsLayout`, `src/shared/editor-groups.ts`), since document ids do not outlive the
  process. Main validates it (`editorGroupsLayoutSchema`: limits, documents unique across groups, active documents inside
  their groups) and remaps places as tabs are dropped or files are gone. Emptied groups go; a split left with one child
  gives way to it.
- Each group's requested pinned and unpinned stack heights are saved, including a single group with nondefault heights. A
  wider group or fewer tabs may use fewer rows without discarding the preference. An ordinary single group is not kept:
  document order already describes it.
- Workspace layouts (`workspace-layouts.json`) arrange the workspace's panels; the editor groups live inside the "Query
  editor" panel and need no migration.
- Custom documents are not kept by hot exit, so their places in the groups are not either.
