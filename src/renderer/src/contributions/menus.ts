import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

/** Shift+F10 and the context-menu key: the focused element's context menu, as if it had been right-clicked. */
export function menusContribution({ commands, menus }: Pick<Workbench, 'commands' | 'menus'>): Disposable {
  return commands.register('workbench.showContextMenu', { run: () => { menus.openForElement(typeof document === 'undefined' ? null : document.activeElement, { keyboard: true }) } })
}
