import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const wire = join('src', 'shared', 'ipc', 'wire')
const wireFiles = readdirSync(wire).filter(name => name.endsWith('.ts')).map(name => join(wire, name))
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : /\.(m?[jt]sx?)$/.test(entry.name) ? [join(directory, entry.name)] : [])
const imports = (source: string): string[] => [...source.matchAll(/\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map(match => match[1] ?? match[2])

describe('IPC wire lint', () => {
  it('keeps the wire code erasable TypeScript, so Node can run it by type stripping', () => {
    expect(wireFiles.map(file => relative(wire, file)).sort()).toEqual(['cells.ts', 'frames.ts', 'msgpack.ts', 'pages.ts', 'protocol.ts'])
    // Strip mode throws on enums, namespaces, parameter properties, and other syntax that needs a transform.
    for (const file of wireFiles) expect(() => stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' }), file).not.toThrow()
  })
  it('imports only sibling wire modules, by their .ts names', () => {
    for (const file of wireFiles) {
      for (const specifier of imports(readFileSync(file, 'utf8'))) expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\/[a-z-]+\.ts$/)
    }
  })
  it('loads every wire module in plain Node 24, as the fake backend does', () => {
    const script = wireFiles.map(file => `await import(${JSON.stringify(pathToFileURL(file).href)})`).join(';')
    const result = spawnSync(process.execPath, ['--input-type=module', '--disable-warning=ExperimentalWarning', '-e', script], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
  it('keeps the method policies loadable by the fake backend: erasable, with type-only imports', () => {
    const file = join('src', 'shared', 'ipc', 'methods.ts')
    const source = readFileSync(file, 'utf8')
    expect(() => stripTypeScriptTypes(source, { mode: 'strip' })).not.toThrow()
    for (const statement of source.match(/^import\b.*$/gm) ?? []) expect(statement).toMatch(/^import type /)
  })
  it('never imports the differential-test MessagePack library from application code', () => {
    for (const file of files('src')) expect(readFileSync(file, 'utf8').includes('@msgpack/msgpack'), file).toBe(false)
  })
})
