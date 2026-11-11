import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { build, type Plugin } from 'vite'
import { domPurifyVersions, patchedDomPurify } from '../electron.vite.config'

// The lowest versions with the security fixes Varia relies on. The audit workflow's npm audit (audit.yml) catches a new advisory; this catches a
// downgrade below a fix offline, in npm run check, including ones the advisory database does not list.
const floors: Record<string, string> = {
  electron: '44.9.1',
  zod: '4.6.6',
  // 26.18 ships the bounded NSIS per-user path copy (build/nsis-check.cjs).
  'app-builder-lib': '26.18.0',
  'electron-builder': '26.18.0',
  // GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr, GHSA-c6gr-qvv4-5v3f (Monaco's markdown hovers).
  dompurify: '3.4.17',
  // GHSA-4w7w-5xrc-9h26 and others: @electron/get's download path when electron installs.
  undici: '7.30.1'
}

const parse = (version: string) => version.split('-')[0].split('.').map(Number)
const atLeast = (version: string, floor: string) => {
  const [a, b] = [parse(version), parse(floor)]
  for (let at = 0; at < 3; at++) if (a[at] !== b[at]) return a[at] > b[at]
  return true
}

describe('dependency floors', () => {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, { version?: string }> }
  it('keeps every installed copy of a security-relevant package at or above its fix', () => {
    for (const [name, floor] of Object.entries(floors)) {
      const copies = Object.entries(lock.packages).filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
      expect(copies.length, name).toBeGreaterThan(0)
      // undici 6 is node-gyp's, outside the 7.x advisories' ranges.
      for (const [path, { version }] of copies) if (!(name === 'undici' && parse(version!)[0] < 7)) expect(atLeast(version!, floor), `${path} ${version} < ${floor}`).toBe(true)
    }
  })
  it('pins dompurify\'s override at or above its floor', () => {
    const { overrides } = JSON.parse(readFileSync('package.json', 'utf8')) as { overrides: Record<string, string> }
    expect(atLeast(overrides.dompurify, floors.dompurify)).toBe(true)
  })
  // Monaco sanitises markdown with a DOMPurify it vendors, which the override and the lockfile never reach (#309): bundle
  // Monaco's sanitiser the way the renderer build does and read the version that ships.
  describe('the DOMPurify Monaco bundles', () => {
    const shipped = async (plugins: Plugin[]) => {
      const built = await build({ configFile: false, logLevel: 'silent', plugins, build: { write: false, minify: true, rollupOptions: { input: 'node_modules/monaco-editor/esm/vs/base/browser/domSanitize.js', preserveEntrySignatures: 'strict' } } })
      return [built].flat().flatMap(result => 'output' in result ? result.output : []).flatMap(chunk => chunk.type === 'chunk' ? domPurifyVersions(chunk.code) : [])
    }
    it('is the installed package, at or above its floor, in place of the vendored copy', async () => {
      const versions = await shipped([patchedDomPurify()])
      expect(versions).toEqual([lock.packages['node_modules/dompurify'].version])
      expect(atLeast(versions[0], floors.dompurify)).toBe(true)
    }, 120_000)
    it('would otherwise be the copy Monaco vendors, which the build refuses below the installed version', async () => {
      const vendored = domPurifyVersions(readFileSync('node_modules/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js', 'utf8'))
      expect(vendored).toHaveLength(1)
      expect(await shipped([])).toEqual(vendored)
      // The plugin's own check on the finished bundle, with its redirect taken away.
      const { resolveId: _, ...checkOnly } = patchedDomPurify()
      const refused = shipped([checkOnly])
      if (vendored[0] === lock.packages['node_modules/dompurify'].version) await expect(refused).resolves.toEqual(vendored)
      else await expect(refused).rejects.toThrow(`ships DOMPurify ${vendored[0]}`)
    }, 120_000)
    it('is in the plugins of the renderer build', () => {
      expect(readFileSync('electron.vite.config.ts', 'utf8')).toMatch(/renderer: \{\s+plugins: \[[^\]]*patchedDomPurify\(\)/)
    })
  })
  it('compares versions numerically', () => {
    expect(atLeast('44.10.2', '44.9.1')).toBe(true)
    expect(atLeast('3.4.16', '3.4.17')).toBe(false)
    expect(atLeast('7.30.1', '7.30.1')).toBe(true)
    expect(atLeast('26.15.0', '26.18.0')).toBe(false)
  })
})
