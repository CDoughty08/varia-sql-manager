import type { Workbench } from '../core/workbench'
import type { Disposable } from '../core/types'

export function queryContribution({ commands, queries }: Pick<Workbench, 'commands' | 'queries'>): Disposable {
  const execute = commands.register('query.execute', { when: () => queries.canExecute(), run: () => queries.execute() })
  const cancel = commands.register('query.cancel', { run: () => queries.cancel() })
  return { dispose: () => { cancel.dispose(); execute.dispose() } }
}
