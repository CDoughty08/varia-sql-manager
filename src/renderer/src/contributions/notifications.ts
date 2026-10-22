import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

/**
 * The toasts' commands, and the outcomes that become toasts. A save that finishes while its query is the active document
 * shows only the output toolbar's notice; one whose query is in the background gets a toast with Show results, and one
 * whose query was closed (the save outlives it) a toast that leaves by itself.
 */
export function notificationsContribution({ commands, notifications, events, documents }: Pick<Workbench, 'commands' | 'notifications' | 'events' | 'documents'>): Disposable {
  const registrations = [
    commands.register('notifications.focus', { run: () => { [...document.querySelectorAll<HTMLElement>('.toast-stack .toast')].at(-1)?.focus() } }),
    commands.register('notifications.clearAll', { run: () => notifications.clear() })
  ]
  const saved = events.subscribe(event => {
    if (event.type !== 'results.saved' || documents.getSnapshot().activeId === event.tabId) return
    const open = !!documents.get(event.tabId)
    notifications.notify({
      severity: 'info', message: event.text, key: `results.saved:${event.tabId}`,
      actions: open ? [{ label: 'Show results', run: () => { documents.activate(event.tabId); void commands.execute('window.output', undefined, 'toolbar') } }] : []
    })
  })
  return { dispose: () => { saved.dispose(); registrations.forEach(registration => registration.dispose()) } }
}
