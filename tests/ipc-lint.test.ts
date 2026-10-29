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
  it('loads the results worker core in plain Node 24, as the IPC benchmark\'s results thread does', () => {
    const core = pathToFileURL(join('src', 'renderer', 'src', 'results', 'worker-core.ts')).href
    // tests/bench/results-thread.mjs's resolve hook: the renderer's imports leave out the .ts extension.
    const script = `import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context) } catch (error) { if (!specifier.startsWith('.') || /\\.[cm]?[jt]s$/.test(specifier)) throw error; return next(specifier + '.ts', context) } } })
await import(${JSON.stringify(core)})`
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
  it('honours the backend test seams only in unpackaged smoke runs', () => {
    const main = readFileSync(join('src', 'main', 'index.ts'), 'utf8')
    expect(main).toContain("const testSeams = process.env.VARIA_SMOKE_TEST === '1' && !app.isPackaged")
    expect(main.match(/installTestHooks\(|VARIA_BACKEND_LIVENESS_MS|--varia-test-mode|VARIA_TEST_SAFE_STORAGE|testCipher\(/g)).toHaveLength(5)
    expect(main).toContain('if (testSeams) testHooks = installTestHooks(backend, results)')
    // Test-only live sources (debug.synthetic) pass main's port schema only in unpackaged smoke runs.
    expect(main).toContain('createChannel: () => new MessageChannelMain(), testSources: testSeams })')
    expect(main).toContain('const livenessMs = testSeams ? Number(process.env.VARIA_BACKEND_LIVENESS_MS) : NaN')
    expect(main).toContain("...(testSeams ? ['--varia-test-mode'] : [])")
    // Remember password's reversible test cipher, for smoke runs on machines without a keyring.
    expect(main).toContain("const secretCipher = testSeams && process.env.VARIA_TEST_SAFE_STORAGE === 'test' ? testCipher() : safeStorageCipher(safeStorage, process.platform)")
    // The fake backend is chosen in the spawn spec, after the packaged branch and only for smoke tests.
    const spec = readFileSync(join('src', 'main', 'backend', 'spawn-spec.ts'), 'utf8')
    expect(spec.indexOf('if (o.packaged) return')).toBeLessThan(spec.indexOf('VARIA_TEST_BACKEND :'))
    expect(spec).toContain('const fake = o.smokeTest ? o.env?.VARIA_TEST_BACKEND : undefined')
    // The backend's own hooks (synthetic results, a budget override) are removed from its environment outside smoke runs.
    expect(spec.match(/withoutTestHooks\(o\.env\)/g)).toHaveLength(2)
    expect(spec).toContain('delete copy.VARIA_BACKEND_TEST_HOOKS')
    expect(spec).toContain('delete copy.VARIA_RESULT_BUDGET_BYTES')
  })
  it('checks the backend answers that have a result schema before the renderer sees them', () => {
    const main = readFileSync(join('src', 'main', 'index.ts'), 'utf8')
    const handler = main.slice(main.indexOf("ipcMain.handle('varia:request'"), main.indexOf("handle('varia:explorer-cancel'"))
    expect(handler.indexOf('result = validateResult(method as RpcMethod, result)')).toBeGreaterThan(handler.indexOf('result = await backend.request('))
    expect(handler.indexOf('result = validateResult(method as RpcMethod, result)')).toBeLessThan(handler.indexOf('return { ok: true, value: result }'))
  })
  it('offers developer tools in every build, as VS Code does, and keeps the page sandboxed', () => {
    const main = readFileSync(join('src', 'main', 'index.ts'), 'utf8')
    // One window setting, the same whether packaged or not; the page keeps its isolation and sandbox.
    expect(main.match(/devTools:/g)).toEqual(['devTools:'])
    expect(main).toContain('devTools: true }')
    expect(main).toContain('contextIsolation: true, nodeIntegration: false, sandbox: true')
    // Nothing tells the page whether it may offer them: the command, its menu item and its key exist everywhere.
    const sources = readdirSync('src', { recursive: true, encoding: 'utf8' }).filter(file => /\.tsx?$/.test(file)).map(file => readFileSync(join('src', file), 'utf8')).join('\n')
    expect(sources).not.toMatch(/varia-developer-tools|developerTools|\.development\b/)
  })
  it('forwards result pages to the renderer only as exact-size ArrayBuffers', () => {
    const port = readFileSync(join('src', 'main', 'backend', 'results-port.ts'), 'utf8')
    const pages = [...port.matchAll(/t: 'page'[^}]*\}/g)].map(match => match[0])
    expect(pages.length).toBeGreaterThan(0)
    for (const page of pages) expect(page).toMatch(/body: toExactArrayBuffer\(/)
    // Main never decodes DATA: the page codec stays out of main.
    for (const file of files(join('src', 'main'))) expect(readFileSync(file, 'utf8').includes('wire/pages'), file).toBe(false)
  })
  it('never imports the differential-test MessagePack library from application code', () => {
    for (const file of files('src')) expect(readFileSync(file, 'utf8').includes('@msgpack/msgpack'), file).toBe(false)
  })
})
