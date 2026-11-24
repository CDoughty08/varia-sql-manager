import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'

/** Focus-scoped Ctrl+1..9 (⌘1..9 on macOS) section jumping for the currently focused `ObjectInspectorFrame`. */
export function inspectorContribution({ commands, inspector }: Pick<Workbench, 'commands' | 'inspector'>): Disposable {
  const registrations = [
    ...([1, 2, 3, 4, 5, 6, 7, 8] as const).map(place => commands.register(`inspector.goToTab${place}`, {
      when: () => inspector.hasFocusedFrame(),
      run: () => { inspector.goToTab(place - 1) }
    })),
    commands.register('inspector.goToLastTab', {
      when: () => inspector.hasFocusedFrame(),
      run: () => { inspector.goToTab('last') }
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
