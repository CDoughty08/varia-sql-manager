import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { dialogWindowKinds, type DialogWindowKind } from '../../../shared/popouts'
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
export interface DialogWindowState { readonly inWindow: boolean; readonly platform: Platform }
/**
 * ⌘W in a dialog window on macOS, which closes a window there: Electron's menu has no Close role for it, so the dialog's
 * own key handler takes it as its Cancel (the workbench's keys stay in its dispatcher, tests/keyboard-lint.test.ts), unless
 * something took it first: a shortcut being recorded.
 */
export const closesDialogWindow = (event: { readonly defaultPrevented: boolean; readonly key: string; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean; readonly currentTarget: { readonly ownerDocument: Document } }, platform: Platform): boolean =>
  platform === 'darwin' && !event.defaultPrevented && event.currentTarget.ownerDocument !== document && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w'
const DialogWindowContext = createContext<DialogWindowState>({ inWindow: false, platform: 'win32' })
export const useDialogWindow = (): DialogWindowState => useContext(DialogWindowContext)

export interface Size { readonly width: number; readonly height: number }
const storageKey = (kind: DialogWindowKind) => 'varia.dialogWindow.' + kind
const storage = (): Storage | undefined => { try { return globalThis.localStorage } catch { return undefined } }
/**
 * The size a dialog window opens at: the size the user last left it (resizable kinds only, a cache in localStorage, as the
 * palette's history is), else its kind's default, within its minimum and the screen.
 */
export function dialogWindowSize(kind: DialogWindowKind, screen: Size, stored: string | null | undefined = storage()?.getItem(storageKey(kind))): Size {
  const limits = dialogWindowKinds[kind]
  let width: number = limits.width, height: number = limits.height
  if (limits.resizable && stored) {
    try {
      const value = JSON.parse(stored) as Partial<Size>
      if (Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height)) { width = value.width!; height = value.height! }
    } catch { /* A damaged cache entry is ignored. */ }
  }
  const fit = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)))
  return { width: fit(width, limits.minWidth, screen.width - 32), height: fit(height, limits.minHeight, screen.height - 32) }
}
/** Remembers a resizable dialog window's size for the next time it opens. */
export function rememberDialogWindowSize(kind: DialogWindowKind, size: Size): void {
  if (!dialogWindowKinds[kind].resizable) return
  try { storage()?.setItem(storageKey(kind), JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) })) } catch { /* Storage blocked or full: the default applies next time. */ }
}
/** Centred over the main window, in the page's CSS pixels (main scales them by the zoom). */
export function centredBounds(main: { screenX: number; screenY: number; outerWidth: number; outerHeight: number }, size: Size): Size & { x: number; y: number } {
  return { x: Math.round(main.screenX + (main.outerWidth - size.width) / 2), y: Math.round(main.screenY + Math.max(0, (main.outerHeight - size.height) / 2)), ...size }
}

interface Host { readonly child: Window; readonly root: HTMLElement; dispose(): void }
function openHost(kind: DialogWindowKind, attach: (target: Window) => { dispose(): void }): Host | undefined {
  const size = dialogWindowSize(kind, { width: window.screen.availWidth, height: window.screen.availHeight })
  const { x, y, width, height } = centredBounds(window, size)
  let child: Window | null = null
  try { child = window.open('about:blank', `varia-dialog-${kind}-${crypto.randomUUID()}`, `left=${x},top=${y},width=${width},height=${height}`) } catch { child = null }
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
      timer = setTimeout(() => { if (!child.closed) rememberDialogWindowSize(kind, { width: child.innerWidth, height: child.innerHeight }) }, 300)
    }
    child.addEventListener('pagehide', closed)
    child.addEventListener('resize', resized)
    // A window torn down without its pagehide (by the OS, or a crash), which popouts watch for the same way.
    poll = setInterval(() => { if (child.closed) closed() }, 1000)
    return () => {
      closing = true
      clearInterval(poll)
      clearTimeout(timer)
      if (!child.closed) rememberDialogWindowSize(kind, { width: child.innerWidth, height: child.innerHeight })
      child.removeEventListener('pagehide', closed)
      child.removeEventListener('resize', resized)
      opened.dispose()
      if (!child.closed) child.close()
      // The main window takes the keyboard back for the focus the dialog returns, when the dialog opened from it.
      if (!opener || opener === window) window.focus()
    }
  }
  useEffect(() => { if (raise !== undefined && host && !host.child.closed) host.child.focus() }, [raise, host])
  if (host === undefined) return null
  const state = { inWindow: !!host, platform: workbench.platform }
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
