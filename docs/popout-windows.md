# Popout windows

A dock panel can move into an OS window of its own, as VS Code's **Move Editor into New Window**: its tab's menu
(**Move into New Window**), or dragging its tab past the edge of the main window. **Move Back into Main Window** (the tab
menu, the window's header button, or dragging its tab onto the main window, where the docking compass shows) docks it
where it was, or where it is dropped. Closing a popout docks its panels back; closing or reloading the main window closes
every popout.

Panels that can pop out: Object Explorer, Results, Messages and Execution plan (`popoutPaneIds` in `src/shared/layouts.ts`).
The query editor cannot (see *Limits*).

## Trust model

Main used to deny every `window.open` and block every navigation. It now allows exactly one kind of child window, and
nothing else changes:

- **Only the trusted page's popouts.** `setWindowOpenHandler` on the main window answers `allow` only for `about:blank`,
  disposition `new-window`, a frame name `varia-popout-<uuid>` and features exactly `left=…,top=…,width=…,height=…` within
  `popoutLimits` (`src/shared/popouts.ts`), at most 8 windows, on a display's work area (`popoutRequest`, `onDisplay` in
  `src/main/popout-windows.ts`). Everything else is denied as before.
- **Explicit preferences, not inherited ones.** The child gets `preload: undefined`, `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, `webviewTag: false` and no `additionalArguments` (no test seams).
- **Same origin, same process, same CSP.** An `about:blank` child of the page is the page's origin and inherits its CSP;
  it runs in the page's renderer process, so the sandbox is unchanged.
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
  the user is in (`windows.activeDocument()`).
- Focus tracking, context keys and `edit.*` commands read the active window's focused element.
- ResizeObserver and IntersectionObserver are per window, so `observeResize` and `observeIntersection` bind again
  whenever content moves; the grid takes `devicePixelRatio` from its current window.
- Main counts each popout's own input for Paste (`UserActivation` per window), runs roles (Copy, Paste, Select All…) in
  the focused popout, shows macOS context menus in it, and mirrors the main window's zoom into it. Reload and zoom act on
  the main window.
- While any popout is open the main window's background throttling is off, so its timers and frames (which drive the
  popouts' content) keep running when it is minimized.

## Layout

The workspace layout is version 3: Dockview's layout plus `windows`, each with an id, its panels (1 to 4), the selected
one, and bounds within `popoutLimits` (`src/shared/layouts.ts`). A panel appears at most once across the dock and the
windows. Versions 1 and 2 still load. On restore, a window whose bounds no longer land on a display (the monitor is gone)
is denied by main and its panels dock back.

## Limits

- **The query editor stays in the main window.** Monaco binds its DOM, focus, clipboard, IME, accessibility and worker
  plumbing to the window it was created in; moving its element to another document breaks input and measuring. Popping
  it out needs a second editor instance per window sharing the model, which is follow-up work.
- App-modal dialogs and toasts stay in the main window, which a popout's command raises.
- Live charts draw on the main window's animation frames.
- Saved bounds are CSS pixels; a different zoom after restart moves them slightly.
- F10 and Alt in a popout go to the system (no menu bar there); the menu bar's access keys work only in the main window.
- **Reset Window Layout** leaves popped-out panels where they are.
