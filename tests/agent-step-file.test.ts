import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentLimits } from '../src/shared/agent/catalog'
import { isStepScriptSubsystem, stepScriptFileKinds, stepScriptLimits, stepScriptOpenSchema, stepScriptText } from '../src/shared/agent/step-file'
import { readStepScript } from '../src/main/step-script-file'

let folder: string
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'varia-step-file-')) })
afterEach(async () => { await rm(folder, { recursive: true, force: true }) })

const read = (name: string, limits?: { chars: number; bytes: number }) => readStepScript(join(folder, name), { legacyLabel: 'windows-1252', ...limits ? { limits } : {} })
const put = async (name: string, data: string | Uint8Array) => { await writeFile(join(folder, name), data); return name }

describe('agentStepScript.open validation (AG-11)', () => {
  it('takes only a CmdExec or PowerShell step type, and never a path', () => {
    expect(stepScriptOpenSchema.parse({ subsystem: 'PowerShell' })).toEqual({ subsystem: 'PowerShell' })
    expect(stepScriptOpenSchema.parse({ subsystem: 'CmdExec' })).toEqual({ subsystem: 'CmdExec' })
    for (const value of [{ subsystem: 'TSQL' }, { subsystem: 'SSIS' }, { subsystem: 'cmdexec' }, {}, null, 'CmdExec', { subsystem: 'CmdExec', path: 'C:\\x.bat' }, { subsystem: 'CmdExec', defaultPath: '/etc' }])
      expect(stepScriptOpenSchema.safeParse(value).success).toBe(false)
    expect(isStepScriptSubsystem('PowerShell')).toBe(true)
    expect(isStepScriptSubsystem('TSQL')).toBe(false)
    expect(isStepScriptSubsystem('toString')).toBe(false)
  })
  it('filters to each type\'s scripts', () => {
    expect(stepScriptFileKinds.PowerShell.filter.extensions).toEqual(['ps1', 'psm1', 'psd1'])
    expect(stepScriptFileKinds.CmdExec.filter.extensions).toEqual(['bat', 'cmd'])
    expect(stepScriptLimits.chars).toBe(agentLimits.stepCommandChars)
  })
})

describe('reading a step script (AG-11)', () => {
  it('detects the encoding as Open does and returns only the text', async () => {
    const text = 'Write-Output "Grüße 日本"\r\nGet-Date\r\n'
    expect(await read(await put('utf8.ps1', text))).toBe(text)
    expect(await read(await put('bom.ps1', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])))).toBe(text)
    expect(await read(await put('utf16.ps1', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])))).toBe(text)
    expect(await read(await put('utf16nobom.ps1', Buffer.from(text, 'utf16le')))).toBe(text)
    // Windows-1252 'é' (0xE9) is not valid UTF-8: the ANSI code page reads it.
    expect(await read(await put('ansi.bat', Buffer.from([0x65, 0x63, 0x68, 0x6f, 0x20, 0xe9])))).toBe('echo é')
    expect(await read(await put('empty.cmd', ''))).toBe('')
  })
  it('refuses a file past the step command\'s limit, in bytes and in characters', async () => {
    const limits = { chars: 10, bytes: 40 }
    expect(await read(await put('fits.bat', 'x'.repeat(10)), limits)).toBe('x'.repeat(10))
    await expect(read(await put('chars.bat', 'x'.repeat(11)), limits)).rejects.toThrow(stepScriptText.tooLarge)
    await expect(read(await put('bytes.bat', 'x'.repeat(41)), limits)).rejects.toThrow(stepScriptText.tooLarge)
    // The real limits: UTF-8 at three bytes a character still fits; one character more does not.
    await expect(read(await put('big.ps1', 'x'.repeat(agentLimits.stepCommandChars + 1)))).rejects.toThrow(stepScriptText.tooLarge)
    expect((await read(await put('wide.ps1', '日'.repeat(agentLimits.stepCommandChars)))).length).toBe(agentLimits.stepCommandChars)
  })
  it('refuses binary files, folders, missing files and relative paths with a reason', async () => {
    await expect(read(await put('tool.exe', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00])))).rejects.toThrow(stepScriptText.notText)
    await expect(read(await put('utf32.ps1', Buffer.from([0xff, 0xfe, 0, 0, 0x41, 0, 0, 0])))).rejects.toThrow('UTF-32')
    await mkdir(join(folder, 'scripts'))
    await expect(read('scripts')).rejects.toThrow(/not a file/)
    await expect(read('missing.ps1')).rejects.toThrow('The file does not exist.')
    await expect(readStepScript('relative.ps1', { legacyLabel: 'windows-1252' })).rejects.toThrow(stepScriptText.notFile)
  })
})
