import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { classifyVitestIsolation, classifyVitestOsScope, vitestFiles } from '../scripts/vitest-scope.mjs'

describe('Vitest isolation and OS scope classification', () => {
  const all = vitestFiles()

  it('partitions every Vitest file exactly once between stateless and isolated projects', () => {
    const { stateless, isolated } = classifyVitestIsolation()
    expect(stateless.length).toBeGreaterThan(200)
    expect(isolated.length).toBeGreaterThan(100)
    expect([...stateless, ...isolated].sort()).toEqual([...all].sort())
    expect(new Set([...stateless, ...isolated]).size).toBe(all.length)
  })

  it('keeps DOM, mocked, timer, env-mutating, child_process and backend-sidecar files strictly isolated', () => {
    const { stateless, isolated } = classifyVitestIsolation()
    const isolatedSet = new Set(isolated)
    for (const file of ['tests/backend-sidecar.test.ts', 'tests/comparison-toolbar.test.ts', 'tests/smoke-shards.test.ts', 'tests/settings-store.test.ts']) {
      expect(isolatedSet.has(file), file).toBe(true)
    }
    for (const file of stateless) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/@vitest-environment\s+/)
      expect(source, file).not.toMatch(/from\s+['"]react-dom(?:\/|['"])/)
      expect(source, file).not.toMatch(/\bvi\.(?:mock|doMock|stubGlobal|stubEnv|useFakeTimers)\s*\(/)
      expect(source, file).not.toMatch(/from\s+['"](?:node:)?child_process['"]/)
      expect(source, file).not.toMatch(/\bprocess\.env(?:\s*\[|\.\w+\s*=)|\bdelete\s+process\.env\b/)
    }
  })

  it('partitions every Vitest file exactly once by OS sensitivity and keeps every main/scripts/platform/sidecar test on all OSes', () => {
    const { osSensitive, platformIndependent } = classifyVitestOsScope()
    const osSet = new Set(osSensitive)
    expect([...osSensitive, ...platformIndependent].sort()).toEqual([...all].sort())
    expect(osSensitive.length).toBeGreaterThan(100)
    expect(platformIndependent.length).toBeGreaterThan(200)
    for (const file of ['tests/backend-sidecar.test.ts', 'tests/settings-store.test.ts', 'tests/update-install.test.ts', 'tests/saved-passwords.test.ts', 'tests/launch-files.test.ts']) {
      expect(osSet.has(file), file).toBe(true)
    }
    for (const file of platformIndependent) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/from\s+['"][^'"]*(?:src\/main\/|scripts\/|build\/)/)
      expect(source, file).not.toMatch(/\bprocess\.platform\b/)
      expect(source, file).not.toMatch(/from\s+['"](?:node:)?child_process['"]/)
    }
  })
})
