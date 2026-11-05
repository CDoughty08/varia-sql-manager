/**
 * Popped-out panels (Window › Move into New Window): panels shown in their own OS windows. The page opens each window
 * itself as a same-origin `about:blank` child named `varia-popout-<uuid>` (`window.open`), and main allows only that
 * (`src/main/popout-windows.ts`). docs/popout-windows.md describes the design.
 */
export const popoutWindowName = /^varia-popout-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const popoutLimits = {
  /** Popout windows open at once; there are fewer panels that can pop out than this. */
  maxWindows: 8,
  minWidth: 240,
  minHeight: 160,
  maxSize: 16_000,
  /** How much of a restored window's top edge must be on a display, to grab it there; otherwise its panels dock back. */
  grabWidth: 120,
  grabHeight: 40
} as const
