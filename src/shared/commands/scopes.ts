/**
 * Shortcut scopes: the presets a user shortcut can apply in (Tools › Options › Environment › Shortcuts, "Use new
 * shortcut in"). There is no free `when` text: each preset is a fixed clause. A catalogue keybinding whose `when` is no
 * preset's shows as Custom, which can only be kept or reset.
 */
export const scopeIds = ['global', 'queryEditor', 'resultsGrid', 'messages', 'objectExplorer', 'tableDesigner', 'activityMonitor', 'documentTabs'] as const
export type ScopeId = typeof scopeIds[number]
/** A preset, or Custom for a catalogue `when` that matches none. */
export type ScopeKind = ScopeId | 'custom'

export interface ShortcutScope {
  readonly id: ScopeKind
  readonly title: string
  /** The clause a user shortcut in this scope gets; Global has none. */
  readonly when?: string
  /** Higher is narrower: a narrower scope may shadow a Global shortcut, and effective rules list narrower ones first. */
  readonly rank: number
  /**
   * What an unmodified typing key (a letter, Space, Enter, an arrow…) does here: `guard` appends `!textInputFocus`, so
   * the key still types in text boxes; `refuse` refuses it, because text has focus wherever the scope applies.
   */
  readonly typing: 'guard' | 'refuse'
}

export type PresetScope = ShortcutScope & { readonly id: ScopeId }
export const shortcutScopes: readonly PresetScope[] = [
  { id: 'global', title: 'Global', rank: 0, typing: 'guard' },
  { id: 'queryEditor', title: 'SQL Query Editor', when: 'editorFocus || queryBarFocus', rank: 1, typing: 'refuse' },
  { id: 'resultsGrid', title: 'Results Grid', when: 'outputGridFocus', rank: 1, typing: 'guard' },
  { id: 'messages', title: 'Messages', when: 'messagesFocus', rank: 1, typing: 'guard' },
  { id: 'objectExplorer', title: 'Object Explorer', when: "activePanel == 'explorer' && !inputFocus", rank: 1, typing: 'guard' },
  { id: 'tableDesigner', title: 'Table Designer', when: 'designerFocus', rank: 1, typing: 'guard' },
  { id: 'activityMonitor', title: 'Activity Monitor', when: 'activityMonitorFocus', rank: 1, typing: 'guard' },
  { id: 'documentTabs', title: 'Document Tabs', when: 'documentTabFocus && !inputFocus', rank: 1, typing: 'guard' }
]
export const customScope: ShortcutScope = { id: 'custom', title: 'Custom', rank: 1, typing: 'refuse' }

const byId = new Map<string, PresetScope>(shortcutScopes.map(scope => [scope.id, scope]))
export const isScopeId = (value: unknown): value is ScopeId => typeof value === 'string' && (scopeIds as readonly string[]).includes(value)
export const shortcutScope = (id: ScopeId): PresetScope => byId.get(id)!

/** The guard `typing: 'guard'` adds to an unmodified typing key's clause. */
export const typingGuard = '!textInputFocus'
/** The clause a user shortcut in `scope` gets: the preset's, with the typing guard when `guarded`. */
export function scopeWhen(scope: ScopeId, guarded: boolean): string | undefined {
  const { when } = shortcutScope(scope)
  if (!guarded) return when
  return when === undefined ? typingGuard : `(${when}) && ${typingGuard}`
}

const byWhen = new Map<string, ShortcutScope>(shortcutScopes.flatMap(scope => [[scopeWhen(scope.id, false) ?? '', scope], [scopeWhen(scope.id, true)!, scope]] as const))
/** The scope a rule's `when` source belongs to: Global without one, the preset whose clause it is, else Custom. */
export const scopeOfWhen = (whenSource: string | undefined): ShortcutScope => byWhen.get(whenSource ?? '') ?? customScope
