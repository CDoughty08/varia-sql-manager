import { commandDescriptor, type CommandId } from '../commands/catalog'
import { contextRecord, type ContextKeys } from '../commands/context-keys'
import { keybindingLabel, nativeChordPrefixes, workbenchRules, type Platform, type ResolvedRule } from '../commands/keybindings'
import { applicationMenus, submenus, menuTitle, type MenuId, type SubmenuId } from '../commands/menus'
import { evaluateWhen } from '../commands/when'
import { commandTitle, settingDef, type SettingKey, type SettingsValues } from '../settings/catalog'
import type { LessonContext } from './catalog'

const connectedQuery = { hasActiveDocument: true, activeDocumentIsText: true, activeDocumentIsQuery: true, hasConnection: true, activeDocumentConnected: true, backendReady: true }
export const lessonContexts: Record<LessonContext, { readonly title: string; readonly values: Partial<ContextKeys> }> = {
  workbench: { title: 'In the workbench', values: {} },
  queryEditor: { title: 'In the SQL query editor', values: { ...connectedQuery, activePanel: 'editor', editorFocus: true, editorTextFocus: true, textInputFocus: true } },
  resultsGrid: { title: 'In the results grid', values: { ...connectedQuery, activePanel: 'output', outputGridFocus: true, outputView: 'grid', hasResults: true } }
}

/** Lesson focus is deliberate: reading Help must not hide the editor/grid shortcut it is teaching. */
export function lessonShortcut(id: CommandId, scope: LessonContext, platform: Platform, rules: readonly ResolvedRule[]): string | undefined {
  const context = contextRecord(platform, lessonContexts[scope].values), table = workbenchRules(rules), prefixes = nativeChordPrefixes(platform, rules)
  const matches = (rule: ResolvedRule) => !rule.when || evaluateWhen(rule.when, context)
  const usable = rules.filter(rule => {
    if (rule.command !== id || !matches(rule)) return false
    const winner = table.get(rule.chords[0])?.find(matches)
    const editorPrefix = scope === 'queryEditor' && prefixes.has(rule.chords[0])
    if (!rule.native) return !editorPrefix && winner === rule
    // Monaco keys require the editor; Chromium roles also work elsewhere. Workbench rules can intercept either.
    const editorOnly = !commandDescriptor(id).role
    return (!editorOnly || scope === 'queryEditor') && (editorPrefix || !winner)
  })
  const rule = usable.find(rule => rule.chords.length === 1) ?? usable[0]
  return rule && keybindingLabel(rule.chords, platform).text
}

function menuPath(menu: MenuId, platform: Platform, visited: ReadonlySet<string> = new Set()): string[] | undefined {
  const root = applicationMenus.find(item => item.id === menu)
  if (root) return [root.label]
  if (menu === 'output.context') return ['Results context menu']
  if (menu === 'editor.context') return ['Editor context menu']
  if (visited.has(menu)) return undefined
  const submenu = submenus[menu as SubmenuId]
  const parent = submenu?.placements.find(item => !item.platforms || item.platforms.includes(platform))
  const path = parent && menuPath(parent.menu, platform, new Set([...visited, menu]))
  return path && [...path, submenu.title]
}

export function lessonCommand(id: CommandId, platform: Platform, values: SettingsValues): { title: string; path?: string } {
  const title = commandTitle(id, values, menuTitle(id, platform))
  for (const placement of commandDescriptor(id).menus ?? []) {
    if (placement.platforms && !placement.platforms.includes(platform)) continue
    const path = menuPath(placement.menu, platform)
    if (path) return { title, path: [...path, commandTitle(id, values, placement.title ?? title)].join(' › ') }
  }
  return { title }
}

export function settingValueLabel(key: SettingKey, values: SettingsValues): string {
  const def = settingDef(key), value = values[key]
  if (def.type === 'boolean') return value ? 'On' : 'Off'
  if (def.type === 'enum') return def.values.find(option => option.value === value)?.label ?? String(value)
  return `${value}${def.unit ? ` ${def.unit}` : ''}`
}
