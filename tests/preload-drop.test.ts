import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installFileDrop, maxDroppedFiles, type FileDragEvent, type FileDropTarget } from '../src/preload/drop'

/** A window stand-in: the listeners the preload adds, in order, and a way to dispatch an event to them. */
function target() {
  const listeners: { type: string; listener: (event: FileDragEvent) => void; capture: boolean }[] = []
  const window: FileDropTarget = { addEventListener: (type, listener, options) => { listeners.push({ type, listener, capture: options.capture }) } }
  const dispatch = (type: 'dragenter' | 'dragover' | 'dragleave' | 'drop', event: FileDragEvent) => { for (const entry of listeners) if (entry.type === type) entry.listener(event) }
  return { window, listeners, dispatch }
}
const file = (name: string) => ({ name }) as File
function drag(options: { trusted?: boolean; types?: string[]; files?: File[] } = {}) {
  const dataTransfer = { types: options.types ?? ['Files'], files: options.files ?? [file('a.sql')], dropEffect: 'none' }
  return { isTrusted: options.trusted ?? true, dataTransfer, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() } satisfies FileDragEvent
}
function installed() {
  const page = target(), send = vi.fn<(paths: string[]) => void>()
  // A file a script made has no path: Electron answers ''.
  installFileDrop(page.window, { pathForFile: dropped => dropped.name === 'script' ? '' : `C:\\drop\\${dropped.name}`, send })
  return { ...page, send }
}

describe('file drops (preload)', () => {
  it('listens in the capture phase, so it comes before Monaco and the page', () => {
    const { listeners } = installed()
    expect(listeners.map(entry => [entry.type, entry.capture])).toEqual([['dragenter', true], ['dragover', true], ['dragleave', true], ['drop', true]])
  })
  it('accepts a trusted drag of files as a copy, and opens what is dropped without the page seeing it', () => {
    const { dispatch, send } = installed()
    // Monaco never sees the drag: its drop caret would stay, since the drop that would remove it does not reach it.
    for (const type of ['dragenter', 'dragover', 'dragleave'] as const) {
      const over = drag()
      dispatch(type, over)
      expect(over.preventDefault).toHaveBeenCalled()
      expect(over.stopImmediatePropagation).toHaveBeenCalled()
      expect(over.dataTransfer.dropEffect).toBe('copy')
    }
    const drop = drag({ files: [file('a.sql'), file('b.sql')] })
    dispatch('drop', drop)
    expect(drop.preventDefault).toHaveBeenCalled()
    expect(drop.stopImmediatePropagation).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(['C:\\drop\\a.sql', 'C:\\drop\\b.sql'])
  })
  it('ignores untrusted events, which page script can make', () => {
    const { dispatch, send } = installed()
    const over = drag({ trusted: false }), drop = drag({ trusted: false })
    dispatch('dragenter', over)
    dispatch('dragover', over)
    dispatch('drop', drop)
    expect(over.preventDefault).not.toHaveBeenCalled()
    expect(over.stopImmediatePropagation).not.toHaveBeenCalled()
    expect(drop.preventDefault).not.toHaveBeenCalled()
    expect(drop.stopImmediatePropagation).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
  it('passes other drags through: Object Explorer nodes, panels and text carry no files', () => {
    const { dispatch, send } = installed()
    for (const types of [['application/x-varia-explorer', 'text/plain'], ['text/plain'], []]) {
      const over = drag({ types }), drop = drag({ types })
      dispatch('dragenter', over)
      dispatch('dragover', over)
      dispatch('dragleave', over)
      dispatch('drop', drop)
      expect(over.preventDefault).not.toHaveBeenCalled()
      expect(over.stopImmediatePropagation).not.toHaveBeenCalled()
      expect(drop.preventDefault).not.toHaveBeenCalled()
      expect(drop.stopImmediatePropagation).not.toHaveBeenCalled()
    }
    expect(send).not.toHaveBeenCalled()
  })
  it('drops files without a path and keeps at most 32, sending nothing when none is left', () => {
    const { dispatch, send } = installed()
    dispatch('drop', drag({ files: [file('script')] }))
    expect(send).not.toHaveBeenCalled()
    dispatch('drop', drag({ files: [file('script'), ...Array.from({ length: 40 }, (_, index) => file(`${index}.sql`))] }))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toHaveLength(maxDroppedFiles)
    expect(send.mock.calls[0][0][0]).toBe('C:\\drop\\0.sql')
  })
})

describe('the sandboxed preload', () => {
  it('gives window.varia no drop or path method: the paths go from the preload to main only', () => {
    const source = readFileSync(join('src', 'preload', 'index.ts'), 'utf8')
    const api = source.slice(source.indexOf('const api: VariaApi = {'), source.indexOf('contextBridge.exposeInMainWorld'))
    expect(api).not.toMatch(/getPathForFile|files-dropped|webUtils/)
    expect(source.match(/varia:files-dropped/g)).toHaveLength(1)
    expect(source).toContain("installFileDrop(window, { pathForFile: file => webUtils.getPathForFile(file), send: paths => { ipcRenderer.send('varia:files-dropped', paths) } })")
  })
  it('bundles drop.ts into one file that requires only electron, as a sandboxed preload must', async () => {
    const { resolveConfig } = await import('electron-vite')
    const { build } = await import('vite')
    const resolved = await resolveConfig({ root: process.cwd(), logLevel: 'silent' }, 'build', 'production')
    const preload = resolved.config?.preload
    if (!preload) throw new Error('electron.vite.config.ts has no preload build.')
    const result = await build({ ...preload, logLevel: 'silent', build: { ...preload.build, write: false, minify: false } })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
    expect(outputs.map(output => output.fileName)).toEqual(['index.cjs'])
    const code = outputs[0].type === 'chunk' ? outputs[0].code : ''
    expect([...new Set([...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]))]).toEqual(['electron'])
    expect(code).toContain('function installFileDrop(')
  }, 60_000)
})
