import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// The lowest versions with the security fixes Varia relies on. CI's npm audit (ci.yml) catches a new advisory; this catches a
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
  it('compares versions numerically', () => {
    expect(atLeast('44.10.2', '44.9.1')).toBe(true)
    expect(atLeast('3.4.16', '3.4.17')).toBe(false)
    expect(atLeast('7.30.1', '7.30.1')).toBe(true)
    expect(atLeast('26.15.0', '26.18.0')).toBe(false)
  })
})
