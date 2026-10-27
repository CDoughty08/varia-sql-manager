import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

const savedKey = (tabId: string) => `results.saved:${tabId}`

/**
 * The toasts' commands, and the outcomes that become toasts. A save that finishes in view (its query is the active
 * document and the results pane shows) has only the output toolbar's notice; one whose query is in the background, or
 * whose results pane is hidden (Ctrl+R), gets a toast with Show results, and one whose query was closed (the save
 * outlives it) a toast that leaves by itself. Closing the query while its toast shows takes Show results away, which
 * would otherwise reveal another query's output.
 */
export function notificationsContribution({ commands, notifications, events, documents, panes }: Pick<Workbench, 'commands' | 'notifications' | 'events' | 'documents' | 'panes'>): Disposable {
  const registrations = [
    commands.register('notifications.focus', { run: () => { [...document.querySelectorAll<HTMLElement>('.toast-stack .toast')].at(-1)?.focus() } }),
    commands.register('notifications.clearAll', { run: () => notifications.clear() })
  ]
  const saved = events.subscribe(event => {
    if (event.type === 'documents.closed') notifications.dropActions(savedKey(event.tabId))
    // The editor shows one query at a time, and the results pane only the active query's output.
    if (event.type !== 'results.saved' || (documents.getSnapshot().activeId === event.tabId && panes.getSnapshot().output)) return
    const open = !!documents.get(event.tabId)
    notifications.notify({
      severity: 'info', message: event.text, key: savedKey(event.tabId),
      actions: open ? [{ label: 'Show results', run: () => { documents.activate(event.tabId); void commands.execute('window.output', undefined, 'toolbar') } }] : []
    })
  })
  return { dispose: () => { saved.dispose(); registrations.forEach(registration => registration.dispose()) } }
}
