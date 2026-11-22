import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { dialogLimits, dialogWindowKinds, type DialogWindowKind } from '../../../shared/popouts'
import type { Platform } from '../../../shared/commands/keybindings'
import { useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { preparePopoutDocument } from './popout-document'
import { windows } from '../core/windows'

/**
 * Dialogs in OS windows of their own (docs/popout-windows.md, "Dialog windows"). Each is the page's same-origin
 * `about:blank` child, as a popout is: main allows only the names `varia-dialog-<kind>-<uuid>`, opens it frameless (macOS:
 * its traffic lights) for the page to draw the title bar, and keeps it above the main window. The dialog's React tree renders into it through a portal,
 * so it keeps the page's services and has no IPC of its own. Where the window cannot open (main refused it, or the page
 * runs without windows, as in unit tests) the dialog shows over the main window as before.
 */
export interface DialogWindowState { readonly inWindow: boolean; readonly platform: Platform; readonly ownerDocument: Document }
/**
 * ⌘W in a dialog window on macOS, which closes a window there: Electron's menu has no Close role for it, so the dialog's
 * own key handler takes it as its Cancel (the workbench's keys stay in its dispatcher, tests/keyboard-lint.test.ts), unless
 * something took it first: a shortcut being recorded.
 */
export const closesDialogWindow = (event: { readonly defaultPrevented: boolean; readonly key: string; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean; readonly currentTarget: { readonly ownerDocument: Document } }, platform: Platform): boolean =>
  platform === 'darwin' && !event.defaultPrevented && event.currentTarget.ownerDocument !== document && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w'
const defaultDocument = (): Document => typeof document !== 'undefined' ? document : ({} as Document)
const DialogWindowContext = createContext<DialogWindowState>({ inWindow: false, platform: 'win32', ownerDocument: defaultDocument() })
export const useDialogWindow = (): DialogWindowState => useContext(DialogWindowContext)

export interface Size { readonly width: number; readonly height: number }
export interface WindowBounds extends Size { readonly x: number; readonly y: number; readonly positioned: boolean }
const maxCoord = 1_000_000
const storageKey = (kind: DialogWindowKind) => 'varia.dialogWindow.' + kind
const storage = (): Storage | undefined => { try { return globalThis.localStorage } catch { return undefined } }
const safeCoord = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= -maxCoord && value <= maxCoord
const safeDim = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= dialogLimits.maxSize
const fitSize = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)))

/**
 * The size a dialog window opens at: the size the user last left it (resizable kinds only), else its kind's default,
 * within its minimum and the screen. If the remembered size would exceed the current screen work area (e.g. saved on a
 * large external display and reopened on a smaller laptop), it resets safely to the default instead of stretching full width.
 */
export function dialogWindowSize(kind: DialogWindowKind, screen: Size, stored: string | null | undefined = storage()?.getItem(storageKey(kind))): Size {
  const limits = dialogWindowKinds[kind]
  const maxWidth = Math.max(limits.minWidth, screen.width - 32), maxHeight = Math.max(limits.minHeight, screen.height - 32)
  let width: number = limits.width, height: number = limits.height
  if (limits.resizable && stored) {
    try {
      const value = JSON.parse(stored) as Partial<Size>
      if (safeDim(value.width) && safeDim(value.height) && value.width <= maxWidth && value.height <= maxHeight) {
        width = value.width; height = value.height
      }
    } catch { /* A damaged cache entry is ignored. */ }
  }
  return { width: fitSize(width, limits.minWidth, maxWidth), height: fitSize(height, limits.minHeight, maxHeight) }
}

/** Centred over the main window, in the page's CSS pixels (main scales them by the zoom). */
export function centredBounds(main: { screenX: number; screenY: number; outerWidth: number; outerHeight: number }, size: Size): Size & { x: number; y: number } {
  return { x: Math.round(main.screenX + (main.outerWidth - size.width) / 2), y: Math.round(main.screenY + Math.max(0, (main.outerHeight - size.height) / 2)), ...size }
}

/**
 * Full window bounds for a dialog window: restores the user's saved position and size when both remain valid and fit
 * within the current screen; otherwise falls back to centred (and default size if the saved size was too large).
 */
export function dialogWindowBounds(
  kind: DialogWindowKind,
  main: { screenX: number; screenY: number; outerWidth: number; outerHeight: number },
  screen: Size,
  stored: string | null | undefined = storage()?.getItem(storageKey(kind))
): WindowBounds {
  const limits = dialogWindowKinds[kind], size = dialogWindowSize(kind, screen, stored)
  if (limits.resizable && stored) {
    try {
      const value = JSON.parse(stored) as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
      const maxWidth = Math.max(limits.minWidth, screen.width - 32), maxHeight = Math.max(limits.minHeight, screen.height - 32)
      if (safeDim(value.width) && safeDim(value.height) && value.width <= maxWidth && value.height <= maxHeight && safeCoord(value.x) && safeCoord(value.y)) {
        return { x: value.x, y: value.y, ...size, positioned: true }
      }
    } catch { /* Ignored below. */ }
  }
  return { ...centredBounds(main, size), positioned: false }
}

/** Remembers a resizable dialog window's size and, when finite integers are provided, its screen coordinates. */
export function rememberDialogWindowBounds(kind: DialogWindowKind, bounds: { readonly x?: number; readonly y?: number; readonly width: number; readonly height: number }): void {
  if (!dialogWindowKinds[kind].resizable) return
  const payload: { width: number; height: number; x?: number; y?: number } = { width: Math.round(bounds.width), height: Math.round(bounds.height) }
  if (typeof bounds.x === 'number' && Number.isFinite(bounds.x) && typeof bounds.y === 'number' && Number.isFinite(bounds.y)) {
    const x = Math.round(bounds.x), y = Math.round(bounds.y)
    if (safeCoord(x) && safeCoord(y)) { payload.x = x; payload.y = y }
  }
  try { storage()?.setItem(storageKey(kind), JSON.stringify(payload)) } catch { /* Storage blocked or full. */ }
}

/** Remembers a resizable dialog window's size for the next time it opens. */
export function rememberDialogWindowSize(kind: DialogWindowKind, size: Size): void {
  rememberDialogWindowBounds(kind, size)
}

interface Host { readonly child: Window; readonly root: HTMLElement; dispose(): void }
function openWindowWithBounds(kind: DialogWindowKind, bounds: Size & { x: number; y: number }): Window | null {
  try {
    return window.open('about:blank', `varia-dialog-${kind}-${crypto.randomUUID()}`, `left=${bounds.x},top=${bounds.y},width=${bounds.width},height=${bounds.height}`)
  } catch {
    return null
  }
}

function openHost(kind: DialogWindowKind, attach: (target: Window) => { dispose(): void }): Host | undefined {
  const screen = { width: window.screen.availWidth, height: window.screen.availHeight }
  const first = dialogWindowBounds(kind, window, screen)
  let child = openWindowWithBounds(kind, first)
  if (!child && first.positioned) child = openWindowWithBounds(kind, centredBounds(window, { width: first.width, height: first.height }))
  if (!child) {
    const fallbackSize = dialogWindowSize(kind, screen, null)
    if (fallbackSize.width !== first.width || fallbackSize.height !== first.height) {
      child = openWindowWithBounds(kind, centredBounds(window, fallbackSize))
    }
  }
  if (!child) return undefined
  let prepared: ReturnType<typeof preparePopoutDocument> | undefined, attached: { dispose(): void } | undefined
  try {
    prepared = preparePopoutDocument(child, document, dialogWindowKinds[kind].title)
    prepared.root.className = 'dialog-window-root'
    child.document.body.className = 'popout-body dialog-window-body'
    attached = attach(child)
  } catch {
    prepared?.dispose(); attached?.dispose(); if (!child.closed) child.close()
    return undefined
  }
  const frame = prepared, listeners = attached
  return { child, root: frame.root, dispose: () => { listeners.dispose(); frame.dispose() } }
}

function readChildBounds(child: Window): { x?: number; y?: number; width: number; height: number } {
  const x = typeof child.screenX === 'number' && Number.isFinite(child.screenX) ? Math.round(child.screenX) : undefined
  const y = typeof child.screenY === 'number' && Number.isFinite(child.screenY) ? Math.round(child.screenY) : undefined
  return { ...x !== undefined && y !== undefined ? { x, y } : {}, width: child.innerWidth, height: child.innerHeight }
}

/**
 * Shows `children` (a dialog's `role="dialog"` element) in a dialog window of `kind`, or over the main window where it
 * cannot open. `onClose` runs when the user closes the window itself (its close button, Alt+F4, ⌘W); `raise` brings an open
 * window forward whenever it changes (Tools › Options… again while it is open).
 */
export default function DialogWindow({ kind, onClose, raise, children }: { readonly kind: DialogWindowKind; readonly onClose: () => void; readonly raise?: unknown; readonly children: ReactNode }) {
  const workbench = useWorkbench()
  // undefined until the window is tried; null when the dialog shows over the main window.
  const [host, setHost] = useState<Host | null>()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useLayoutEffect(() => {
    // A microtask later, so React's development double run (StrictMode) cancels the first before it opens a window.
    let cancelled = false, cleanup: (() => void) | undefined
    queueMicrotask(() => { if (!cancelled) cleanup = open() })
    return () => { cancelled = true; cleanup?.() }
  }, [kind, workbench])
  function open(): (() => void) | undefined {
    // The window the user opened the dialog from: a popout gets its own focus back (the dialog's focus return raises it).
    const opener = windows.active()
    const opened = workbench.dialogWindows ? openHost(kind, target => workbench.attachWindow(target)) : undefined
    setHost(opened ?? null)
    if (!opened) return undefined
    const { child } = opened
    let closing = false, timer: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    let lastSnapshot = ''
    const saveNow = () => {
      if (child.closed) return
      const current = readChildBounds(child)
      const encoded = JSON.stringify(current)
      if (encoded === lastSnapshot) return
      lastSnapshot = encoded
      rememberDialogWindowBounds(kind, current)
    }
    // Once, whichever notices first (pagehide or the poll): a dialog still open after it (a save failed) stays open.
    const closed = () => {
      if (closing) return
      closing = true
      clearInterval(poll)
      closeRef.current()
      // A dialog that stays open (Options while OK saves) shows over the main window from here; one that closed is gone
      // in the same render.
      setHost(current => current === opened ? null : current)
    }
    const resized = () => {
      clearTimeout(timer)
      timer = setTimeout(saveNow, 300)
    }
    child.addEventListener('pagehide', closed)
    child.addEventListener('resize', resized)
    child.addEventListener('blur', saveNow)
    // A window torn down without its pagehide (by the OS, or a crash), which popouts watch for the same way, plus periodic position capture.
    poll = setInterval(() => {
      if (child.closed) closed()
      else saveNow()
    }, 1000)
    return () => {
      closing = true
      clearInterval(poll)
      clearTimeout(timer)
      saveNow()
      child.removeEventListener('pagehide', closed)
      child.removeEventListener('resize', resized)
      child.removeEventListener('blur', saveNow)
      opened.dispose()
      if (!child.closed) child.close()
      // The main window takes the keyboard back for the focus the dialog returns, when the dialog opened from it.
      if (!opener || opener === window) window.focus()
    }
  }
  useEffect(() => { if (raise !== undefined && host && !host.child.closed) host.child.focus() }, [raise, host])
  if (host === undefined) return null
  const state: DialogWindowState = { inWindow: !!host, platform: workbench.platform, ownerDocument: host ? host.child.document : defaultDocument() }
  return <DialogWindowContext.Provider value={state}>
    {host ? createPortal(children, host.root) : <div className="modal-backdrop">{children}</div>}
  </DialogWindowContext.Provider>
}

/**
 * A dialog's heading: in a dialog window, its title bar (dragged to move the window), with its close button or, on macOS,
 * beside the traffic lights; over the main window, the heading with its close button.
 */
export function DialogHeading({ id, title, closeLabel, disabled, onClose }: { readonly id: string; readonly title: string; readonly closeLabel: string; readonly disabled?: boolean; readonly onClose: () => void }) {
  const { inWindow, platform } = useDialogWindow()
  // macOS's traffic lights sit in the title bar; elsewhere the window is frameless and the page draws its close button.
  if (inWindow) return <div className="dialog-titlebar" data-platform={platform}><h2 id={id}>{title}</h2>{platform !== 'darwin' && <button type="button" className="dialog-window-close" aria-label={closeLabel} disabled={disabled} onClick={onClose}><Icon name="close" /></button>}</div>
  return <div className="connection-heading"><h2 id={id}>{title}</h2><button type="button" className="icon-button" aria-label={closeLabel} disabled={disabled} onClick={onClose}><Icon name="close" /></button></div>
}
