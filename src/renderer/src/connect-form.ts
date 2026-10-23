import type { AdvancedConnectionOptions, ConnectionOptions } from '../../shared/contracts'
import { environmentTag } from '../../shared/environments'
import { connectionPresets } from '../../shared/theme/connection-colors'

/** How many Advanced Properties the connection sets: OK stores only those changed or edited, so each one counts. */
export function advancedCount(advanced: Partial<AdvancedConnectionOptions> | undefined): number {
  return advanced ? Object.values(advanced).filter(value => value !== undefined).length : 0
}
/** What the Advanced… button says beside it while its dialog is closed: nothing, or how many properties are set. */
export function advancedSummary(advanced: Partial<AdvancedConnectionOptions> | undefined): string {
  const count = advancedCount(advanced)
  return count === 0 ? '' : count === 1 ? '1 property set' : `${count} properties set`
}

/** A stored connection colour by its preset's name, or Custom. */
export function colorName(stored: string | undefined): string | undefined {
  if (!stored) return undefined
  return connectionPresets.find(preset => preset.stored === stored.toLowerCase())?.label ?? 'Custom'
}
/**
 * The collapsed Custom Properties' summary, so a name, colour or environment that is set stays in view: the parts for
 * the row, and one sentence for screen readers. A Custom environment still being typed ('') counts as unset.
 */
export function customSummary(options: Pick<ConnectionOptions, 'displayName' | 'color' | 'environment'>): { readonly name?: string; readonly color?: string; readonly environment?: string; readonly text: string } {
  const name = options.displayName?.trim() || undefined
  const color = colorName(options.color)
  const environment = environmentTag(options.environment) ? options.environment!.trim() : undefined
  const parts = [name && `Name ${name}`, color && `Color ${color}`, environment && `Environment ${environment}`].filter(Boolean)
  return { name, color, environment, text: parts.length ? parts.join(', ') : 'No name, color or environment' }
}

/**
 * Arrow keys in the saved and discovered server lists: the index to focus next among `count` rows, or undefined for a
 * key the lists leave alone. -1 is the filter box: Down enters the list from it, and Up from the first row goes back.
 * Home and End in the filter box stay the text's.
 */
export function listStep(current: number, count: number, key: string): number | undefined {
  if (count === 0) return undefined
  if (key === 'ArrowDown') return Math.min(current + 1, count - 1)
  if (key === 'ArrowUp') return current < 0 ? undefined : current - 1
  if (current < 0) return undefined
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return undefined
}
