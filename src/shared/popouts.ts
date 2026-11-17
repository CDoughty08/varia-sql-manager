/**
 * Popped-out panels (Window › Move into New Window): panels shown in their own OS windows. The page opens each window
 * itself as a same-origin `about:blank` child named `varia-popout-<uuid>` (`window.open`), and main allows only that
 * (`src/main/popout-windows.ts`). docs/popout-windows.md describes the design.
 */
export const popoutWindowName = /^varia-popout-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const popoutLimits = {
  /** Popout windows open at once; there are fewer panels that can pop out than this. */
  maxWindows: 16,
  minWidth: 240,
  minHeight: 160,
  maxSize: 16_000,
  /** How much of a restored window's top edge must be on a display, to grab it there; otherwise its panels dock back. */
  grabWidth: 120,
  grabHeight: 40
} as const

/**
 * Dialog windows: a dialog shown in an OS window of its own (Tools › Options, Help › About) rather than over the main
 * window. The page opens each as a same-origin `about:blank` child named `varia-dialog-<kind>-<uuid>`, as it opens popouts,
 * and main gives it a themed title bar and keeps it above the main window (`src/main/popout-windows.ts`).
 */
export const dialogWindowKinds = {
  options: { title: 'Options', width: 940, height: 680, minWidth: 640, minHeight: 440, resizable: true },
  about: { title: 'About Varia SQL Manager', width: 520, height: 460, minWidth: 420, minHeight: 320, resizable: false }
} as const satisfies Record<string, { readonly title: string; readonly width: number; readonly height: number; readonly minWidth: number; readonly minHeight: number; readonly resizable: boolean }>
export type DialogWindowKind = keyof typeof dialogWindowKinds
export const dialogWindowName = /^varia-dialog-(options|about)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** The kind a dialog window's name says, or undefined when it is not one. */
export const dialogWindowKind = (name: string): DialogWindowKind | undefined => dialogWindowName.test(name) ? name.split('-')[2] as DialogWindowKind : undefined
export const dialogLimits = {
  /** Dialog windows open at once: two per kind, so one can open while the last is still closing. */
  maxWindows: Object.keys(dialogWindowKinds).length * 2,
  maxSize: 16_000
} as const
