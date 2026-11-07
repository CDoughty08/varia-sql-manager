import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { FuseV1Options, FuseVersion } from '@electron/fuses'

const require = createRequire(import.meta.url)
const { fuses, fuseConfig, fuseMismatches, fuseTarget } = require('../build/fuses.cjs')
const afterPack = require('../build/after-pack.cjs')

describe('Electron fuses', () => {
  it('turn off file: privileges, Node mode, NODE_OPTIONS and --inspect, and load only the checked app.asar', () => {
    expect(fuses).toEqual({
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true
    })
    expect(fuseConfig('win32')).toEqual({ version: FuseVersion.V1, resetAdHocDarwinSignature: false, ...fuses })
    expect(fuseConfig('darwin').resetAdHocDarwinSignature).toBe(true)
  })

  it('are flipped by electron-builder\'s afterPack hook, after the NSIS backport', async () => {
    expect(readFileSync('electron-builder.yml', 'utf8')).toMatch(/^afterPack: build\/after-pack\.cjs$/m)
    // The app must be packed into app.asar for OnlyLoadAppFromAsar: nothing turns asar off.
    expect(readFileSync('electron-builder.yml', 'utf8')).not.toMatch(/^\s*asar:\s*false/m)
    // The NSIS backport patches electron-builder's installed template on Windows, so only the others run here.
    for (const platform of ['linux', 'darwin']) {
      const addElectronFuses = vi.fn(async () => {})
      const context = { electronPlatformName: platform, packager: { addElectronFuses } }
      await afterPack(context)
      expect(addElectronFuses).toHaveBeenCalledWith(context, fuseConfig(platform))
    }
  })

  it('are read back from a packaged executable by name', () => {
    const on = 49, off = 48
    const applied = { version: '1', 0: off, 1: on, 2: off, 3: off, 4: on, 5: on, 6: off, 7: off }
    expect(fuseMismatches(applied)).toEqual([])
    expect(fuseMismatches({ ...applied, 7: on, 3: 144 })).toEqual(['EnableNodeCliInspectArguments', 'GrantFileProtocolExtraPrivileges'])
    expect(fuseTarget('dist/mac-arm64/Varia SQL Manager.app/Contents/MacOS/Varia SQL Manager')).toBe('dist/mac-arm64/Varia SQL Manager.app')
    expect(fuseTarget('dist/win-unpacked/Varia SQL Manager.exe')).toBe('dist/win-unpacked/Varia SQL Manager.exe')
  })
})
