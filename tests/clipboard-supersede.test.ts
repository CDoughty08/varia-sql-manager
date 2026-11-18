import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { VariaApi } from '../src/shared/contracts'

const ipc = vi.hoisted(() => ({ exposed: undefined as unknown, invoke: undefined as unknown }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const invoke = vi.fn(async () => ({ ok: true }))
  ipc.invoke = invoke
  return {
    contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { ipc.exposed = api } },
    ipcRenderer: Object.assign(new EventEmitter(), { invoke, send: vi.fn() }),
    webUtils: { getPathForFile: () => '' }
  }
})
vi.stubGlobal('window', { addEventListener: () => {}, postMessage: () => {} })

// Any text the page writes to the clipboard supersedes a copy still running: the preload counts the page's writes (a
// local grid's copy stops when the count moves, copy-generation.ts), and main cancels its results copy job.
describe('clipboard writes supersede a running copy', () => {
  it('counts each write the page sends through the preload', async () => {
    await import('../src/preload/index')
    const api = ipc.exposed as VariaApi
    expect(api.clipboardWrites()).toBe(0)
    await api.writeClipboardText('a')
    await api.writeClipboardText('b')
    expect(api.clipboardWrites()).toBe(2)
    expect(ipc.invoke).toHaveBeenCalledWith('varia:clipboard-write', 'b')
  })
  it('cancels main\'s results copy before main writes the text', () => {
    const source = readFileSync('src/main/index.ts', 'utf8')
    const handler = /handle\('varia:clipboard-write',[^\n]*/.exec(source)?.[0] ?? ''
    expect(handler).toMatch(/jobs\.supersedeCopy\(\);\s*clipboard\.writeText\(text\)/)
  })
  it('starts a copy generation for a live grid copying without the menu (SSIS Operations), as output.copy does', () => {
    const source = readFileSync('src/renderer/src/live/LiveGridPane.tsx', 'utf8')
    expect(source).toMatch(/beginCopy\(\); void created\.copy\(/)
  })
})
