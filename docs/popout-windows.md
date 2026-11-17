# Popout windows

A dock panel can move into an OS window of its own, as VS Code's **Move Editor into New Window**: its tab's menu
(**Move into New Window**), or dragging its tab past the edge of the main window. **Move Back into Main Window** (the tab
menu, the window's header button, or dragging its tab onto the main window, where the docking compass shows) docks it
where it was, or where it is dropped. Closing a popout docks its panels back; closing or reloading the main window closes
every popout.

Panels that can pop out: Object Explorer, Results, Messages, Execution plan and Client Statistics (`popoutPaneIds` in `src/shared/layouts.ts`).
The query editor cannot (see *Limits*).

## Trust model

Main denies every `window.open` and navigation except exactly two kinds of child window: popouts, and the dialog windows
described under [Dialog windows](#dialog-windows), which follow the same rules with their own name and window options.

- **Only the trusted page's popouts.** `setWindowOpenHandler` on the main window answers `allow` only for `about:blank`,
  disposition `new-window`, a frame name `varia-popout-<uuid>` and features exactly `left=…,top=…,width=…,height=…` within
  `popoutLimits` (`src/shared/popouts.ts`), at most 16 windows (counting those allowed but not yet created), on a display's work area (`popoutRequest`, `onDisplay` in
  `src/main/popout-windows.ts`). Everything else is denied.
- **Explicit preferences, not inherited ones.** The child gets `preload: undefined`, `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, `webviewTag: false` and no `additionalArguments` (no test seams).
- **Same origin, same process, same CSP.** An `about:blank` child of the page is the page's origin (`app://varia` in a
  built app, never `file:`; the development server's origin in `npm run dev`) and inherits its CSP; it runs in the page's
  renderer process, so the sandbox is unchanged.
- **No IPC of its own.** It has no preload, so no `window.varia`. Its content is the main page's DOM, rendered through
  React portals: every call still comes from the main window's main frame, and `trusted()` is unchanged.
- **No popups and no navigation.** Each popout's own window-open handler denies, and `will-navigate`,
  `will-frame-navigate` and `will-redirect` are prevented.
- **Lifetime.** Main destroys every popout when the page reloads, crashes or closes (`resetRendererState`), and the page
  ends them on `pagehide`.

## How a panel moves

`DockWorkspace` opens the window (`window.open`), copies the page's style sheets and `<html>` attributes into it
(`popouts/popout-document.ts`, kept in sync by MutationObservers, so the theme, density, forced colors and zoom follow),
and renders a `PopoutFrame` into it through a portal. The panel's host element (the same element Dockview showed) moves
into the popout's slot, so its React state, grid and live subscriptions survive the move.

Each window is a full citizen (`core/windows.ts`, `workbench.attachWindow`):

- `KeybindingService` and `MenuService` listen in every window; menus, the quick input and tooltips render in the window
  the user is in (`windows.activeDocument()`), and close when that window does.
- Focus tracking, context keys and `edit.*` commands read the active window's focused element.
- ResizeObserver and IntersectionObserver are per window, so `observeResize` and `observeIntersection` bind again
  whenever content moves; the grid takes `devicePixelRatio` from its current window.
- Main counts each popout's own input for Paste (`UserActivation` per window), runs roles (Copy, Paste, Select All…) in
  the focused popout, shows macOS context menus in it, and mirrors the main window's zoom into it. Reload and zoom act on
  the main window.
- While any popout is open the main window's background throttling is off, so its timers run when minimized. Next-frame
  work (result pages, the results view, Object Explorer's updates) asks every open window for a frame and runs on the
  first to draw (`requestFrame`). Because the page then always reports itself visible, main tells it when the main window
  is minimized or hidden (`onMainWindowHidden`): its live views pause, and Object Explorer's status views keep sampling
  only while Object Explorer is in a popout (`LiveOwner.popout`).
- When Chromium zooms a window, main applies that zoom to every window. Wheel zoom over the query editor changes the editor font size.
- `raisePopout(name)` (`varia:popout-raise`, trusted IPC; the name must match `varia-popout-<uuid>`) brings that popout to
  the top, restored if minimized, without activating it (`moveTop`, `showInactive`). Where `showInactive` leaves it
  minimized (macOS, some Linux window managers), main restores it and returns focus to the main window, again if the
  popout takes focus within 2 s (`restoreFocusMs`), since macOS activates it only after its animation. Search Objects'
  Reveal uses it so a popped-out Object Explorer comes forward while focus stays in the hits (`window.focus()` would take
  focus).
- A dialog over the main window opened from a popout brings the main window to the front (`watchModals`); closing it
  gives focus back to the popout element that had it, bringing the popout forward (`focusToReturn`, `returnFocusTo`).
  Dialog windows (below) open in a window of their own instead.

## Dialog windows

Tools › Options and Help › About open in OS windows of their own (`src/renderer/src/popouts/DialogWindow.tsx`), so they
can move off the main window, onto another display.

- **Same trust model.** Each is a same-origin `about:blank` child named `varia-dialog-<kind>-<uuid>`, where the kind is
  `options` or `about` (`dialogWindowKinds` in `src/shared/popouts.ts`), with exact bounds at least the kind's minimum
  size on a display (`dialogRequest`). It gets the popouts' explicit preferences (no preload, sandboxed, isolated, no
  Node, no test arguments), denies popups and navigation, has no IPC of its own and closes with the page. At most four
  are open at once (two of a kind while one closes), and they do not count against the popout limit.
- **Themed, like the main window.** The page draws the title bar (`DialogHeading`) in the theme's colours, dragged to
  move the window. On Windows and Linux the window is frameless and the title bar has its own close button; macOS keeps
  its traffic lights (`titleBarStyle: 'hidden'`) with only close enabled (`minimizable` and `maximizable` are off). Main
  makes the window a child of the main window (`setParentWindow`), so it stays above it and closes with it.
- **Theme changes wait for a closing window.** Electron 45 can crash when the theme source changes while it is still
  tearing down a child window that has just closed, so main holds `nativeTheme.themeSource` changes until no child window
  has closed in the last half second (`PopoutWindows.settled`, `settledNativeTheme`); popouts benefit too.
- **Modeless.** The workbench keeps working in the main window while a dialog window is open. Keys pressed in the
  dialog window are the dialog's: `modalOpen` (`core/modal.ts`) holds the workbench's keys there and not in the main
  window. Tools › Options… while Options is open brings its window forward on the page asked for.
- **Size.** Options opens at 940 × 680, at least 640 × 440, and can be resized; the size it was left at is kept in
  `localStorage` (`varia.dialogWindow.options`), a cache with no IPC, as the palette's history is, and reopens within the
  screen. About has a fixed size. A window opens centred on the main window.
- **Closing.** The window's close button, Alt+F4 or ⌘W is the dialog's Cancel (while OK is saving, Options moves over
  the main window until the save finishes); closing the dialog closes its window
  and gives focus back to where it was, in the main window or the popout it opened from (or to a dialog opened over the
  main window meanwhile). A window torn down without its `pagehide` (by the OS, or a crash) is noticed within a second,
  as a popout's is.
- **Their own document.** Code inside a dialog reads its element's `ownerDocument` (or `windows.activeDocument()`), never
  the global `document`, and tests elements with `isElement` and `tagName` (`core/focus.ts`): `instanceof HTMLElement`
  is false for another window's elements, as in popouts.
- **Fallback.** Where main refuses the window (no display under the main window, or at the window limits), or the page runs without windows
  (unit tests), the dialog shows over the main window as before, with its own close button.

Other dialogs (Connect, object dialogs, properties) still show over the main window; they can move to dialog windows
by adding a kind to `dialogWindowKinds` and wrapping their dialog in `DialogWindow`.

## Layout

The workspace layout is version 3: Dockview's layout plus `windows`, each with an id, its panels (1 to 4), the selected
one, and bounds within `popoutLimits` (`src/shared/layouts.ts`), in the page's CSS pixels: main scales them by the zoom
to place the window in screen DIPs. A panel appears at most once across the dock and the windows. Versions 1 and 2 still
load. On restore, a window whose bounds no longer land on a display (the monitor is gone) is denied by main and its
panels dock back. A moved or resized window is saved within a second. The close flow's last write keeps the windows:
popouts the close itself takes (a quit closes every window, in any order) change nothing, unless the close is cancelled,
when their panels dock back.

## Limits

- **The query editor stays in the main window.** Monaco binds its DOM, focus, clipboard, IME, accessibility and worker
  plumbing to the window it was created in; moving its element to another document breaks input and measuring. Single
  documents likewise split and float within the editor area (docs/editor-groups.md) but do not pop out.
- Toasts, and dialogs other than Options and About, render in the main window (such a dialog brings it to the front).
- Live charts draw on the main window's animation frames.
- Object Explorer's status views in a minimized popout keep sampling: only the main window's minimizing is reported.
- F10 and Alt in a popout go to the system (no menu bar there); the menu bar's access keys work only in the main window.
- **Reset Window Layout** leaves popped-out panels where they are.
