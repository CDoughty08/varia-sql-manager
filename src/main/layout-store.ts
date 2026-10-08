import { emptyLayoutState, layoutFile, maxLayoutFileBytes, maxLayoutStateBytes, parseLayoutFile, parseLayoutState, type LayoutLoad, type LayoutState, type WorkspaceLayout } from '../shared/layouts'
import { quarantine, readJsonFile, writeJsonAtomic } from './json-file'

/** Only the app-owned preferences path and paths granted by native dialogs are used. */
export class LayoutStore {
  private writes: Promise<void> = Promise.resolve()
  constructor(private path: string) {}
  async load(): Promise<LayoutLoad> {
    await this.writes
    const read = await readJsonFile(this.path, maxLayoutStateBytes)
    if (read.kind === 'missing') return { state: emptyLayoutState() }
    if (read.kind === 'ok') {
      try { return { state: parseLayoutState(read.value) } } catch { /* Quarantined below. */ }
    }
    await quarantine(this.path)
    return { state: emptyLayoutState(), warning: 'Saved layout preferences were invalid. The original file was preserved; the default workspace has been restored.' }
  }
  save(value: unknown): Promise<void> {
    const state = parseLayoutState(value)
    const next = this.writes.then(() => writeJsonAtomic(this.path, state, maxLayoutStateBytes, 'Layout file exceeds its size limit.'))
    this.writes = next.catch(() => {})
    return next
  }
  async import(path: string): Promise<WorkspaceLayout> {
    const read = await readJsonFile(path, maxLayoutFileBytes)
    if (read.kind === 'invalid' && read.tooLarge) throw new Error('Layout file exceeds its size limit.')
    if (read.kind !== 'ok') throw new Error('Invalid or unsupported Varia layout file.')
    return parseLayoutFile(read.value)
  }
  async export(path: string, layout: WorkspaceLayout): Promise<void> { await writeJsonAtomic(path, layoutFile(layout), maxLayoutFileBytes, 'Layout file exceeds its size limit.') }
}

export type { LayoutState }
