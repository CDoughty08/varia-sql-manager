// The Options search box: which pages and rows match, and where in a label, without the DOM.
import type { Platform } from '../../../shared/commands/keybindings'
import { pagePath, settingDefs, settingPages, settingsLimits, visibleSettings, type SettingDef, type SettingPage } from '../../../shared/settings/catalog'

/** Search text as matched: trimmed, runs of whitespace as one space, case-folded, at most `searchChars`. */
export const normalizeQuery = (text: string): string => text.slice(0, settingsLimits.searchChars).trim().replace(/\s+/g, ' ').toLowerCase()
const has = (text: string, query: string) => text.replace(/\s+/g, ' ').toLowerCase().includes(query)
/** Rows a page shows that are not settings, and the words they answer to. */
const providerTerms: Readonly<Record<string, readonly string[]>> = { theme: ['Color theme', 'View › Theme', 'dark', 'light'] }
const layoutTerms: Readonly<Record<string, readonly string[]>> = { keyboard: ['keyboard', 'shortcut', 'keys'] }

export const settingMatches = (def: SettingDef, query: string): boolean =>
  [def.label, def.description, ...def.keywords ?? []].some(text => has(text, query))
function pageMatches(page: SettingPage, query: string, defs: readonly SettingDef[]): boolean {
  const terms = [pagePath(page.id).map(node => node.title).join(' › '), page.description ?? '', ...page.provider ? providerTerms[page.provider] : [], ...page.layout ? layoutTerms[page.layout] ?? [] : []]
  return terms.some(text => has(text, query)) || defs.some(def => def.page === page.id && settingMatches(def, query))
}
/**
 * The pages a query finds (their titles and paths, their settings' labels, descriptions and keywords, and their own
 * rows), with their ancestors so the tree can show them; undefined for an empty query, which filters nothing. Settings
 * Options does not show on `platform` never match.
 */
export function searchPages(text: string, platform: Platform, defs: readonly SettingDef[] = settingDefs): { readonly pages: readonly string[]; readonly shown: ReadonlySet<string> } | undefined {
  const query = normalizeQuery(text)
  if (!query) return undefined
  const visible = visibleSettings(platform, defs)
  const pages = settingPages.filter(page => page.layout && pageMatches(page, query, visible)).map(page => page.id)
  return { pages, shown: new Set(pages.flatMap(id => pagePath(id).map(page => page.id))) }
}
/** A label split around the query's matches, for highlighting; one unmatched part when nothing matches. */
export function highlightParts(label: string, text: string): { readonly text: string; readonly match: boolean }[] {
  const query = normalizeQuery(text)
  if (!query) return [{ text: label, match: false }]
  const parts: { text: string; match: boolean }[] = [], lower = label.toLowerCase()
  let at = 0
  for (let found = lower.indexOf(query); found >= 0; found = lower.indexOf(query, found + query.length)) {
    if (found > at) parts.push({ text: label.slice(at, found), match: false })
    parts.push({ text: label.slice(found, found + query.length), match: true })
    at = found + query.length
  }
  if (at < label.length) parts.push({ text: label.slice(at), match: false })
  return parts
}
