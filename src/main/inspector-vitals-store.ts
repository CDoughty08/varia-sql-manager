import {
  defaultInspectorVitalsPrefs, inspectorVitalsFile, parseInspectorVitalsFile, parseInspectorVitalsPrefs, vitalsLimits,
  type InspectorVitalsLoad, type InspectorVitalsPrefs
} from '../shared/inspector-vitals'
import { quarantine, readJsonFile, writeJsonAtomic, type JsonInvalidReason } from './json-file'

const reasons: Record<JsonInvalidReason | 'values', string> = {
  size: `larger than ${vitalsLimits.fileBytes / 1024} KiB`, encoding: 'not UTF-8', json: 'not valid JSON', values: 'unsupported values'
}

/** `<userData>/inspector-vitals.json`: separate open/width preferences for Full vs. Peek Vitals rails. */
export class InspectorVitalsStore {
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly path: string) {}
  async load(): Promise<InspectorVitalsLoad> {
    await this.writes
    const read = await readJsonFile(this.path, vitalsLimits.fileBytes)
    if (read.kind === 'missing') return { prefs: defaultInspectorVitalsPrefs() }
    if (read.kind === 'ok') {
      try { return { prefs: parseInspectorVitalsFile(read.value) } } catch { /* Quarantined below. */ }
    }
    await quarantine(this.path)
    const reason = reasons[read.kind === 'invalid' ? read.reason ?? 'json' : 'values']
    return {
      prefs: defaultInspectorVitalsPrefs(),
      warning: `Inspector Vitals preferences were invalid (${reason}) and were reset; the original file was kept.`
    }
  }
  save(value: unknown): Promise<InspectorVitalsPrefs> {
    const normalized = parseInspectorVitalsPrefs(value)
    const file = inspectorVitalsFile(normalized)
    const next = this.writes.then(() => writeJsonAtomic(this.path, file, vitalsLimits.fileBytes, 'Inspector Vitals preferences exceed their size limit.'))
    this.writes = next.catch(() => {})
    return next.then(() => normalized)
  }
}
