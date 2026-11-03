import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ActionProgress } from '../src/shared/actions/schema'
import type { VariaApi } from '../src/shared/contracts'

const ipc = vi.hoisted(() => ({ exposed: undefined as unknown, renderer: undefined as unknown }))
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  const renderer = new Emitter()
  ipc.renderer = renderer
  return {
    contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { ipc.exposed = api } },
    ipcRenderer: Object.assign(renderer, { invoke: vi.fn(), send: vi.fn() }),
    webUtils: { getPathForFile: () => '' }
  }
})
vi.stubGlobal('window', { addEventListener: () => {}, postMessage: () => {} })

describe('preload onActionProgress', () => {
  it('passes only requestId, step and percent from varia:actions-progress, until unsubscribed', async () => {
    await import('../src/preload/index')
    const api = ipc.exposed as VariaApi, renderer = ipc.renderer as EventEmitter
    const seen: ActionProgress[] = []
    const unsubscribe = api.onActionProgress(progress => seen.push(progress))
    renderer.emit('varia:actions-progress', {}, { requestId: 'r', step: 1, percent: 40, sql: 'BACKUP DATABASE x', extra: true })
    expect(seen).toEqual([{ requestId: 'r', step: 1, percent: 40 }])
    expect(Object.keys(seen[0]!)).toEqual(['requestId', 'step', 'percent'])
    unsubscribe()
    renderer.emit('varia:actions-progress', {}, { requestId: 'r', step: 1, percent: 50 })
    expect(seen).toHaveLength(1)
    expect(renderer.listenerCount('varia:actions-progress')).toBe(0)
  })
})
