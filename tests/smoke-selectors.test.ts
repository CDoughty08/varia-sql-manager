import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The Electron suites and benches find Varia's surfaces by ARIA role and accessible name, through
// scripts/fixtures/ui.mjs: a restyle or a reshuffled shell then changes that one file, and these checks say where. Only
// ui.mjs names Varia's own classes (the parts with no role); Monaco's and Dockview's are their libraries' markup.

interface Literal { text: string; line: number }

/** The string and template literal text of a JavaScript or TypeScript source (a template's expressions are code). */
function literals(source: string): Literal[] {
  const found: Literal[] = []
  let at = 0, line = 1, last = ''
  const advance = () => { if (source[at] === '\n') line++; at++ }
  function quoted(quote: string) {
    const start = line
    let text = ''
    advance()
    while (at < source.length && source[at] !== quote && source[at] !== '\n') {
      if (source[at] === '\\') { text += source[at]; advance() }
      text += source[at]; advance()
    }
    advance()
    found.push({ text, line: start })
  }
  function template() {
    let text = '', start = line
    advance()
    while (at < source.length && source[at] !== '`') {
      if (source[at] === '\\') { text += source[at]; advance(); text += source[at]; advance() } else if (source[at] === '$' && source[at + 1] === '{') {
        found.push({ text, line: start })
        text = ''
        at += 2
        code('}')
        advance()
        start = line
      } else { text += source[at]; advance() }
    }
    advance()
    found.push({ text, line: start })
  }
  function regex() {
    advance()
    let inClass = false
    while (at < source.length && source[at] !== '\n' && (inClass || source[at] !== '/')) {
      if (source[at] === '\\') advance()
      else if (source[at] === '[') inClass = true
      else if (source[at] === ']') inClass = false
      advance()
    }
    advance()
    while (/[a-z]/i.test(source[at] ?? '')) advance()
  }
  function code(until?: string) {
    let depth = 0
    while (at < source.length) {
      const char = source[at], next = source[at + 1]
      if (until && char === until && depth === 0) return
      if (char === '/' && next === '/') { while (at < source.length && source[at] !== '\n') advance(); continue }
      if (char === '/' && next === '*') { at += 2; while (at < source.length && !(source[at] === '*' && source[at + 1] === '/')) advance(); at += 2; continue }
      if (char === "'" || char === '"') { quoted(char); last = 'x'; continue }
      if (char === '`') { template(); last = 'x'; continue }
      // A slash opens a regular expression where an operand is expected, as after `(`, `,`, `=` or `return`.
      if (char === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || /\b(return|typeof|in|of|case)$/.test(last))) { regex(); last = 'x'; continue }
      if (char === '{') depth++
      if (char === '}') depth--
      if (!/\s/.test(char)) last = /[\w$]/.test(char) ? (/[\w$]$/.test(last) ? last + char : char) : char
      advance()
    }
  }
  code()
  return found
}

const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)].map(path => path.replaceAll('\\', '/')))
const renderer = walk('src/renderer')
// Every class the renderer's stylesheets select, and every class-like word its code writes into a string (a className, a
// classList call, GridView's pooled cells), so a class built up in parts counts too.
const classLike = /^\s*[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\s+[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*\s*$/
const ownClasses = new Set<string>()
for (const file of renderer) {
  const source = readFileSync(file, 'utf8')
  if (file.endsWith('.css')) for (const [, name] of source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.(-?[a-z][\w-]*)/g)) ownClasses.add(name)
  else if (/\.tsx?$/.test(file)) {
    // JSX is not JavaScript: a closing tag's slash would read as a regular expression, and its text may hold apostrophes.
    // Plain words ('focus', 'query windows use') are events, keys or text; 'rg-c' and ' lost' are classes.
    for (const { text } of literals(source.replace(/<\//g, '<'))) if (classLike.test(text) && /-|^\s/.test(text)) for (const name of text.trim().split(/\s+/)) ownClasses.add(name)
    for (const [, names] of source.matchAll(/className="([^"]+)"/g)) for (const name of names.split(/\s+/)) ownClasses.add(name)
  }
}
// Monaco's and Dockview's markup, which Varia's stylesheet also selects: their classes change only with the libraries.
const library = /^(monaco-|dv-|dockview-|codicon|view-lines?$|view-overlays$|find-widget$)/
/** Varia's class names in a source's literals, as `file:line .name`. */
function classSelectors(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const varia = (name: string) => ownClasses.has(name) && !library.test(name)
  const selectors = literals(source).flatMap(({ text, line }) => [...text.matchAll(/(?<![\w$\\-])\.([a-z][\w-]*)/g)]
    .map(([, name]) => name).filter(varia).map(name => `${file}:${line} .${name}`))
  // A class asserted or tested rather than selected: toHaveClass(/is-sel/), classList.contains('error').
  const lineOf = (index: number) => source.slice(0, index).split('\n').length
  const states = [...source.matchAll(/toHaveClass\(\s*\/((?:\\.|[^/\n])+)\/|classList\.contains\(\s*['"]([\w-]+)['"]/g)]
    .flatMap(match => (match[1] ?? match[2]).replace(/\\[a-z]/gi, ' ').split(/[^\w-]+/).filter(varia).map(name => `${file}:${lineOf(match.index)} .${name}`))
  return [...selectors, ...states]
}
const fixtures = 'scripts/fixtures/ui.mjs'
// The Electron suites, their fixtures and the benches that drive the app.
const suites = walk('scripts').filter(file => /^scripts\/(fixtures\/[^/]+|[^/]+-(smoke|bench))\.mjs$/.test(file) && file !== fixtures)

describe('smoke selectors', () => {
  it('reads literals, not comments, regular expressions or code', () => {
    const source = "const a = page.locator('.toolbar') // '.menu'\n/* '.status-bar' */ const b = /'.messages'/g.test(x) ? `x ${y('.oe-label')} .query-tab` : a / 2 / 3\nconst c = \"it's\""
    expect(literals(source).map(({ text, line }) => `${line}:${text}`)).toEqual(['1:.toolbar', '2:x ', '2:.oe-label', '2: .query-tab', '3:it\'s'])
  })
  it('knows Varia\'s classes from the stylesheets and the code that writes them', () => {
    for (const name of ['toolbar', 'query-tabs', 'dirty-dot', 'rg-c', 'is-load', 'query-status-text', 'status-session', 'lost']) expect(ownClasses.has(name), name).toBe(true)
    expect(suites).toEqual(expect.arrayContaining(['scripts/electron-smoke.mjs', 'scripts/results-smoke.mjs', 'scripts/grid-bench.mjs', 'scripts/fixtures/explorer-tree.mjs']))
    expect(classSelectors('tests/fixtures/smoke-selectors/offender.mjs')).toEqual([
      'tests/fixtures/smoke-selectors/offender.mjs:2 .toolbar', 'tests/fixtures/smoke-selectors/offender.mjs:3 .query-tab', 'tests/fixtures/smoke-selectors/offender.mjs:3 .dirty-dot',
      'tests/fixtures/smoke-selectors/offender.mjs:4 .rg-c', 'tests/fixtures/smoke-selectors/offender.mjs:7 .is-sel', 'tests/fixtures/smoke-selectors/offender.mjs:8 .error'
    ])
  })
  it('keeps Varia\'s class names out of the suites, the benches and their fixtures', () => {
    expect(suites.flatMap(classSelectors)).toEqual([])
  })
  it('names in ui.mjs only classes the renderer still has', () => {
    const named = literals(readFileSync(fixtures, 'utf8')).flatMap(({ text }) => [...text.matchAll(/(?<![\w$\\-])\.([a-z][\w-]*)/g)].map(([, name]) => name)).filter(name => !library.test(name))
    expect(named.length).toBeGreaterThan(50)
    // A name ending in a hyphen is a prefix (`.query-status-${key}`).
    expect([...new Set(named)].filter(name => name.endsWith('-') ? ![...ownClasses].some(own => own.startsWith(name)) : !ownClasses.has(name))).toEqual([])
  })
})
