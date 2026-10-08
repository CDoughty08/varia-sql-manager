import type { Platform } from '../../../shared/commands/keybindings'
import type { QuickInputMove, QuickInputView } from './QuickInputService'

/** The widget's decisions that need no DOM, so they are unit-tested on every platform (macOS has no smoke run in CI). */
export interface QuickInputKeyEvent {
  readonly key: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly repeat: boolean
  readonly isComposing: boolean
  readonly keyCode: number
}
/** What a key in the input does. A `handled` key goes no further: its default action and propagation are stopped. */
export interface QuickInputKeyAction { readonly handled: boolean; readonly move?: QuickInputMove; readonly accept?: true; readonly cancel?: true }

const unhandled: QuickInputKeyAction = { handled: false }
const move = (to: QuickInputMove): QuickInputKeyAction => ({ handled: true, move: to })

export function quickInputKeyAction(event: QuickInputKeyEvent, platform: Platform): QuickInputKeyAction {
  // The IME owns every key while it composes.
  if (event.isComposing || event.keyCode === 229) return unhandled
  const mac = platform === 'darwin', plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
  switch (event.key) {
    case 'ArrowDown': return mac && event.metaKey ? move('last') : plain ? move('next') : unhandled
    case 'ArrowUp': return mac && event.metaKey ? move('first') : plain ? move('previous') : unhandled
    case 'PageDown': return move('pageNext')
    case 'PageUp': return move('pagePrevious')
    // On macOS Home and End (with or without ⌃) stay with the caret; ⌘↑ and ⌘↓ go to the ends of the list.
    case 'Home': return !mac && event.ctrlKey ? move('first') : unhandled
    case 'End': return !mac && event.ctrlKey ? move('last') : unhandled
    // A held Enter must not also accept a row in the picker the first press opened.
    case 'Enter': return !plain ? unhandled : event.repeat ? { handled: true } : { handled: true, accept: true }
    case 'Escape': return { handled: true, cancel: true }
    // Focus stays in the input.
    case 'Tab': return { handled: true }
    default: return unhandled
  }
}

/**
 * What the status live region announces: the number of rows, or that nothing matches. Nothing while loading, or after a
 * failed load, whose message (a live region too) says what went wrong.
 */
export function resultStatus(view: Pick<QuickInputView, 'rows' | 'loading' | 'message' | 'noun'>): string {
  const count = view.rows.length
  if (count) return `${count.toLocaleString('en-US')} result${count === 1 ? '' : 's'}`
  return view.loading || view.message?.severity === 'error' ? '' : `No matching ${view.noun}`
}
