import type { RendererRole } from '../../../shared/commands/catalog'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { inputOf, type InputTarget } from '../menus/targets'
import { focusedOutput } from './output'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
/** In a text field's menu, what the field allows (as Windows edit controls: nothing to copy from a password field); elsewhere, always. */
const field = (allowed: (input: InputTarget) => boolean) => (args?: CommandArgs) => { const input = inputOf(args); return !input || allowed(input) }

/**
 * Edit › Cut, Copy, Paste, Delete, and Select All from custom menus. They run after focus is back where the menu was
 * opened, so Electron's roles act on that element: Chromium sends cut, copy, and paste to the query editor's
 * EditContext like any field, and copy to the results grid, which copies its cells. Delete and Select All have no such
 * path into the editor, so they run its own commands; Select All in Query Output selects only that view.
 */
export function editContribution({ commands, documents, menuTargets }: Pick<Workbench, 'commands' | 'documents' | 'menuTargets'>, api: Pick<VariaApi, 'runRole'>): Disposable {
  const role = (name: RendererRole) => async () => { unwrap(await api.runRole(name)) }
  const inEditor = (action: string, fallback: RendererRole) => async () => {
    const editor = documents.boundEditor
    if (editor?.hasTextFocus()) editor.trigger('menu', action, null)
    else await role(fallback)()
  }
  const registrations = [
    commands.register('edit.cut', { when: field(input => !input.readOnly && !input.secret && input.hasSelection), run: role('cut') }),
    commands.register('edit.copy', { when: field(input => !input.secret && input.hasSelection), run: role('copy') }),
    commands.register('edit.paste', { when: field(input => !input.readOnly), run: role('paste') }),
    commands.register('edit.delete', { when: field(input => !input.readOnly && input.hasSelection), run: inEditor('deleteRight', 'delete') }),
    commands.register('edit.selectAll', {
      when: field(input => !input.empty),
      run: async args => {
        const output = inputOf(args) ? undefined : focusedOutput(menuTargets)
        if (output) await commands.run('output.selectAll', { target: output })
        else await inEditor('editor.action.selectAll', 'selectAll')()
      }
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
