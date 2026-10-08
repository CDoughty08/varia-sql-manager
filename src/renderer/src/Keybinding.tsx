import type { KeybindingLabel } from '../../shared/commands/keybindings'
import type { CommandId } from './core/types'
import { useWorkbench } from './core/WorkbenchContext'

/** A command's key (`id`) or a given label as one `<kbd>` per chord part, read aloud as a whole ("Control+Shift+P"). */
export default function Keybinding(props: { id: CommandId } | { label: KeybindingLabel | undefined }) {
  const { keybindings } = useWorkbench()
  const label = 'id' in props ? keybindings.lookup(props.id) : props.label
  if (!label) return null
  return <span className="keybinding" role="img" aria-label={label.aria}>{label.parts.map((part, index) => <kbd key={index} aria-hidden="true">{part}</kbd>)}</span>
}
