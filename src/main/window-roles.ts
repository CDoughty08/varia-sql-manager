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
 * Runs an Electron role for the renderer's custom menus and palette, exactly as the native role item would: the editing
 * roles act on the focused element, and Reload still asks before discarding unsaved queries. Only these fixed methods
 * of the trusted window run; quitting is not a role here, because the renderer runs its own close flow.
 */
export function runRole(value: unknown, window: RoleWindow): void {
  const role: RendererRole = rendererRoleSchema.parse(value)
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
