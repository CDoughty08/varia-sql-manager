import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Compares scripts captured in SSMS (spec G8: Clipboard destination, default options, saved as UTF-8 named
// <case id>.sql) with Varia's goldens in tests/fixtures/scripting/golden, after the same normalization the .NET
// checks apply (tests/fixtures/scripting/normalize.json). Prints a unified diff per differing case and whether it is
// only framing (blank lines, GO, trailing spaces) or content, which is usually SMO: Varia pins SMO 181.36.0 in
// backend/Varia.Backend/packages.lock.json, and SSMS ships its own. With --ssms <version> --write, each matching
// golden's source in golden/manifest.json becomes "ssms-<version>", so VARIA_UPDATE_SCRIPT_GOLDENS no longer rewrites it.
//
//   node scripts/compare-ssms-scripts.mjs <capture folder> [--major 16] [--ssms 22.0] [--write]

const fixtures = resolve('tests/fixtures/scripting')
export const baselineMajor = 16

export function loadRules(folder = fixtures) {
  return JSON.parse(readFileSync(join(folder, 'normalize.json'), 'utf8')).rules.map(rule => ({ pattern: new RegExp(rule.pattern, 'g'), replacement: rule.replacement }))
}

/** Spec G5: every rule of normalize.json in order, as GoldenText.Normalize applies them. */
export function normalize(text, rules = loadRules()) {
  // SSMS saves UTF-8 with a byte order mark; the goldens have none.
  let result = text.replace(/^\uFEFF/, '')
  for (const rule of rules) result = result.replace(rule.pattern, rule.replacement)
  return result
}

/** Framing only: the same statements once blank lines, GO lines and trailing spaces are set aside. */
export function framingOnly(expected, actual) {
  const content = text => text.split('\n').map(line => line.trimEnd()).filter(line => line !== '' && !/^GO$/i.test(line)).join('\n')
  return content(expected) === content(actual)
}

/** A unified diff of two texts by lines (longest common subsequence), with three lines of context. */
export function unifiedDiff(expected, actual, from = 'varia', to = 'ssms') {
  const a = expected.split('\n'), b = actual.split('\n')
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1])
  const edits = []
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { edits.push({ kind: ' ', text: a[i], i: i++, j: j++ }); continue }
    if (i < a.length && (j === b.length || lengths[i + 1][j] >= lengths[i][j + 1])) edits.push({ kind: '-', text: a[i], i: i++, j })
    else edits.push({ kind: '+', text: b[j], i, j: j++ })
  }
  const lines = [`--- ${from}`, `+++ ${to}`]
  for (let start = 0; start < edits.length;) {
    const change = edits.findIndex((edit, index) => index >= start && edit.kind !== ' ')
    if (change < 0) break
    let end = change
    for (let index = change; index < edits.length && index - end <= 6; index++) if (edits[index].kind !== ' ') end = index
    const first = Math.max(start, change - 3), last = Math.min(edits.length - 1, end + 3)
    const hunk = edits.slice(first, last + 1)
    const oldCount = hunk.filter(edit => edit.kind !== '+').length, newCount = hunk.filter(edit => edit.kind !== '-').length
    lines.push(`@@ -${hunk[0].i + 1},${oldCount} +${hunk[0].j + 1},${newCount} @@`, ...hunk.map(edit => edit.kind + edit.text))
    start = last + 1
  }
  return lines.join('\n')
}

/** The golden a major compares with: its overlay, else the baseline (as GoldenText.Expected). */
export function goldenKey(id, major, folder = fixtures) {
  const overlay = `${major}/${id}.sql`
  return major !== baselineMajor && existsSync(join(folder, 'golden', overlay)) ? overlay : `${baselineMajor}/${id}.sql`
}

/** Compares every capture in a folder; returns one row per capture. */
export function compareFolder(captures, { major = baselineMajor, folder = fixtures } = {}) {
  const rules = loadRules(folder)
  const ids = new Set(JSON.parse(readFileSync(join(folder, 'cases.json'), 'utf8')).cases.map(item => item.id))
  return readdirSync(captures).filter(name => name.endsWith('.sql')).sort().map(name => {
    const id = basename(name, '.sql')
    if (!ids.has(id)) return { id, status: 'unknown' }
    const key = goldenKey(id, major, folder)
    const path = join(folder, 'golden', key)
    if (!existsSync(path)) return { id, key, status: 'missing' }
    const expected = normalize(readFileSync(path, 'utf8'), rules)
    const actual = normalize(readFileSync(join(captures, name), 'utf8'), rules)
    if (expected === actual) return { id, key, status: 'match' }
    return { id, key, status: framingOnly(expected, actual) ? 'framing' : 'content', diff: unifiedDiff(expected, actual, `golden/${key}`, `${name} (SSMS)`) }
  })
}

const labels = {
  match: 'matches', framing: 'differs in framing only (blank lines, GO, trailing spaces)',
  content: 'differs in content (often SMO: Varia pins SMO 181.36.0, SSMS bundles its own)', missing: 'has no golden', unknown: 'is not a case in cases.json'
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }
  const captures = args.find((arg, index) => !arg.startsWith('--') && !['--major', '--ssms'].includes(args[index - 1]))
  if (!captures) {
    console.error('Usage: node scripts/compare-ssms-scripts.mjs <capture folder> [--major 16] [--ssms 22.0] [--write]')
    process.exit(2)
  }
  const major = Number(option('--major') ?? baselineMajor)
  const ssms = option('--ssms')
  const rows = compareFolder(resolve(captures), { major })
  for (const row of rows) {
    console.log(`${row.id}: ${labels[row.status]}`)
    if (row.diff) console.log(row.diff + '\n')
  }
  if (args.includes('--write') && ssms) {
    if (!/^\d+(\.\d+)*$/.test(ssms)) { console.error('--ssms takes a version such as 22.0'); process.exit(2) }
    const path = join(fixtures, 'golden', 'manifest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    for (const row of rows.filter(item => item.status === 'match')) manifest.files[row.key] = `ssms-${ssms}`
    const files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    writeFileSync(path, '{\n  "version": 1,\n  "files": {\n' + Object.entries(files).map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n') + '\n  }\n}\n')
  }
  const counts = Object.fromEntries(Object.keys(labels).map(status => [status, rows.filter(row => row.status === status).length]))
  console.log(`${rows.length} captures: ${counts.match} match, ${counts.framing} framing, ${counts.content} content, ${counts.missing} without a golden, ${counts.unknown} unknown.`)
  process.exit(rows.every(row => row.status === 'match') ? 0 : 1)
}
