// The cascade of styles.css for one element, enough to check which rule wins a state (hovered, focused, forced colors).
import { stylesheetRules } from './css-rules'

const rules = stylesheetRules()
const forced = '@media (forced-colors: active)'

/** A selector list split at its top-level commas (`:not(a, b)` stays whole). */
export function selectorParts(list: string): string[] {
  const parts: string[] = []
  let depth = 0, part = ''
  for (const char of list) {
    if (char === ',' && depth === 0) { parts.push(part.trim()); part = ''; continue }
    if (char === '(') depth++
    if (char === ')') depth--
    part += char
  }
  return [...parts, part.trim()]
}
/** Specificity of a compound selector, enough for styles.css: ids; classes, attributes and pseudo-classes (`:not()` counts its argument); types and pseudo-elements. */
export function specificity(selector: string): [number, number, number] {
  let a = 0, b = 0, c = 0
  const rest = selector.replace(/:not\(([^)]*)\)/g, (_, inner: string) => {
    const most = selectorParts(inner).map(specificity).sort(compare).at(-1) ?? [0, 0, 0]
    a += most[0]; b += most[1]; c += most[2]; return ''
  }).replace(/\[[^\]]*\]/g, () => { b++; return '' }).replace(/::[\w-]+/g, () => { c++; return '' }).replace(/#[\w-]+/g, () => { a++; return '' })
    .replace(/[.:][\w-]+/g, () => { b++; return '' })
  c += rest.match(/[a-z][\w-]*/gi)?.length ?? 0
  return [a, b, c]
}
export const compare = (x: readonly number[], y: readonly number[]) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
/** Shorthands set the colour longhand the cascade below compares. */
const colorProperty: Record<string, string> = { background: 'background-color', outline: 'outline-color', border: 'border-color' }
/**
 * The cascade for one element: the declarations of every rule in styles.css whose selector is one compound made only of
 * the given simple selectors (so `button:hover:not(:disabled)` applies to a hovered chip, `.dock-empty button` does not),
 * at the top level or, with `forcedColors`, also inside the forced-colors block; the winner by specificity, then order.
 */
export function computed(simple: readonly string[], forcedColors = false): Map<string, string> {
  const winners = new Map<string, { value: string; rank: [number, number, number]; order: number }>()
  rules.forEach((rule, order) => {
    if (rule.at.length && !(forcedColors && rule.at.join(' ') === forced)) return
    for (const part of selectorParts(rule.selector)) {
      const tokens = part.match(/:not\([^)]*\)|\[[^\]]*\]|::?[\w-]+|[.#][\w-]+|^[a-z][\w-]*/gi) ?? []
      if (tokens.join('') !== part || !tokens.every(token => simple.includes(token))) continue
      const rank = specificity(part)
      for (const { property, value } of rule.declarations) {
        const name = colorProperty[property] ?? property, current = winners.get(name)
        if (!current || compare(rank, current.rank) > 0 || (compare(rank, current.rank) === 0 && order >= current.order)) winners.set(name, { value, rank, order })
      }
    }
  })
  return new Map([...winners].map(([name, { value }]) => [name, value]))
}
