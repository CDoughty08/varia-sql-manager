import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { sqlToolsEnvironment } from '../src/main/backend/sqltools-runtime'

describe('bundled SQL language runtime resolution', () => {
  const root = resolve('source checkout'), resourcesPath = resolve('installed app', 'resources')
  it.each([
    ['win32', 'x64', 'win-x64', 'MicrosoftSqlToolsServiceLayer.exe'],
    ['linux', 'x64', 'linux-x64', 'MicrosoftSqlToolsServiceLayer'],
    ['darwin', 'arm64', 'osx-arm64', 'MicrosoftSqlToolsServiceLayer'],
    ['darwin', 'x64', 'osx-x64', 'MicrosoftSqlToolsServiceLayer']
  ] as const)('uses the source artifact for %s/%s', (platform, arch, rid, executable) => {
    expect(sqlToolsEnvironment({ packaged: false, root, resourcesPath, platform, arch, env: { PATH: 'kept' } })).toEqual({
      PATH: 'kept', VARIA_SQLTOOLS_SERVICE_PATH: join(root, 'artifacts', 'sqltools-service', rid, executable), VARIA_SQLTOOLS_SERVICE_SOURCE: 'bundled'
    })
    expect(sqlToolsEnvironment({ packaged: true, root, resourcesPath, platform, arch, env: {} })).toEqual({
      VARIA_SQLTOOLS_SERVICE_PATH: join(resourcesPath, 'sqltools-service', executable), VARIA_SQLTOOLS_SERVICE_SOURCE: 'bundled'
    })
  })
  it('keeps explicit overrides authoritative without changing the caller environment', () => {
    const env = { VARIA_SQLTOOLS_SERVICE_PATH: resolve('trusted override', 'custom.exe'), VARIA_SQLTOOLS_SERVICE_SOURCE: 'bundled', CUSTOM: 'kept' }
    expect(sqlToolsEnvironment({ packaged: true, root, resourcesPath, platform: 'win32', env })).toEqual({ ...env, VARIA_SQLTOOLS_SERVICE_SOURCE: 'override' })
    expect(env.VARIA_SQLTOOLS_SERVICE_SOURCE).toBe('bundled')
    expect(sqlToolsEnvironment({ packaged: false, root, resourcesPath, platform: 'win32', env: { VARIA_SQLTOOLS_SERVICE_PATH: 'invalid-relative.exe' } }).VARIA_SQLTOOLS_SERVICE_PATH).toBe('invalid-relative.exe')
  })
  it('uses the bundle for an empty or whitespace-only override', () => {
    expect(sqlToolsEnvironment({ packaged: true, root, resourcesPath, platform: 'win32', env: { VARIA_SQLTOOLS_SERVICE_PATH: '  ' } }).VARIA_SQLTOOLS_SERVICE_PATH)
      .toBe(join(resourcesPath, 'sqltools-service', 'MicrosoftSqlToolsServiceLayer.exe'))
  })
})
