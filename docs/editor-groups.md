# Editor groups

The query editor panel holds the open documents in editor groups, as VS Code does: each group has its own tab strip and
its own Monaco editor, and groups split side by side, stack, or float over the editor area. Agreed with the owner on
2026-11-04 (tabs/docking roadmap: "groups after drag-to-split").

## Model

- The editor area (`src/renderer/src/editor-groups/EditorArea.tsx`) is a Dockview instance nested in the workspace's
  "Query editor" panel. Every open document is one of its panels; the panel id is the document id. Dockview's tab
  element is the document's tab (role `tab`, name, selection, roving focus). Each strip is a `tablist` named "Query
  documents". Left, Right, Home and End on a focused tab choose the tab they reach (focus restored by a closing menu,
  or a right-click, chooses nothing), and Delete or Backspace there is File › Close (catalogue keys, which KeybindingService takes
  before Dockview's own).
  Each group is a region named "Editor group: " and its shown document's name, apart from the document's own regions.
- One view per document: a document is in exactly one group. Split Editor moves the document into a new group, so a
  group must keep another tab to split. Two views of one model (VS Code's split of the same file) are follow-up work.
- `DocumentService` stays the list of open documents and the active one. Its order follows the groups: the grid's
  groups in order, then the floating ones, each in tab order. Ctrl+Tab, hot exit and AutoRecover keep that order.
- `EditorGroupService` (`src/renderer/src/services/editor-groups.ts`) publishes the groups (`EditorGroupSnapshot`) and
  carries the commands' moves to the editor area, which is the source of truth for the arrangement. Without an editor
  area (unit tests), the documents form one group.
- Each group creates its editor (`editor/create-editor.ts`) the first time it shows a text document. The editor moves
  into the panel the group shows as its tab is chosen, and goes when the group does. `DocumentService.showIn` swaps
  models and keeps each document's view state, as tab switches did with the single editor. Custom documents (Table
  Designer, properties, monitors, Object Search) render their own views in their panels.
- The active document is the active group's shown document. Results, Messages, the query bar, the status bar's Ln and
  Col, and every editing command follow it.
- Focus follows a new or moved document: a focus asked for before its group's editor shows it waits at most a second
  (`pendingFocusMs`), and a group editor that moves into another panel takes the keyboard only when it had it, or when
  focus fell to the page from the editor area (menus, the palette and dialogs aside). Focus elsewhere, Object Explorer or
  a toast, stays where it is.
- At most 16 groups (`editorGroupLimits`); a drop that would make a 17th puts its documents back in the active group,
  with a warning.

## Moving documents

- Drag a tab along a strip to reorder it, onto another strip to move it, onto the docking compass (the workspace's
  SSMS-style guides, shown over the group under the pointer) to tab into that group or split it on a side, or
  Ctrl-drag it to float. Dockview's pointer drag runs inside the window. While a workspace panel is being dragged, the
  editor area ignores the pointer, so the workspace's own docking guides are the ones that answer.
- Commands (`src/shared/commands/catalog.ts`; keys avoid SSMS's: Ctrl+1–9 stay query shortcuts):

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

  Move Left and Move Right (Ctrl+Shift+PageUp/PageDown) move a tab along its own group's strip. Move Editor into Next
  Group past the last group opens a new group on the right, as VS Code does. Split Editor needs another tab in the
  document's group; the palette's greyed row says so.
- Closing a group's shown document shows the next one in that group (the one before at the strip's end), as VS Code
  does: `DocumentService` asks `EditorGroupService.successor`, so the active document changes once. A group left empty
  goes, and the next document in order shows. A tab closed while it had focus hands focus to the tab shown next.

## Floating and popouts

- Float Editor puts a document in a floating group over the editor area, inside the main window, with its own strip
  and editor; Dock Editor puts it back into the grid. The grid keeps a document: the only one docked does not float.
- Documents do not pop out into OS windows. Monaco binds its DOM, focus, IME, clipboard and workers to the window that
  created it (docs/popout-windows.md, *Limits*). The tab menu therefore has no Move to New Window, and dragging a tab
  out of the window floats it inside the window instead.

## Persistence

- Hot exit (docs/hot-exit.md) keeps the groups with the documents it keeps: a compact tree that names each document
  by its place in the kept list (`EditorGroupsLayout`, `src/shared/editor-groups.ts`), because Dockview names panels by
  document id and ids do not outlive the process. Main validates it (`editorGroupsLayoutSchema`: limits, documents
  unique across groups, active documents inside their groups) and remaps the places as tabs are dropped or files are
  gone. Groups left empty go, and splits left with one child give way to it. One group is not kept: the order says it
  all.
- Workspace layouts (`workspace-layouts.json`) are unchanged: they arrange the workspace's panels, and the editor
  groups live inside the "Query editor" panel. Old layouts need no migration.
- Custom documents are not kept by hot exit, so their places in the groups are not kept either.

## Later

- Dockview 8.4's tab groups (Chrome-style named, coloured tab groups within a strip) can build on the same model: a tab
  group belongs to one editor group, and `EditorGroupsLayout` can grow an optional `tabGroups` list per leaf without
  breaking older sessions.
