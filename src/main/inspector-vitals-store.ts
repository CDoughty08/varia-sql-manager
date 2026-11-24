import {
  defaultInspectorVitalsPrefs, inspectorVitalsFile, parseInspectorVitalsFile, parseInspectorVitalsPrefs, vitalsLimits,
  type InspectorVitalsLoad, type InspectorVitalsPrefs
} from '../shared/inspector-vitals'
import { quarantine, readJsonFile, writeBytesAtomic, type JsonInvalidReason, type JsonRead } from './json-file'

/** Fixed sentences: never file content, paths or raw file-system errors. */
export const inspectorVitalsSentences = {
  unreadable: 'Inspector Vitals preferences could not be read, so changes are not saved.',
  tooLarge: `Inspector Vitals preferences exceed their size limit of ${vitalsLimits.fileBytes / 1024} KiB.`,
  saveFailed: 'Inspector Vitals preferences could not be saved: the file could not be written.'
} as const

const reasons: Record<JsonInvalidReason | 'values', string> = {
  size: `larger than ${vitalsLimits.fileBytes / 1024} KiB`, encoding: 'not UTF-8', json: 'not valid JSON', values: 'unsupported values'
}

/**
 * `<userData>/inspector-vitals.json`: separate open/width preferences for Full vs. Peek Vitals rails.
 * Follows `ShortcutStore`: work runs one task at a time; an unreadable file (permissions, lock, folder at path) sets
 * `readFailed` before the first successful load so later saves never overwrite it, and every error is a fixed sentence.
 */
export interface InspectorVitalsStoreIo {
  readonly readJsonFile: typeof readJsonFile
  readonly quarantine: typeof quarantine
  readonly writeBytesAtomic: typeof writeBytesAtomic
}

const defaultIo: InspectorVitalsStoreIo = { readJsonFile, quarantine, writeBytesAtomic }

export class InspectorVitalsStore {
  private queue: Promise<void> = Promise.resolve()
  private loaded = false
  private readFailed = false
  constructor(private readonly path: string, private readonly io: InspectorVitalsStoreIo = defaultIo) {}

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.then(() => {}, () => {})
    return next
  }

  load(): Promise<InspectorVitalsLoad> {
    return this.serial(async () => {
      let read: JsonRead
      try { read = await this.io.readJsonFile(this.path, vitalsLimits.fileBytes) } catch {
        if (!this.loaded) this.readFailed = true
        throw new Error(inspectorVitalsSentences.unreadable)
      }
      if (read.kind === 'missing') {
        this.loaded = true
        this.readFailed = false
        return { prefs: defaultInspectorVitalsPrefs() }
      }
      if (read.kind === 'ok') {
        try {
          const prefs = parseInspectorVitalsFile(read.value)
          this.loaded = true
          this.readFailed = false
          return { prefs }
        } catch { /* Quarantined below. */ }
      }
      try { await this.io.quarantine(this.path) } catch {
        if (!this.loaded) this.readFailed = true
        throw new Error(inspectorVitalsSentences.unreadable)
      }
      this.loaded = true
      this.readFailed = false
      const reason = reasons[read.kind === 'invalid' ? read.reason ?? 'json' : 'values']
      return {
        prefs: defaultInspectorVitalsPrefs(),
        warning: `Inspector Vitals preferences were invalid (${reason}) and were reset; the original file was kept.`
      }
    })
  }

  save(value: unknown): Promise<InspectorVitalsPrefs> {
    const normalized = parseInspectorVitalsPrefs(value)
    const file = inspectorVitalsFile(normalized)
    return this.serial(async () => {
      if (this.readFailed) throw new Error(inspectorVitalsSentences.unreadable)
      const bytes = Buffer.from(JSON.stringify(file, null, 2) + '\n')
      if (bytes.length > vitalsLimits.fileBytes) throw new Error(inspectorVitalsSentences.tooLarge)
      try { await this.io.writeBytesAtomic(this.path, bytes) } catch { throw new Error(inspectorVitalsSentences.saveFailed) }
      return normalized
    })
  }
}
