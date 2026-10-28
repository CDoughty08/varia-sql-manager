import { activityIntervalsSeconds, chartWindowsMinutes } from '../../../shared/activity/catalog'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf } from '../menus/targets'
import { serverItems } from './query'

/** The monitor's focusable regions in F6 order: the tiles, the charts, then each pane slot. */
const regions = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[data-activity-region]')]
/** Where focus lands in a region: its selected pane tab, else its first chart, else its first control (one selector list
 *  would take whichever comes first in the document, an unselected tab before the selected one). */
const entry = (region: HTMLElement) => region.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? region.querySelector<HTMLElement>('canvas[tabindex="0"]')
  ?? region.querySelector<HTMLElement>('button:not(:disabled), select')

/** F6 and Shift+F6 in a monitor: the next or previous region, wrapping, from the one that has focus. */
export function cyclePanel(root: ParentNode, active: Element | null, step: 1 | -1): HTMLElement | undefined {
  const list = regions(root).filter(region => entry(region))
  if (!list.length) return undefined
  const at = list.findIndex(region => active && region.contains(active))
  const next = list[at < 0 ? step === 1 ? 0 : list.length - 1 : (at + step + list.length) % list.length]
  const target = entry(next) ?? undefined
  target?.focus()
  return target
}

/**
 * The Activity Monitor's commands (docs/activity-monitor.md). Activity Monitor opens one per connection: the server whose
 * Object Explorer menu runs it, else the active document's server, else the server of the node selected in Object
 * Explorer, else the one live connection or the one picked from several; with none, the Connect dialog opens and the
 * monitor follows the new connection. The other commands act on the monitor whose header runs them (`tabId`), else the
 * active document.
 */
export function activityContribution({ commands, activity, documents, connections, explorer, quickInput, events }: Pick<Workbench, 'commands' | 'activity' | 'documents' | 'connections' | 'explorer' | 'quickInput' | 'events'>): Disposable {
  const live = (id: string | undefined) => id !== undefined && connections.isLive(id) ? id : undefined
  const target = (args?: CommandArgs): string | undefined => {
    const node = explorerNodeOf(args)
    if (node) return node.kind === 'server' && !node.lost ? live(node.connectionId) : undefined
    return live(documents.active?.connectionId) ?? live(explorer.menuNode(explorer.getSnapshot().selected)?.connectionId)
  }
  const open = (connectionId: string) => {
    try { activity.open(connectionId) } catch (error) { commands.reportError(error instanceof Error ? error.message : 'The Activity Monitor could not open.') }
  }
  const monitorOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return activity.get(id) ? id : undefined }
  const on = (action: (id: string) => void) => ({ when: (args?: CommandArgs) => !!monitorOf(args), run: (args?: CommandArgs) => { const id = monitorOf(args); if (id) action(id) } })
  const root = (id: string) => typeof document === 'undefined' ? undefined : document.querySelector(`[data-activity-monitor="${CSS.escape(id)}"]`) ?? undefined
  const registrations = [
    commands.register('activity.open', {
      when: args => { const node = explorerNodeOf(args); return !node || (node.kind === 'server' && !node.lost && connections.isLive(node.connectionId)) },
      run: args => {
        const connectionId = target(args)
        if (connectionId) return open(connectionId)
        const choices = connections.live()
        if (choices.length === 1) return open(choices[0].id)
        if (!choices.length) { events.emit({ type: 'activity.connectRequested' }); return }
        quickInput.show({ ariaLabel: 'Activity Monitor', placeholder: 'Select a server to monitor', noun: 'servers', items: serverItems(choices), onDidAccept: item => open(item.id) })
      }
    }),
    commands.register('activity.togglePause', on(id => activity.togglePause(id))),
    commands.register('activity.refresh', { when: args => { const id = monitorOf(args); return !!id && !activity.get(id)?.paused }, run: args => { const id = monitorOf(args); if (id) activity.refresh(id) } }),
    commands.register('activity.setInterval', on(id => {
      const current = activity.get(id)?.intervalSeconds
      quickInput.show({
        ariaLabel: 'Set Refresh Interval', placeholder: 'Sample the server every…', noun: 'intervals', sort: 'none', activeId: String(current),
        items: activityIntervalsSeconds.map(seconds => ({ id: String(seconds), label: `Every ${seconds} s`, ...seconds === current ? { description: 'Current' } : {} })),
        onDidAccept: item => activity.setInterval(id, Number(item.id))
      })
    })),
    commands.register('activity.setChartWindow', on(id => {
      const current = activity.get(id)?.windowMinutes
      quickInput.show({
        ariaLabel: 'Set Chart Window', placeholder: 'Show the last…', noun: 'windows', sort: 'none', activeId: String(current),
        items: chartWindowsMinutes.map(minutes => ({ id: String(minutes), label: `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`, ...minutes === current ? { description: 'Current' } : {} })),
        onDidAccept: item => activity.setWindow(id, Number(item.id))
      })
    })),
    commands.register('activity.toggleSplit', on(id => activity.toggleSplit(id))),
    commands.register('activity.nextPane', on(id => { const element = root(id); if (element) cyclePanel(element, document.activeElement, 1) })),
    commands.register('activity.previousPane', on(id => { const element = root(id); if (element) cyclePanel(element, document.activeElement, -1) })),
    commands.register('activity.close', { when: args => !!monitorOf(args), run: async args => { await commands.execute('file.close', { tabId: monitorOf(args) }, 'toolbar') } })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
