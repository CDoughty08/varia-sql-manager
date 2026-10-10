import { z } from 'zod'
import { rendererRoles, type RendererRole } from '../shared/commands/catalog'

/** The parts of a `BrowserWindow` the roles use, so tests can pass a fake. */
export interface RoleWindow {
  isFullScreen(): boolean
  setFullScreen(flag: boolean): void
  readonly webContents: {
    cut(): void; copy(): void; paste(): void; delete(): void; selectAll(): void; reload(): void; toggleDevTools(): void
    getZoomLevel(): number; setZoomLevel(level: number): void
  }
}

export const rendererRoleSchema = z.enum(rendererRoles)
/** Electron's zoom roles step by half a level and are not clamped, so custom menus and the palette do the same. */
const zoomStep = 0.5

/**
 * Input types that are the user acting: a press or release of a mouse button or a key, or a tap (its touch release and
 * the tap gesture, as Chromium's own user activation counts it), never a pointer or finger just moving or scrolling.
 */
const activationInputs: ReadonlySet<string> = new Set(['mouseDown', 'mouseUp', 'rawKeyDown', 'keyDown', 'keyUp', 'char', 'touchEnd', 'gestureTap'])
/** How recent that input must be for Paste: a menu's Paste runs within milliseconds of the click or key that chose it. */
export const userActivationMs = 1000
/**
 * When the user last clicked or pressed a key in the window, from the input main forwards to the page (`input-event`):
 * events the page dispatches itself never pass through main, so the page cannot fake one.
 */
export class UserActivation {
  private last = Number.NEGATIVE_INFINITY
  constructor(private readonly now: () => number = () => performance.now()) {}
  note(type: string): void { if (activationInputs.has(type)) this.last = this.now() }
  recent(): boolean { return this.now() - this.last <= userActivationMs }
}

/**
 * Runs an Electron role for the renderer's custom menus and palette, exactly as the native role item would: the editing
 * roles act on the focused element, and Reload still asks before discarding unsaved queries. Only these fixed methods
 * of the trusted window run; quitting is not a role here, because the renderer runs its own close flow. Paste reads the
 * system clipboard, which the page itself may not, so it runs only while `userActivated` (a click, tap, or key just
 * now). A screen reader's activation reaches main as no input at all, so the refusal names the key that still pastes.
 */
export function runRole(value: unknown, window: RoleWindow, userActivated: () => boolean, platform: NodeJS.Platform = process.platform): void {
  const role: RendererRole = rendererRoleSchema.parse(value)
  if (role === 'paste' && !userActivated()) throw new Error(`Paste needs a click, tap, or key press in the window. Press ${platform === 'darwin' ? '⌘V' : 'Ctrl+V'} to paste.`)
  const contents = window.webContents
  switch (role) {
    case 'cut': contents.cut(); break
    case 'copy': contents.copy(); break
    case 'paste': contents.paste(); break
    case 'delete': contents.delete(); break
    case 'selectAll': contents.selectAll(); break
    case 'reload': contents.reload(); break
    case 'toggleDevTools': contents.toggleDevTools(); break
    case 'resetZoom': contents.setZoomLevel(0); break
    case 'zoomIn': contents.setZoomLevel(contents.getZoomLevel() + zoomStep); break
    case 'zoomOut': contents.setZoomLevel(contents.getZoomLevel() - zoomStep); break
    case 'togglefullscreen': window.setFullScreen(!window.isFullScreen()); break
  }
}
