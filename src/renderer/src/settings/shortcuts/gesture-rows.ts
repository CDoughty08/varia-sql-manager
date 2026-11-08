// A stub of lane D2's gesture rows (the shortcuts contract): the Shortcuts page's All view lists them under its
// keyboard rows. D2 replaces this file; it keeps `gestureRows`'s signature and `GestureRow`'s fields.
import { gestureAvailable, gestureDescriptor, gestureIds, gestureLabel, gestureScopes, type GestureId, type GestureKind } from '../../../../shared/commands/gestures'
import type { Platform } from '../../../../shared/commands/keybindings'
import type { ShortcutFile } from '../../../../shared/commands/shortcut-schema'

export interface GestureRow {
  readonly id: GestureId
  readonly title: string
  /** The gesture as the table shows it: `Ctrl+Double-click`. */
  readonly label: string
  readonly scopeTitle: string
  readonly kind: GestureKind
  /** The draft chooses another modifier than the default. */
  readonly changed: boolean
  /** Why it cannot be remapped. */
  readonly locked?: string
}

/** The gestures on `platform` whose title, label or scope has every word of `search`. */
export function gestureRows(draft: ShortcutFile, platform: Platform, search: string): readonly GestureRow[] {
  const words = search.toLowerCase().split(/\s+/).filter(word => word && !word.startsWith('@'))
  return gestureIds.filter(id => gestureAvailable(id, platform)).map((id): GestureRow => {
    const gesture = gestureDescriptor(id)
    return {
      id, title: gesture.title, label: gestureLabel(gesture.action, gesture.modifiers, platform), scopeTitle: gestureScopes[gesture.scope], kind: gesture.kind,
      changed: draft.gestures[id] !== undefined, ...gesture.locked ? { locked: gesture.locked } : {}
    }
  }).filter(row => words.every(word => [row.title, row.label, row.scopeTitle].join(' ').toLowerCase().includes(word)))
}
