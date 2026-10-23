import { readFileSync } from 'node:fs'

export interface CssDeclaration { readonly property: string; readonly value: string }
export interface CssRule {
  /** The at-rule preludes around the rule, outermost first (`@media (prefers-reduced-motion: reduce)`, `@keyframes …`). */
  readonly at: readonly string[]
  readonly selector: string
  readonly declarations: readonly CssDeclaration[]
}

/** The rules of a stylesheet with their enclosing at-rules; enough for styles.css, which has no braces in strings. */
export function cssRules(css: string): CssRule[] {
  const rules: CssRule[] = [], preludes: string[] = []
  let text = ''
  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (char === '{') { preludes.push(text.trim()); text = '' } else if (char === '}') {
      const selector = preludes.pop() ?? ''
      if (text.trim()) rules.push({ at: preludes.filter(prelude => prelude.startsWith('@')), selector, declarations: declarationsOf(text) })
      text = ''
    } else text += char
  }
  return rules
}

function declarationsOf(body: string): CssDeclaration[] {
  return body.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const colon = part.indexOf(':')
    return { property: part.slice(0, colon).trim(), value: part.slice(colon + 1).trim() }
  })
}

export const stylesheetRules = (): CssRule[] => cssRules(readFileSync('src/renderer/src/styles.css', 'utf8'))
