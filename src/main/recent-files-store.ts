import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { recentFilesFileSchema, recentFilesLimits, type RecentFile, type RecentFilesFile } from '../shared/files/recent'
import { quarantine, readJsonFile, writeJsonAtomic } from './json-file'
import { samePath } from './sql-files'

type Entry = RecentFilesFile['files'][number]
export interface RecentFilesStoreOptions {
  readonly platform?: NodeJS.Platform
  readonly now?: () => Date
  /** The OS's recent documents (macOS's Dock menu, Windows' jump list), which follow the list. */
  readonly system?: { add(path: string): void; clear(): void }
}

/**
 * `<userData>/recent-files.json`: File › Recent Files, most recent first, at most 50. Reads and writes run one at a time,
 * as the other preference stores' do. An invalid file is quarantined and the list starts empty; a file that cannot be
 * read (permissions, a folder at the path) is never written this session, so it is not replaced. Each path gets a random
 * id for this process, which is all the page uses to name an entry; ids are never stored.
 */
export class RecentFilesStore {
  private queue: Promise<void> = Promise.resolve()
  private loading?: Promise<void>
  private entries: Entry[] = []
  private unreadable = false
  private ids = new Map<string, string>()
  private paths = new Map<string, string>()
  private listeners = new Set<() => void>()
  constructor(private readonly path: string, private readonly options: RecentFilesStoreOptions = {}) {}

  private get platform(): NodeJS.Platform { return this.options.platform ?? process.platform }
  private serial(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task)
    this.queue = next.catch(() => {})
    return next
  }
  /** Reads the file once; later calls share that read. */
  load(): Promise<void> {
    this.loading ??= this.serial(async () => {
      let read
      try { read = await readJsonFile(this.path, recentFilesLimits.fileBytes) }
      catch { this.unreadable = true; return }
      if (read.kind === 'missing') return
      const parsed = read.kind === 'ok' ? recentFilesFileSchema.safeParse(read.value) : undefined
      if (parsed?.success) { this.entries = this.unique(parsed.data.files); this.changed(); return }
      await quarantine(this.path).catch(() => { this.unreadable = true })
    })
    return this.loading
  }
  /** The first `count` entries, as the page shows them. */
  list(count: number = recentFilesLimits.entries): RecentFile[] {
    return this.entries.slice(0, count).map(entry => ({ id: this.idOf(entry.path), name: basename(entry.path).slice(0, recentFilesLimits.nameChars), path: entry.path }))
  }
  /** The path an id stands for, while that path is in the list. */
  pathOf(id: string): string | undefined {
    const path = this.paths.get(id)
    return path !== undefined && this.entries.some(entry => entry.path === path) ? path : undefined
  }
  /** Puts `path` first (opened, or saved under a new name). */
  add(path: string): Promise<void> {
    if (path.length > recentFilesLimits.pathChars) return Promise.resolve()
    return this.update(entries => [{ path, openedAt: (this.options.now?.() ?? new Date()).toISOString() }, ...entries.filter(entry => !samePath(entry.path, path, this.platform))], () => this.options.system?.add(path))
  }
  remove(id: string): Promise<void> {
    const path = this.pathOf(id)
    return path === undefined ? Promise.resolve() : this.update(entries => entries.filter(entry => entry.path !== path))
  }
  clear(): Promise<void> { return this.update(() => [], () => this.options.system?.clear()) }
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Changes the list in memory, and on disk unless the file could not be read; a failed write keeps the change for this session. */
  private async update(change: (entries: Entry[]) => Entry[], system?: () => void): Promise<void> {
    await this.load()
    return this.serial(async () => {
      this.entries = change(this.entries).slice(0, recentFilesLimits.entries)
      this.changed()
      try { system?.() } catch { /* The OS list is a convenience. */ }
      if (this.unreadable) return
      const file: RecentFilesFile = { version: 1, files: this.entries }
      await writeJsonAtomic(this.path, file, recentFilesLimits.fileBytes, 'The recent files list is too large.')
    })
  }
  private unique(entries: readonly Entry[]): Entry[] {
    return entries.filter((entry, index) => entries.findIndex(other => samePath(other.path, entry.path, this.platform)) === index)
  }
  private idOf(path: string): string {
    const key = this.platform === 'win32' ? path.toLowerCase() : path
    let id = this.ids.get(key)
    if (!id) { id = randomUUID(); this.ids.set(key, id) }
    this.paths.set(id, path)
    return id
  }
  private changed(): void { for (const listener of [...this.listeners]) listener() }
}
