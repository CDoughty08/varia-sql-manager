import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// The Electron suites and benches find Varia's surfaces by ARIA role and accessible name, through
// scripts/fixtures/ui.mjs: a restyle or a reshuffled shell then changes that one file, and these checks say where. Only
// ui.mjs names Varia's own classes (the parts with no role); Monaco's and Dockview's are their libraries' markup.

interface Literal { text: string; line: number; regex?: boolean }

/** The string, template and regular expression literals of a JavaScript or TypeScript source (a template's expressions are code). */
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
    const start = line
    let text = '', inClass = false
    advance()
    while (at < source.length && source[at] !== '\n' && (inClass || source[at] !== '/')) {
      if (source[at] === '\\') { text += source[at]; advance() } else if (source[at] === '[') inClass = true
      else if (source[at] === ']') inClass = false
      text += source[at]; advance()
    }
    advance()
    found.push({ text, line: start, regex: true })
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
const words = (text: string) => text.trim().split(/\s+/)
// The classes the renderer's stylesheets select (styled), the ones a className="..." attribute sets (marked), and every
// class-like word its code writes into a string (a className, a classList call, GridView's pooled cells), so a class
// built up in parts counts too (written).
const classLike = /^\s*[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\s+[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*\s*$/
const styled = new Set<string>(), marked = new Set<string>(), written = new Set<string>()
for (const file of renderer) {
  const source = readFileSync(file, 'utf8')
  if (file.endsWith('.css')) for (const [, name] of source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.(-?[a-z][\w-]*)/g)) styled.add(name)
  else if (/\.tsx?$/.test(file)) {
    // JSX is not JavaScript: a closing tag's slash would read as a regular expression, and its text may hold apostrophes.
    // Plain words ('focus', 'query windows use') are events, keys or text; 'rg-c' and ' lost' are classes.
    for (const { text, regex } of literals(source.replace(/<\//g, '<'))) if (!regex && classLike.test(text) && /-|^\s/.test(text)) for (const name of words(text)) written.add(name)
    for (const [, names] of source.matchAll(/className="([^"]+)"/g)) for (const name of words(names)) marked.add(name)
  }
}
// The query status facts: QueryStatusBar gives each segment the class `query-status-${segment.key}`, which no string holds whole.
const statusBar = readFileSync('src/renderer/src/QueryStatusBar.tsx', 'utf8')
const factKeys = [...(/interface QueryStatusSegment \{ readonly key: ([^;]+);/.exec(readFileSync('src/renderer/src/results/query-status.ts', 'utf8'))?.[1] ?? '').matchAll(/'(\w+)'/g)].map(([, key]) => key)
const facts = statusBar.includes('query-status-${segment.key}') ? factKeys.map(key => `query-status-${key}`) : []
// Monaco's and Dockview's markup, which Varia's stylesheet also selects: their classes change only with the libraries.
const library = /^(monaco-|dv-|dockview-|codicon|view-lines?$|view-overlays$|find-widget$)/
/**
 * Varia's classes for certain: styled, marked, a query fact, or a hyphenated name its code writes. A plain word that some
 * string holds ('rows', ' of ') is not one, so a class whose word survives in text still counts as gone.
 */
const declared = new Set([...styled, ...marked, ...facts, ...[...written].filter(name => name.includes('-'))].filter(name => !library.test(name)))
/** Anything that may be one of Varia's classes, for the selectors in the suites. */
const ownClasses = new Set([...declared, ...written].filter(name => !library.test(name)))
/** A hyphenated name the stylesheets, an attribute or a query fact give Varia's markup, which a suite should not name even outside a selector. */
const certain = new Set([...styled, ...marked, ...facts].filter(name => name.includes('-') && !library.test(name)))

// A class in a selector: at the start or after a combinator or a bracket, alone, after a tag (`input.designer-editor`) or
// after other classes (`.query-tab.active`). Only HTML's tags count, so `file.open` and `theme.mode.light` are not selectors.
const tags = 'a|aside|button|dd|details|dialog|div|dl|dt|footer|form|h[1-6]|header|img|input|label|li|main|nav|ol|option|p|pre|section|select|span|summary|svg|table|tbody|td|textarea|th|thead|tr|ul'
const classSelector = new RegExp(`(?<=(?:^|[^\\w$.\\\\-])(?:${tags})?(?:\\.[a-z][\\w-]*)*)\\.([a-z][\\w-]*)`, 'g')
const selectorClasses = (text: string) => [...text.matchAll(classSelector)].map(([, name]) => name)
/** Varia's class names in a source, as `file:line .name`. */
function classSelectors(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const lineOf = (index: number) => source.slice(0, index).split('\n').length
  const found = (line: number, names: string[], classes: Set<string>) => names.filter(name => classes.has(name)).map(name => `${file}:${line} .${name}`)
  const all = literals(source)
  // Selected: '.query-tab', 'input.designer-editor', '[class~="query-tab"]'.
  const selected = all.filter(({ regex }) => !regex).flatMap(({ text, line }) => found(line, [...selectorClasses(text), ...[...text.matchAll(/\[class[~*^$|]?=\s*['"]?([^\]'"]+)/g)].flatMap(([, value]) => value.split(/[^\w-]+/))], ownClasses))
  // Named outright, as a string of class names (toEqual(['varia-dock'])) or in a pattern (/^(dockview-theme-|varia-dock$)/).
  const named = all.flatMap(({ text, line, regex }) => found(line, regex
    ? [...text.matchAll(/(?<=^|[\^|(]|\\b)[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?=$|[$|)]|\\b)/g)].map(([name]) => name)
    : classLike.test(text) ? words(text) : [], certain))
  // Asserted or tested: toHaveClass(/is-sel/), toHaveClass('active'), classList.contains('error').
  const states = [...source.matchAll(/toHaveClass\(\s*(?:\/((?:\\.|[^/\n])+)\/|['"`]([^'"`]+)['"`])|classList\.contains\(\s*['"]([\w-]+)['"]/g)]
    .flatMap(match => found(lineOf(match.index), (match[1] ?? match[2] ?? match[3]).replace(/\\[a-z]/gi, ' ').split(/[^\w-]+/), ownClasses))
  return [...new Set([...selected, ...named, ...states])].sort((a, b) => parseInt(a.split(':')[1]) - parseInt(b.split(':')[1]))
}
const fixtures = 'scripts/fixtures/ui.mjs'
// The Electron suites, their fixtures and the benches that drive the app.
const suites = walk('scripts').filter(file => /^scripts\/(fixtures\/[^/]+|[^/]+-(smoke|bench))\.mjs$/.test(file) && file !== fixtures)

describe('smoke selectors', () => {
  it('reads literals, not comments or code', () => {
    const source = "const a = page.locator('.toolbar') // '.menu'\n/* '.status-bar' */ const b = /'.messages'/g.test(x) ? `x ${y('.oe-label')} .query-tab` : a / 2 / 3\nconst c = \"it's\""
    expect(literals(source).map(({ text, line, regex }) => `${line}:${regex ? '/' : ''}${text}`)).toEqual(['1:.toolbar', "2:/'.messages'", '2:x ', '2:.oe-label', '2: .query-tab', '3:it\'s'])
  })
  it('knows Varia\'s classes from the stylesheets and the code that writes them', () => {
    for (const name of ['toolbar', 'query-tabs', 'dirty-dot', 'rg-c', 'is-load', 'query-status-text', 'status-session', 'lost', 'designer-editor', 'varia-dock']) expect(ownClasses.has(name), name).toBe(true)
    for (const name of ['rg-c', 'is-load', 'designer-editor', 'varia-dock']) expect(declared.has(name), name).toBe(true)
    // Plain words in the renderer's strings are text, not classes the suites may rely on.
    for (const name of ['rows', 'of']) expect(declared.has(name), name).toBe(false)
    expect(suites).toEqual(expect.arrayContaining(['scripts/electron-smoke.mjs', 'scripts/results-smoke.mjs', 'scripts/grid-bench.mjs', 'scripts/fixtures/explorer-tree.mjs']))
    const offender = 'tests/fixtures/smoke-selectors/offender.mjs'
    expect(classSelectors(offender).map(found => found.slice(offender.length + 1))).toEqual([
      '2 .toolbar', '3 .query-tab', '3 .active', '3 .dirty-dot', '4 .rg-c', '7 .is-sel', '8 .error', '10 .designer-editor', '11 .dirty-dot', '11 .active', '12 .query-tab',
      '13 .varia-dock', '14 .varia-dock'
    ])
  })
  it('knows the query status facts QueryStatusBar draws', () => {
    expect(factKeys).toEqual(['server', 'login', 'database', 'time', 'rows'])
    expect(facts).toEqual(['query-status-server', 'query-status-login', 'query-status-database', 'query-status-time', 'query-status-rows'])
  })
  it('keeps Varia\'s class names out of the suites, the benches and their fixtures', () => {
    expect(suites.flatMap(classSelectors)).toEqual([])
  })
  it('waits in the benches for the backend each launch starts', () => {
    // backendReady's default runtime is the Release backend's .NET, which the fake backend (VARIA_TEST_BACKEND, runtime
    // 'fake') never matches. `check` runs the smoke suites' waits but not the benches', so a bench that starts the fake
    // backend names the runtime at every wait.
    const benches = suites.filter(file => /-bench\.mjs$/.test(file))
    expect(benches).toEqual(expect.arrayContaining(['scripts/grid-bench.mjs', 'scripts/ipc-bench.mjs']))
    const bare = benches.flatMap(file => {
      const source = readFileSync(file, 'utf8')
      if (!/\bVARIA_TEST_BACKEND\s*:/.test(source)) return []
      return [...source.matchAll(/\bbackendReady\(\s*page\s*\)/g)].map(match => `${file}:${source.slice(0, match.index).split('\n').length}`)
    })
    expect(bare).toEqual([])
  })
  it('names in ui.mjs only classes the renderer still has', () => {
    const named = literals(readFileSync(fixtures, 'utf8')).filter(({ regex }) => !regex).flatMap(({ text }) => selectorClasses(text)).filter(name => !library.test(name))
    expect(named.length).toBeGreaterThan(50)
    expect([...new Set(named)].filter(name => !declared.has(name))).toEqual([])
  })
  it('uses only the parts ui.mjs has', async () => {
    // Page code receives the parts whole (`part`, `[part, facts]`) and reads them by name, so a renamed part is caught here.
    const ui = await import(pathToFileURL(resolve(fixtures)).href) as Record<string, Record<string, unknown>>
    const missing = [...suites, fixtures].flatMap(file => {
      const source = readFileSync(file, 'utf8')
      return [...source.matchAll(/(?<![\w$.])(part|gridPart|queryFacts)\.(\w+)/g)].filter(([, group, key]) => !Object.hasOwn(ui[group], key)).map(match => `${file}:${source.slice(0, match.index).split('\n').length} ${match[1]}.${match[2]}`)
    })
    // Page code given a whole group may take its parts by name (`({ titleBar, toolbar }) => …, part)`): each must be there.
    const call = (source: string, open: number) => {
      for (let at = open, depth = 0; at < source.length; at++) if ('([{'.includes(source[at])) depth++; else if (')]}'.includes(source[at]) && --depth === 0) return source.slice(open, at + 1)
      return ''
    }
    const destructured = [...suites, fixtures].flatMap(file => {
      const source = readFileSync(file, 'utf8')
      return [...source.matchAll(/evaluate(?:All)?\(\s*\(?\s*\{([\w\s,]+)\}\s*\)?\s*=>/g)].flatMap(match => {
        const group = /,\s*(part|gridPart|queryFacts)\s*\)$/.exec(call(source, match.index + match[0].indexOf('(')))?.[1]
        return group ? match[1].split(',').map(key => key.trim()).filter(key => key && !Object.hasOwn(ui[group], key)).map(key => `${file}:${source.slice(0, match.index).split('\n').length} ${group}.${key}`) : []
      })
    })
    expect(missing).toEqual([])
    expect(destructured).toEqual([])
  })
})
