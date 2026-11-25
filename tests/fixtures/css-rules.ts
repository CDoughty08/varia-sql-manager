import { readFileSync } from 'node:fs'

export interface CssDeclaration { readonly property: string; readonly value: string }
export interface CssRule {
  /** The at-rule preludes around the rule, outermost first (`@media (forced-colors: active)`, `@keyframes …`). */
  readonly at: readonly string[]
  readonly selector: string
  readonly declarations: readonly CssDeclaration[]
}

/** Where a stylesheet's braces stop pairing: an extra close, or a block left open (which swallows every rule after it, as the
 *  browser reads them), or undefined when they pair. Enough for styles.css, which has no braces in strings. */
export function unbalancedBrace(css: string): string | undefined {
  // The lines of the blocks still open; a comment keeps its line breaks, so line numbers stay the file's own.
  const opened: number[] = []
  let line = 1
  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ''))) {
    if (char === '\n') line++
    else if (char === '{') opened.push(line)
    else if (char === '}' && opened.pop() === undefined) return `an extra } on line ${line}`
  }
  return opened.length ? `the block opened on line ${opened[0]} never closes` : undefined
}

/** The rules of a stylesheet with their enclosing at-rules; enough for styles.css, which has no braces in strings. */
export function cssRules(css: string): CssRule[] {
  const unbalanced = unbalancedBrace(css)
  if (unbalanced) throw new Error(`The stylesheet's braces do not pair: ${unbalanced}.`)
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
