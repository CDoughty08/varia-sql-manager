import type { editor } from 'monaco-editor'
import type { Workbench } from '../core/workbench'
import type { Disposable } from '../core/types'

export function queryContribution(workbench: Workbench): Disposable {
  const execute = workbench.commands.register('query.execute', { when: () => workbench.queries.canExecute(), run: () => workbench.queries.execute() })
  const cancel = workbench.commands.register('query.cancel', { run: () => workbench.queries.cancel() })
  return { dispose: () => { cancel.dispose(); execute.dispose() } }
}
export function bindQueryActions(workbench: Workbench, instance: editor.IStandaloneCodeEditor): Disposable {
  const { KeyCode, KeyMod } = workbench.monaco
  return instance.addAction({ id: 'query.execute', label: 'Execute query', keybindings: [KeyCode.F5, KeyMod.CtrlCmd | KeyCode.Enter], run: () => workbench.commands.run('query.execute') })
}
