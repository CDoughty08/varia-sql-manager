import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import {
  clampVitalsWidth, defaultInspectorVitals, defaultInspectorVitalsPrefs, parseInspectorVitalsFile,
  parseInspectorVitalsPrefs, vitalsLimits, vitalsMaxWidth, vitalsWidthKey
} from '../src/shared/inspector-vitals'
import { InspectorVitalsStore, inspectorVitalsSentences } from '../src/main/inspector-vitals-store'
import { quarantine, readJsonFile, writeBytesAtomic } from '../src/main/json-file'
import { InspectorService } from '../src/renderer/src/services/inspector'

let directory: string
beforeEach(async () => {
  await mkdir('artifacts', { recursive: true })
  directory = await mkdtemp(join(resolve('artifacts'), 'inspector-vitals-test-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  expect(directory.startsWith(resolve('artifacts') + sep)).toBe(true)
  await rm(directory, { recursive: true, force: true })
})

describe('inspector vitals clamping and keyboard math', () => {
  it('bounds width to [200, min(440, 48% of container)] and falls back to surface defaults on non-finite input', () => {
    expect(vitalsMaxWidth(undefined)).toBe(440)
    expect(vitalsMaxWidth(1200)).toBe(440)
    expect(vitalsMaxWidth(800)).toBe(384)
    expect(vitalsMaxWidth(680)).toBe(326)
    // Very narrow container still yields max >= min so min <= max always holds.
    expect(vitalsMaxWidth(300)).toBe(200)

    expect(clampVitalsWidth(120, 'full')).toBe(200)
    expect(clampVitalsWidth(520, 'full')).toBe(440)
    expect(clampVitalsWidth(400, 'full', 700)).toBe(336)
    expect(clampVitalsWidth(265.6, 'full')).toBe(266)
    expect(clampVitalsWidth(Number.NaN, 'full')).toBe(272)
    expect(clampVitalsWidth(Number.POSITIVE_INFINITY, 'peek')).toBe(236)
  })

  it('steps ±16 px on ArrowLeft/ArrowRight and resets to each surface default on Home', () => {
    // Docked on the right: ArrowLeft widens (+16), ArrowRight narrows (-16).
    expect(vitalsWidthKey(272, 'ArrowLeft', 'full')).toBe(288)
    expect(vitalsWidthKey(272, 'ArrowRight', 'full')).toBe(256)
    expect(vitalsWidthKey(204, 'ArrowRight', 'full')).toBe(200)
    expect(vitalsWidthKey(436, 'ArrowLeft', 'full')).toBe(440)
    expect(vitalsWidthKey(330, 'ArrowLeft', 'full', 700)).toBe(336)
    expect(vitalsWidthKey(350, 'Home', 'full')).toBe(defaultInspectorVitals.full.width)
    expect(vitalsWidthKey(350, 'Home', 'peek')).toBe(defaultInspectorVitals.peek.width)
    expect(vitalsWidthKey(272, 'Enter', 'full')).toBeUndefined()
  })

  it('validates schemas strictly while clamping out-of-range numeric widths', () => {
    expect(parseInspectorVitalsFile({ version: 1, full: { open: false, width: 999 }, peek: { open: true, width: 42 } })).toEqual({
      full: { open: false, width: 440 },
      peek: { open: true, width: 200 }
    })
    expect(parseInspectorVitalsPrefs({ full: { open: true, width: 280.4 }, peek: { open: false, width: 220.6 } })).toEqual({
      full: { open: true, width: 280 },
      peek: { open: false, width: 221 }
    })
    for (const bad of [
      null, {}, { version: 2, full: { open: true, width: 272 }, peek: { open: true, width: 236 } },
      { version: 1, full: { open: true, width: 272 }, peek: { open: true, width: 236 }, extra: true },
      { version: 1, full: { open: 'yes', width: 272 }, peek: { open: true, width: 236 } },
      { version: 1, full: { open: true, width: Number.NaN }, peek: { open: true, width: 236 } }
    ]) {
      expect(() => parseInspectorVitalsFile(bad), JSON.stringify(bad)).toThrow()
    }
  })
})

describe('InspectorVitalsStore persistence', () => {
  const path = () => join(directory, 'inspector-vitals.json')

  it('returns defaults without writing when the file is missing', async () => {
    const loaded = await new InspectorVitalsStore(path()).load()
    expect(loaded).toEqual({ prefs: defaultInspectorVitalsPrefs() })
    expect(await readdir(directory)).toEqual([])
  })

  it('persists full and peek independently, atomically, and clamps out-of-range widths on save and load', async () => {
    const store = new InspectorVitalsStore(path())
    const saved = await store.save({ full: { open: false, width: 340 }, peek: { open: true, width: 215 } })
    expect(saved).toEqual({ full: { open: false, width: 340 }, peek: { open: true, width: 215 } })

    // Updating peek leaves full intact.
    await store.save({ ...saved, peek: { open: false, width: 260 } })
    const reloaded = await new InspectorVitalsStore(path()).load()
    expect(reloaded).toEqual({ prefs: { full: { open: false, width: 340 }, peek: { open: false, width: 260 } } })
    expect(await readdir(directory)).toEqual(['inspector-vitals.json'])

    // Out-of-range widths on disk clamp without quarantining a valid file.
    await writeFile(path(), JSON.stringify({ version: 1, full: { open: true, width: 900 }, peek: { open: false, width: 10 } }))
    const clamped = await new InspectorVitalsStore(path()).load()
    expect(clamped).toEqual({ prefs: { full: { open: true, width: 440 }, peek: { open: false, width: 200 } } })
    expect(clamped.warning).toBeUndefined()
  })

  it('serializes concurrent atomic writes and rejects invalid payloads without touching disk', async () => {
    const store = new InspectorVitalsStore(path())
    const widths = [210, 260, 310, 360]
    await Promise.all(widths.map(width => store.save({ full: { open: true, width }, peek: { open: true, width: 236 } })))
    expect(JSON.parse(await readFile(path(), 'utf8'))).toEqual({
      version: 1, full: { open: true, width: 360 }, peek: { open: true, width: 236 }
    })
    expect(() => store.save({ full: { open: true, width: 272, extra: 1 }, peek: { open: true, width: 236 } })).toThrow()
    expect((await store.load()).prefs.full.width).toBe(360)
  })

  it('quarantines invalid files, preserves their bytes, and reports why', async () => {
    const cases: [string | Buffer, string][] = [
      ['{"version":1,', 'not valid JSON'],
      ['{"version":2,"full":{"open":true,"width":272},"peek":{"open":true,"width":236}}', 'unsupported values'],
      ['{"version":1,"full":{"open":true,"width":272},"peek":{"open":true,"width":236},"extra":1}', 'unsupported values'],
      [Buffer.from([0xff, 0xfe, 0x7b]), 'not UTF-8'],
      [' '.repeat(vitalsLimits.fileBytes + 1), 'larger than 4 KiB']
    ]
    for (const [content, reason] of cases) {
      await rm(directory, { recursive: true, force: true })
      await mkdir(directory)
      await writeFile(path(), content)
      const result = await new InspectorVitalsStore(path()).load()
      expect(result.prefs).toEqual(defaultInspectorVitalsPrefs())
      expect(result.warning).toBe(`Inspector Vitals preferences were invalid (${reason}) and were reset; the original file was kept.`)
      const [kept, ...rest] = await readdir(directory)
      expect(rest).toEqual([])
      expect(kept).toMatch(/^inspector-vitals\.json\.invalid-[0-9a-f-]{36}\.json$/)
      expect(await readFile(join(directory, kept))).toEqual(Buffer.from(content))
    }
  })

  it('refuses saves with a fixed sentence after a failed read or quarantine, leaves the file untouched, and recovers on the next successful load', async () => {
    const original = JSON.stringify({ version: 1, full: { open: false, width: 340 }, peek: { open: true, width: 215 } }, null, 2) + '\n'
    await writeFile(path(), original)

    // Simulate antivirus holding the file at startup (EACCES with full userData path).
    let locked = true
    const store = new InspectorVitalsStore(path(), {
      readJsonFile: async (filePath, limit) => {
        if (locked) throw Object.assign(new Error(`EACCES: permission denied, open '${filePath}'`), { code: 'EACCES' })
        return readJsonFile(filePath, limit)
      },
      quarantine,
      writeBytesAtomic
    })

    await expect(store.load()).rejects.toThrow(inspectorVitalsSentences.unreadable)
    // A subsequent save must be refused with the fixed sentence (no path leak) and never overwrite the existing file.
    const saveError = await store.save({ full: { open: true, width: 272 }, peek: { open: false, width: 250 } }).catch((err: unknown) => err as Error)
    expect(saveError).toBeInstanceOf(Error)
    expect((saveError as Error).message).toBe(inspectorVitalsSentences.unreadable)
    expect((saveError as Error).message).not.toContain(directory)
    expect(await readFile(path(), 'utf8')).toBe(original)

    // Once the lock clears, the next successful load clears readFailed and allows saves again.
    locked = false
    expect(await store.load()).toEqual({ prefs: { full: { open: false, width: 340 }, peek: { open: true, width: 215 } } })
    await store.save({ full: { open: false, width: 340 }, peek: { open: false, width: 250 } })
    expect(JSON.parse(await readFile(path(), 'utf8'))).toEqual({
      version: 1, full: { open: false, width: 340 }, peek: { open: false, width: 250 }
    })

    // Quarantine failure before first successful load also sets readFailed and leaves the invalid file untouched.
    const corrupt = '{not json'
    await writeFile(path(), corrupt)
    const quarantineFailStore = new InspectorVitalsStore(path(), {
      readJsonFile,
      quarantine: async filePath => { throw Object.assign(new Error(`EPERM: operation not permitted, rename '${filePath}'`), { code: 'EPERM' }) },
      writeBytesAtomic
    })
    await expect(quarantineFailStore.load()).rejects.toThrow(inspectorVitalsSentences.unreadable)
    await expect(quarantineFailStore.save({ full: { open: true, width: 272 }, peek: { open: true, width: 236 } })).rejects.toThrow(inspectorVitalsSentences.unreadable)
    expect(await readFile(path(), 'utf8')).toBe(corrupt)

    // Directory at path: fails with fixed sentence and writes nothing; write error also reports fixed sentence without path.
    await rm(path(), { force: true })
    await mkdir(path())
    const dirStore = new InspectorVitalsStore(path())
    const dirErr = await dirStore.load().catch((err: unknown) => err as Error)
    expect((dirErr as Error).message).toBe(inspectorVitalsSentences.unreadable)
    expect((dirErr as Error).message).not.toContain(directory)
    await expect(dirStore.save({ full: { open: true, width: 272 }, peek: { open: true, width: 236 } })).rejects.toThrow(inspectorVitalsSentences.unreadable)
    expect(await readdir(directory)).toEqual(['inspector-vitals.json'])

    const writeFailStore = new InspectorVitalsStore(path(), {
      readJsonFile,
      quarantine,
      writeBytesAtomic: async filePath => { throw new Error(`ENOSPC: no space left on '${filePath}'`) }
    })
    const writeErr = await writeFailStore.save({ full: { open: true, width: 272 }, peek: { open: true, width: 236 } }).catch((err: unknown) => err as Error)
    expect((writeErr as Error).message).toBe(inspectorVitalsSentences.saveFailed)
    expect((writeErr as Error).message).not.toContain(directory)
  })
})

describe('InspectorService', () => {
  it('loads persisted prefs, defers writes during load, reports warnings, and persists merged mutations', async () => {
    let resolveLoad!: (value: { ok: true; value: { prefs: { full: { open: boolean; width: number }; peek: { open: boolean; width: number } }; warning?: string } }) => void
    const loadInspectorVitals = vi.fn(() => new Promise<{ ok: true; value: { prefs: { full: { open: boolean; width: number }; peek: { open: boolean; width: number } }; warning?: string } }>(resolve => { resolveLoad = resolve }))
    const saveInspectorVitals = vi.fn(async prefs => ({ ok: true as const, value: prefs }))
    const report = vi.fn()
    const service = new InspectorService({ api: { loadInspectorVitals, saveInspectorVitals }, platform: 'win32' })
    const loading = service.load()
    // User resizes peek before initial load finishes: write must wait for load so persisted full is never clobbered.
    service.setVitals('peek', { open: false, width: 250 })
    expect(saveInspectorVitals).not.toHaveBeenCalled()
    resolveLoad({ ok: true, value: { prefs: { full: { open: false, width: 320 }, peek: { open: true, width: 210 } }, warning: 'Reset warning.' } })
    await loading
    // Full adopts loaded state; peek preserves the user's newer local edit and persists the merged snapshot once.
    expect(service.vitals.getSnapshot()).toEqual({ full: { open: false, width: 320 }, peek: { open: false, width: 250 } })
    expect(saveInspectorVitals).toHaveBeenCalledTimes(1)
    expect(saveInspectorVitals).toHaveBeenCalledWith({ full: { open: false, width: 320 }, peek: { open: false, width: 250 } })
    service.setReporter(report)
    expect(report).toHaveBeenCalledWith('Reset warning.', 'warning')

    service.resetVitalsWidth('peek')
    expect(service.vitals.getSnapshot().peek.width).toBe(236)
    expect(saveInspectorVitals).toHaveBeenLastCalledWith({ full: { open: false, width: 320 }, peek: { open: false, width: 236 } })
    service.dispose()
  })

  it('buffers load errors that occur before setReporter is attached and preserves edits made during a failed load for recovery', async () => {
    let finishFirst!: (value: { ok: false; error: string }) => void
    const loadInspectorVitals = vi.fn()
      .mockImplementationOnce(() => new Promise<{ ok: false; error: string }>(resolve => { finishFirst = resolve }))
      .mockResolvedValueOnce({ ok: true as const, value: { prefs: { full: { open: false, width: 320 }, peek: { open: true, width: 210 } } } })
    const saveInspectorVitals = vi.fn(async prefs => ({ ok: true as const, value: prefs }))
    const report = vi.fn()
    const service = new InspectorService({ api: { loadInspectorVitals, saveInspectorVitals }, platform: 'win32' })
    const first = service.load()
    // Edit made while the failing load is in flight is held without writing.
    service.setVitals('peek', { open: false, width: 250 })
    expect(saveInspectorVitals).not.toHaveBeenCalled()
    finishFirst({ ok: false, error: inspectorVitalsSentences.unreadable })
    await first
    expect(saveInspectorVitals).not.toHaveBeenCalled()
    service.setReporter(report)
    expect(report).toHaveBeenCalledWith(inspectorVitalsSentences.unreadable, 'error')

    // When a subsequent load succeeds, the preserved peek edit merges with the loaded full surface and persists once.
    await service.load()
    expect(service.vitals.getSnapshot()).toEqual({ full: { open: false, width: 320 }, peek: { open: false, width: 250 } })
    expect(saveInspectorVitals).toHaveBeenCalledTimes(1)
    expect(saveInspectorVitals).toHaveBeenCalledWith({ full: { open: false, width: 320 }, peek: { open: false, width: 250 } })
    service.dispose()
  })

  it('tracks platform modifier hold (Ctrl on Windows/Linux, Meta on macOS) and resets on blur', () => {
    const win = new InspectorService({ platform: 'win32' })
    expect(win.modHeld.getSnapshot()).toBe(false)
    win.keyDown('Meta', false)
    expect(win.modHeld.getSnapshot()).toBe(false)
    win.keyDown('Control', false)
    expect(win.modHeld.getSnapshot()).toBe(true)
    win.keyUp('Control')
    expect(win.modHeld.getSnapshot()).toBe(false)
    win.keyDown('Control', false)
    win.blur()
    expect(win.modHeld.getSnapshot()).toBe(false)
    win.dispose()

    const mac = new InspectorService({ platform: 'darwin' })
    mac.keyDown('Control', false)
    expect(mac.modHeld.getSnapshot()).toBe(false)
    mac.keyDown('Meta', false)
    expect(mac.modHeld.getSnapshot()).toBe(true)
    mac.keyUp('Meta')
    expect(mac.modHeld.getSnapshot()).toBe(false)
    mac.dispose()
  })
})
