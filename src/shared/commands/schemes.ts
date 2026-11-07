import type { ShortcutBinding } from './shortcut-schema'

/**
 * Keyboard schemes: constant overlays in the user file's entry shape, applied between the catalogue and the user's
 * shortcuts (catalogue ⊕ scheme ⊕ user). The default is empty, so the catalogue's keys are SQL Server's.
 */
export interface ShortcutScheme {
  readonly id: string
  readonly title: string
  readonly bindings: readonly ShortcutBinding[]
}

export const defaultSchemeId = 'default'
export const shortcutSchemes: readonly ShortcutScheme[] = [
  { id: defaultSchemeId, title: 'SQL Server (default)', bindings: [] }
]

/** The scheme named `id`, or undefined when this build does not know it (the file keeps the name; rules use the default). */
export const shortcutScheme = (id: string): ShortcutScheme | undefined => shortcutSchemes.find(scheme => scheme.id === id)
