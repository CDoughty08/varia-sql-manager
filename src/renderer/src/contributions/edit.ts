import type { RendererRole } from '../../../shared/commands/catalog'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }

/**
 * Edit › Cut, Copy, Paste, Delete, and Select All from custom menus. They run after focus is back where the menu was
 * opened, so Electron's roles act on that element: Chromium sends cut, copy, and paste to the query editor's
 * EditContext like any field. Delete and Select All have no such path into the editor, so they run its own commands.
 */
export function editContribution({ commands, documents }: Pick<Workbench, 'commands' | 'documents'>, api: Pick<VariaApi, 'runRole'>): Disposable {
  const role = (name: RendererRole) => async () => { unwrap(await api.runRole(name)) }
  const inEditor = (action: string, fallback: RendererRole) => async () => {
    const editor = documents.boundEditor
    if (editor?.hasTextFocus()) editor.trigger('menu', action, null)
    else await role(fallback)()
  }
  const registrations = [
    commands.register('edit.cut', { run: role('cut') }),
    commands.register('edit.copy', { run: role('copy') }),
    commands.register('edit.paste', { run: role('paste') }),
    commands.register('edit.delete', { run: inEditor('deleteRight', 'delete') }),
    commands.register('edit.selectAll', { run: inEditor('editor.action.selectAll', 'selectAll') })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
