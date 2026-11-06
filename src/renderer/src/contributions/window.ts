import type { RendererRole } from '../../../shared/commands/catalog'
import type { ApiResult, ReloadPins, VariaApi } from '../../../shared/contracts'
import type { CommandId, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
const windowRoles: readonly (readonly [CommandId, RendererRole])[] = [
  ['view.zoomIn', 'zoomIn'], ['view.zoomOut', 'zoomOut'], ['view.resetZoom', 'resetZoom'], ['view.toggleFullScreen', 'togglefullscreen'],
  ['developer.reloadWindow', 'reload'], ['developer.toggleDevTools', 'toggleDevTools']
]

/** Zoom, full screen, reload, and developer tools: Electron's roles, which main runs for custom menus and the palette. */
export function windowContribution({ commands }: Pick<Workbench, 'commands'>, api: Pick<VariaApi, 'runRole'>, reloadPins?: () => ReloadPins | undefined): Disposable {
  const registrations = windowRoles.map(([id, role]) => commands.register(id, { run: async () => {
    const pins = role === 'reload' ? reloadPins?.() : undefined
    unwrap(await (pins ? api.runRole(role, pins) : api.runRole(role)))
  } }))
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
