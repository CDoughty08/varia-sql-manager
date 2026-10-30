import { actionLimits, serverFilePurposeSpecs, serverFilesDescribeId, type ServerFilePurpose } from '../../../shared/actions/catalog.ts'
import {
  folderPath, isAbsoluteServerPath, sameServerPath, serverFolder, serverPathProblem, serverPathRoot, serverPathText, splitServerPath, type ServerFileEntry, type ServerFilesListing, type ServerFilesRequest,
  type ServerPathSeparator, type ServerRoot
} from '../../../shared/actions/files.ts'
import type { ActionDescribeResult, ActionError } from '../../../shared/actions/schema.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import type { LiveConnection } from '../services/connections'

/** What a dialog's "…" button asks for: a file or folder on the server of `connectionId`. */
export interface ServerFilePick {
  readonly connectionId: string
  readonly purpose: ServerFilePurpose
  /** The path the field already holds: its folder opens with it selected. Otherwise the purpose's default folder. */
  readonly initialPath?: string
  /** False for a file that is still to be written (a backup destination): a name the folder does not list is accepted. */
  readonly mustExist?: boolean
}

/** One folder's listing: loading (`slow` once it has taken 300 ms), listed, or failed. */
export type FolderListing =
  | { readonly status: 'loading'; readonly slow: boolean }
  | { readonly status: 'ready'; readonly entries: readonly ServerFileEntry[]; readonly truncated: boolean; readonly notice?: ServerFilesListing['notice'] }
  | { readonly status: 'failed'; readonly error: ActionError }

export interface OpenServerFilePicker {
  /** Changes with every picker, so the dialog remounts. */
  readonly id: number
  readonly connectionId: string
  readonly purpose: ServerFilePurpose
  /** "Locate Backup File - localhost". */
  readonly title: string
  readonly server: string
  readonly mustExist: boolean
  /** The server's, from its first answer. */
  readonly separator?: ServerPathSeparator
  /** The drives and default folders, plus any root a typed path reached (a share); undefined while they load. */
  readonly roots?: readonly ServerRoot[]
  readonly rootsSlow?: boolean
  /** Listings by folder key (`folderKey`). */
  readonly listings: ReadonlyMap<string, FolderListing>
  readonly expanded: ReadonlySet<string>
  /** The selected row's path: a folder (ending with the separator) or a file. */
  readonly selected?: string
  readonly allFiles: boolean
  readonly fileName: string
  /** The message bar. */
  readonly error?: ActionError
  /** The footer: the last listing's entries and how long it took. */
  readonly last?: { readonly count: number; readonly ms: number }
  /** A typed path or OK is finding its folder. */
  readonly busy?: boolean
  readonly disconnected?: boolean
}
export interface ServerFilePickerSnapshot { readonly open?: OpenServerFilePicker }

/**
 * A row of the tree: a root, a folder or a file, or a line under a folder that says why it shows nothing. `name` is the
 * accessible name (a root's full path), `label` what the row shows (a default folder's own name, beside its tags).
 */
export type PickerRow =
  | { readonly type: 'item'; readonly path: string; readonly name: string; readonly label: string; readonly level: number; readonly directory: boolean; readonly root?: ServerRoot; readonly entry?: ServerFileEntry; readonly expanded: boolean; readonly listing?: FolderListing }
  | { readonly type: 'note'; readonly key: string; readonly level: number; readonly text: string; readonly tone: 'info' | 'error' | 'busy'; readonly slow?: boolean }

export const pickerMessages = {
  empty: 'This folder is empty, or the server\'s account cannot list it.',
  /** Locate Folder lists folders only, so a folder of files shows nothing. */
  noFolders: 'This folder has no subfolders, or the server\'s account cannot list it.',
  legacyEmpty: 'SQL Server 2016 lists folders only to members of sysadmin. Type the path instead.',
  truncated: `Only the first ${actionLimits.browseEntries.toLocaleString('en-US')} entries are listed. Type a name to pick another.`,
  listing: 'Listing…',
  disconnected: 'The server was disconnected.',
  banner: (server: string) => `Paths are on the server ${server}; SQL Server's service account must be able to read them.`,
  notFound: (path: string) => `${path} does not exist, or SQL Server's service account cannot see it.`,
  cancelled: 'The listing was cancelled.'
} as const

/** How long a listing runs before its row shows a spinner and the tree is busy, in ms (the --varia-motion-delay token). */
export const slowListingMs = 300
const failure = (code: ActionError['code'], message: string): ActionError => ({ code, message, retryable: code !== 'PATH_NOT_FOUND' && code !== 'NOT_SUPPORTED' })

/** Listings one picker runs at once; the rest wait their turn, so a tree on a slow share cannot fill the server's gates. */
export const pickerListings = 1
/** The tree's name (SSMS's, recalled). */
export const pickerTreeLabel = (purpose: ServerFilePurpose): string => purpose === 'folder' ? 'Select the folder' : 'Select the file'
/** What a root's row shows: a default folder by its own name (its tags say which), a drive, share or typed folder by its path. */
export function rootLabel(root: ServerRoot, separator: ServerPathSeparator): string {
  if (!root.defaults?.length) return root.path
  return root.path.slice(0, -1).split(separator).at(-1) || root.path
}

/** Windows compares paths without case, Linux exactly. */
export const folderKey = (path: string, separator: ServerPathSeparator): string => separator === '\\' ? path.toLowerCase() : path

/** The tree as rows, roots first, each expanded folder's listing under it. */
export function pickerRows(open: OpenServerFilePicker): PickerRow[] {
  const rows: PickerRow[] = []
  const separator = open.separator ?? '\\'
  const add = (path: string, level: number) => {
    const listing = open.listings.get(folderKey(path, separator))
    if (!open.expanded.has(folderKey(path, separator)) || !listing) return
    if (listing.status === 'loading') { rows.push({ type: 'note', key: path + '\u0000loading', level, text: pickerMessages.listing, tone: 'busy', slow: listing.slow }); return }
    if (listing.status === 'failed') { rows.push({ type: 'note', key: path + '\u0000failed', level, text: listing.error.message, tone: 'error' }); return }
    for (const entry of listing.entries) {
      const child = entry.directory ? path + entry.name + separator : path + entry.name
      rows.push({ type: 'item', path: child, name: entry.name, label: entry.name, level, directory: entry.directory, entry, expanded: entry.directory && open.expanded.has(folderKey(child, separator)), listing: entry.directory ? open.listings.get(folderKey(child, separator)) : undefined })
      if (entry.directory) add(child, level + 1)
    }
    if (listing.entries.length === 0) rows.push({ type: 'note', key: path + '\u0000empty', level, text: listing.notice === 'legacyEmpty' ? pickerMessages.legacyEmpty : open.purpose === 'folder' ? pickerMessages.noFolders : pickerMessages.empty, tone: 'info' })
    else if (listing.truncated) rows.push({ type: 'note', key: path + '\u0000truncated', level, text: pickerMessages.truncated, tone: 'info' })
  }
  for (const root of open.roots ?? []) {
    rows.push({ type: 'item', path: root.path, name: root.path, label: rootLabel(root, separator), level: 1, directory: true, root, expanded: open.expanded.has(folderKey(root.path, separator)), listing: open.listings.get(folderKey(root.path, separator)) })
    add(root.path, 2)
  }
  return rows
}

/** The folder a selection stands for: the folder itself, or a file's folder. */
export function selectedFolder(open: OpenServerFilePicker): string | undefined {
  if (!open.selected || !open.separator) return undefined
  return open.selected.endsWith(open.separator) ? open.selected : splitServerPath(open.selected, open.separator).folder
}

/**
 * The server file picker (SSMS's Locate Backup File, Locate Database Files, Locate Folder): at most one open, over the
 * dialog whose "…" button opened it. Each folder is one `actions.describe` request ('serverFiles') when it is first
 * expanded; a typed path lists each folder from its root down. `pick` resolves with the chosen path, or undefined for
 * Cancel, a lost server or another picker's turn. Failures are values in the snapshot; nothing throws into React.
 */
export class ServerFilePickerService extends SnapshotStore<ServerFilePickerSnapshot> implements Disposable {
  private readonly newId: () => string
  private readonly unsubscribe: () => void
  private pickers = 0
  private resolve?: (path: string | undefined) => void
  /** Requests in flight by request id, so Cancel and a lost server can cancel them in SQL Server. */
  private readonly requests = new Set<string>()
  /** Those of them sent to the backend; the rest still wait for the picker's lane. */
  private readonly sent = new Set<string>()
  /** Each open picker's turn at listing, `pickerListings` at a time; a new picker gets a new lane. */
  private lane = new ListingLane()
  private readonly loads = new Map<string, Promise<FolderListing>>()
  /** The request each running load waits on, so a load that is no longer wanted is cancelled in SQL Server. */
  private readonly loadRequests = new Map<string, string>()
  /** Each listed folder's path by key, so Files of type can list the expanded folders again. */
  private readonly paths = new Map<string, string>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private disposed = false

  constructor(private readonly options: {
    readonly api: Pick<VariaApi, 'describeObject' | 'cancelObjectActions'>
    readonly connections: ExternalStore<readonly LiveConnection[]>
    readonly newId?: () => string
    readonly now?: () => number
  }) {
    super({})
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.unsubscribe = options.connections.subscribe(() => { try { this.connectionsChanged() } catch (error) { onUnexpectedError(error) } })
  }

  get current(): OpenServerFilePicker | undefined { return this.getSnapshot().open }

  /** Opens the picker; refused (undefined) while another is open or when the server is not connected. */
  pick(request: ServerFilePick): Promise<string | undefined> {
    if (this.disposed || this.current) return Promise.resolve(undefined)
    const connection = this.options.connections.getSnapshot().find(item => item.id === request.connectionId && !item.lost)
    if (!connection) return Promise.resolve(undefined)
    if (request.initialPath !== undefined && serverPathProblem(request.initialPath)) request = { ...request, initialPath: undefined }
    const open: OpenServerFilePicker = {
      id: ++this.pickers, connectionId: request.connectionId, purpose: request.purpose, title: `${serverFilePurposeSpecs[request.purpose].title} - ${connection.server}`, server: connection.server,
      mustExist: request.mustExist ?? true, listings: new Map(), expanded: new Set(), allFiles: false, fileName: ''
    }
    this.publish({ open })
    const result = new Promise<string | undefined>(resolve => { this.resolve = resolve })
    void this.start(open, request.initialPath)
    return result
  }

  select(path: string): void {
    const open = this.current
    if (!open?.separator) return
    const file = !path.endsWith(open.separator)
    this.update(open, { selected: path, fileName: file ? splitServerPath(path, open.separator).name : '', error: undefined })
  }
  /** Expands a collapsed folder (listing it the first time, or again after a failure) or collapses an expanded one. */
  toggle(path: string): void {
    const open = this.current
    if (!open?.separator || open.disconnected) return
    const key = folderKey(path, open.separator)
    const expanded = new Set(open.expanded)
    if (expanded.has(key)) {
      expanded.delete(key)
      // A folder collapsed while it lists: its listing is cancelled, and expanding it again lists it afresh.
      if (open.listings.get(key)?.status === 'loading') {
        this.dropLoad(key)
        const listings = new Map(open.listings)
        listings.delete(key)
        this.update(open, { expanded, listings })
      } else this.update(open, { expanded })
      return
    }
    expanded.add(key)
    this.update(open, { expanded })
    void this.load(open, path)
  }
  setFileName(fileName: string): void { const open = this.current; if (open) this.update(open, { fileName, error: undefined }) }
  /** Files of type: the expanded folders are listed again with the new filter; the selection stays when it still shows. */
  setAllFiles(allFiles: boolean): void {
    const open = this.current
    if (!open || open.allFiles === allFiles || open.purpose === 'folder') return
    // Listings for the old filter are cancelled, not left to hold the server's gate.
    for (const key of [...this.loads.keys()]) this.dropLoad(key)
    const selected = open.selected && open.separator && !open.selected.endsWith(open.separator) ? selectedFolder(open) : open.selected
    this.update(open, { allFiles, listings: new Map(), selected, fileName: selected === open.selected ? open.fileName : '' })
    void this.relist(open)
  }

  /**
   * OK, or Enter in File name: a typed folder (or a file's folder) is listed and selected; a file the folder lists, or with
   * `mustExist` false any name in a folder that exists, closes the picker with its full path. Locate Folder closes with the
   * folder once it is listed.
   */
  async ok(): Promise<void> {
    const open = this.current
    if (!open?.separator || open.busy) return
    if (open.disconnected) { this.cancel(); return }
    const separator = open.separator
    const typed = open.fileName
    const base = selectedFolder(open)
    if (!typed) {
      if (!open.selected) return
      if (open.selected.endsWith(separator)) {
        if (open.purpose === 'folder') this.choose(open, open.selected)
        else this.toggle(open.selected)
        return
      }
      this.choose(open, open.selected)
      return
    }
    const full = isAbsoluteServerPath(typed) ? serverPathText(typed, separator) : base ? base + serverPathText(typed, separator) : undefined
    if (!full) { this.update(open, { error: failure('PATH_NOT_FOUND', 'Select a folder, or type a full path.') }); return }
    const problem = serverPathProblem(full)
    if (problem) { this.update(open, { error: failure('PATH_NOT_FOUND', problem) }); return }
    this.update(open, { busy: true, error: undefined })
    try {
      if (full.endsWith(separator) || open.purpose === 'folder') {
        const folder = await this.navigate(open, folderPath(full, separator))
        if (folder && open.purpose === 'folder' && this.live(open)) this.choose(open, folder)
        else if (folder) this.update(open, { fileName: '' })
        return
      }
      const { folder, name } = splitServerPath(full, separator)
      const parent = await this.navigate(open, folder)
      if (!parent || !this.live(open)) return
      const listing = this.current?.listings.get(folderKey(parent, separator))
      const entry = listing?.status === 'ready' ? listing.entries.find(item => sameServerPath(item.name, name, separator)) : undefined
      if (entry?.directory) {
        const child = await this.navigate(open, parent + entry.name + separator)
        if (child && this.live(open)) this.update(open, { fileName: '' })
        return
      }
      if (entry) { this.choose(open, parent + entry.name); return }
      const path = parent + name
      // A name the listing does not show may still exist: past its limit, outside Files of type, or on SQL Server 2016 for a
      // login outside sysadmin, which lists nothing and cannot be asked (the dialog's own check decides there).
      if (!open.mustExist || listing?.status === 'ready' && listing.notice === 'legacyEmpty') { this.choose(open, path); return }
      const problem = serverPathProblem(path)
      if (problem) { this.update(open, { error: failure('PATH_NOT_FOUND', problem) }); return }
      const checked = await this.request(open, path, { exists: true })
      if (!this.live(open)) return
      if ('error' in checked) { if (checked.error.code !== 'CANCELLED') this.update(open, { error: checked.error }); return }
      const found = checked.listing.entries[0]
      if (checked.listing.notice === 'legacyEmpty') this.choose(open, path)
      else if (!found) this.update(open, { error: failure('PATH_NOT_FOUND', pickerMessages.notFound(path)) })
      else if (found.directory) { if (await this.navigate(open, path + separator) && this.live(open)) this.update(open, { fileName: '' }) }
      else this.choose(open, path)
    } finally { if (this.live(open)) this.update(open, { busy: undefined }) }
  }

  /** Closes the picker with a path every later request takes (serverPathSchema), or says why it cannot: a listed name can
   *  make a path longer than 260 units, and a Linux name can hold characters Windows forbids. */
  private choose(open: OpenServerFilePicker, path: string): void {
    const problem = serverPathProblem(path)
    if (problem) this.update(open, { error: failure('PATH_NOT_FOUND', problem) })
    else this.finish(path)
  }

  /** Cancel or Escape: nothing is chosen, and listings still running are cancelled in SQL Server. */
  cancel(): void { this.finish(undefined) }

  dispose(): void {
    if (this.disposed) return
    this.finish(undefined)
    this.disposed = true
    this.unsubscribe()
    this.clearListeners()
  }

  /** The expanded folders, listed again one at a time from the top, as they were expanded. */
  private async relist(open: OpenServerFilePicker): Promise<void> {
    for (const key of [...open.expanded]) {
      const path = this.paths.get(key)
      if (!this.live(open)) return
      if (path && this.current?.expanded.has(key)) await this.load(open, path)
    }
  }

  private async start(open: OpenServerFilePicker, initialPath: string | undefined): Promise<void> {
    const started = this.now()
    const timer = this.after(() => { if (this.current?.id === open.id && !this.current.roots) this.update(open, { rootsSlow: true }) })
    const result = await this.request(open, undefined)
    clearTimeout(timer)
    if (!this.live(open)) return
    if ('error' in result) { this.update(open, { roots: [], rootsSlow: undefined, error: result.error }); return }
    const listing = result.listing
    this.update(open, { separator: listing.separator, roots: listing.roots, rootsSlow: undefined, last: { count: listing.roots.length, ms: Math.round(this.now() - started) } })
    const now = this.current
    if (!now?.separator) return
    const wanted = initialPath ?? defaultFolder(open.purpose, listing.roots)
    if (!wanted) return
    const separator = listing.separator
    const text = serverPathText(wanted, separator)
    if (text.endsWith(separator) || open.purpose === 'folder') { await this.navigate(now, folderPath(text, separator)); return }
    // A path without a trailing separator names a file or a folder: its folder is listed first, which tells them apart.
    const { folder, name } = splitServerPath(text, separator)
    const parent = await this.navigate(now, folder)
    if (!parent || !this.live(open)) return
    const listed = this.current?.listings.get(folderKey(parent, separator))
    const entry = listed?.status === 'ready' ? listed.entries.find(item => sameServerPath(item.name, name, separator)) : undefined
    if (entry?.directory) await this.navigate(now, parent + entry.name + separator)
    else this.update(open, entry ? { selected: parent + entry.name, fileName: entry.name } : { fileName: name })
  }

  /** Lists each folder from the path's root down to `folder` and selects the deepest one it reached; returns it when it is `folder`. */
  private async navigate(open: OpenServerFilePicker, folder: string): Promise<string | undefined> {
    const separator = open.separator
    if (!separator) return undefined
    const target = serverFolder(folder, separator)
    const root = target && serverPathRoot(target, separator)
    if (!target || !root) { this.update(open, { error: failure('PATH_NOT_FOUND', `${folder} is not a full path on this server.`) }); return undefined }
    // From the deepest root that holds the folder (a default folder, then its drive); a share or a drive the server did not
    // list becomes a root of its own.
    const roots = this.current?.roots ?? []
    const key = folderKey(target, separator)
    let current = roots.filter(item => key.startsWith(folderKey(item.path, separator))).sort((a, b) => b.path.length - a.path.length)[0]?.path
    if (!current) {
      current = /^[a-z]:\\$/.test(root) ? root.toUpperCase() : root
      this.update(open, { roots: [...roots, { path: current, kind: root.startsWith(separator + separator) ? 'folder' : 'drive' }] })
    }
    const segments = target.slice(current.length).split(separator).filter(Boolean)
    for (let index = 0; ; index++) {
      const listing = await this.show(open, current)
      if (!listing) return undefined
      if (index === segments.length) return current
      // The server's own spelling of the folder. One its parent does not list (past the listing's limit, or hidden from
      // it) is listed as typed and becomes a root of its own once it lists.
      const entry = listing.entries.find(item => item.directory && sameServerPath(item.name, segments[index], separator))
      if (entry) { current = current + entry.name + separator; continue }
      const rest = current + segments.slice(index).join(separator) + separator
      const alone = await this.load(open, rest)
      if (!this.live(open)) return undefined
      if (alone.status === 'failed') { this.update(open, { error: alone.error }); return undefined }
      this.update(open, { roots: [...this.current?.roots ?? [], { path: rest, kind: 'folder' }] })
      return (await this.show(open, rest)) ? rest : undefined
    }
  }

  /** Expands and selects a folder once it lists; a failure is the message bar's. */
  private async show(open: OpenServerFilePicker, folder: string): Promise<Extract<FolderListing, { status: 'ready' }> | undefined> {
    const separator = open.separator ?? '\\'
    const state = this.current
    if (!this.live(open) || !state) return undefined
    const expanded = new Set(state.expanded)
    expanded.add(folderKey(folder, separator))
    this.update(open, { expanded, selected: folder })
    const listing = await this.load(open, folder)
    if (!this.live(open)) return undefined
    if (listing.status === 'failed' && listing.error.code === 'CANCELLED') return undefined
    if (listing.status !== 'ready') { this.update(open, { error: listing.status === 'failed' ? listing.error : failure('SQL_ERROR', 'The folder could not be listed.') }); return undefined }
    return listing
  }

  /** A folder's listing, from the cache, the request already running, or a new request. */
  private load(open: OpenServerFilePicker, folder: string): Promise<FolderListing> {
    const separator = open.separator ?? '\\'
    const key = folderKey(folder, separator)
    const cached = this.current?.listings.get(key)
    if (cached?.status === 'ready') return Promise.resolve(cached)
    const running = this.loads.get(key)
    if (running) return running
    return this.reload(open, folder)
  }
  private reload(open: OpenServerFilePicker, folder: string): Promise<FolderListing> {
    const separator = open.separator ?? '\\'
    const key = folderKey(folder, separator)
    this.paths.set(key, folder)
    const listings = new Map(this.current?.listings)
    listings.set(key, { status: 'loading', slow: false })
    this.update(open, { listings })
    const started = this.now()
    let promise: Promise<FolderListing> | undefined
    const timer = this.after(() => {
      const state = this.current
      if (state?.id !== open.id || !promise || this.loads.get(key) !== promise) return
      const now = new Map(state.listings)
      now.set(key, { status: 'loading', slow: true })
      this.update(open, { listings: now })
    })
    promise = (async (): Promise<FolderListing> => {
      const allFiles = this.current?.allFiles ?? false
      const result = await this.request(open, folder, allFiles ? { allFiles } : {}, requestId => this.loadRequests.set(key, requestId))
      clearTimeout(timer)
      if (this.loads.get(key) === promise) this.loadRequests.delete(key)
      const listing: FolderListing = 'error' in result ? { status: 'failed', error: result.error }
        : { status: 'ready', entries: result.listing.entries, truncated: result.listing.truncated, ...(result.listing.notice ? { notice: result.listing.notice } : {}) }
      const state = this.current
      // An answer for a picker that closed, or for the filter before Files of type changed, is dropped.
      if (state?.id !== open.id || this.loads.get(key) !== promise || state.allFiles !== allFiles) return listing
      this.loads.delete(key)
      const listings = new Map(state.listings)
      listings.set(key, listing)
      this.update(open, { listings, ...(listing.status === 'ready' ? { last: { count: listing.entries.length, ms: Math.round(this.now() - started) } } : {}) })
      return listing
    })()
    this.loads.set(key, promise)
    return promise
  }

  /** One request, in its turn on the picker's lane; one cancelled while it waits is never sent. `track` learns its id at once. */
  private async request(open: OpenServerFilePicker, path: string | undefined, files: Pick<ServerFilesRequest, 'allFiles' | 'exists'> = {}, track?: (requestId: string) => void): Promise<{ listing: ServerFilesListing } | { error: ActionError }> {
    const requestId = this.newId()
    const lane = this.lane
    this.requests.add(requestId)
    track?.(requestId)
    let result: ApiResult<ActionDescribeResult>
    // Taken at once when the lane is free, so the request is sent in this turn.
    if (!lane.take()) await lane.wait()
    try {
      if (!this.requests.has(requestId)) return { error: failure('CANCELLED', pickerMessages.cancelled) }
      this.sent.add(requestId)
      result = await this.options.api.describeObject({
        connectionId: open.connectionId, requestId, dialog: serverFilesDescribeId, target: { kind: 'server' },
        files: { purpose: open.purpose, ...(path === undefined ? {} : { path }), ...files }
      })
    } catch (error) { result = { ok: false, error: error instanceof Error ? error.message : 'The request failed.' } }
    finally { this.requests.delete(requestId); this.sent.delete(requestId); lane.release() }
    if (!result.ok) return { error: failure(result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST' ? 'CONNECTION_LOST' : result.code === 'CANCELLED' ? 'CANCELLED' : 'SQL_ERROR', result.error) }
    if (result.value.error) return { error: result.value.error }
    if (!result.value.serverFiles) return { error: failure('SQL_ERROR', 'The server sent no listing.') }
    return { listing: result.value.serverFiles }
  }

  private finish(path: string | undefined): void {
    const open = this.current
    if (!open) return
    this.cancelRequests()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.loads.clear()
    this.loadRequests.clear()
    this.paths.clear()
    // Requests still waiting on the old lane end unsent once its listing answers; the next picker never waits behind them.
    this.lane = new ListingLane()
    const resolve = this.resolve
    this.resolve = undefined
    this.publish({})
    resolve?.(path)
  }
  private live(open: OpenServerFilePicker): boolean { return !this.disposed && this.current?.id === open.id && !this.current.disconnected }
  private update(open: OpenServerFilePicker, patch: Partial<OpenServerFilePicker>): void {
    const current = this.current
    if (this.disposed || current?.id !== open.id) return
    const next = { ...current, ...patch } as OpenServerFilePicker & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.publish({ open: next })
  }
  private after(run: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { this.timers.delete(timer); try { run() } catch (error) { onUnexpectedError(error) } }, slowListingMs)
    this.timers.add(timer)
    return timer
  }
  private now(): number { return this.options.now?.() ?? performance.now() }
  /** A server that disconnects leaves only Cancel; its listings are cancelled. */
  private connectionsChanged(): void {
    const open = this.current
    if (!open || open.disconnected || this.options.connections.getSnapshot().some(item => item.id === open.connectionId && !item.lost)) return
    this.cancelRequests()
    this.loads.clear()
    this.loadRequests.clear()
    this.update(open, { disconnected: true, busy: undefined, error: failure('CONNECTION_LOST', pickerMessages.disconnected) })
  }
  /** A load no longer wanted (its folder collapsed, or Files of type changed): forgotten, and its request cancelled. */
  private dropLoad(key: string): void {
    this.loads.delete(key)
    const requestId = this.loadRequests.get(key)
    this.loadRequests.delete(key)
    if (requestId) this.cancelRequests([requestId])
  }
  /** Cancels requests: those sent in SQL Server, and those still waiting for the lane before they are sent. */
  private cancelRequests(ids: readonly string[] = [...this.requests]): void {
    const sent = ids.filter(id => this.requests.delete(id) && this.sent.has(id))
    for (let start = 0; start < sent.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(sent.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (error) { onUnexpectedError(error) }
    }
  }
}

/** Turns at listing: `pickerListings` requests at once, then each waits for one to answer. */
class ListingLane {
  private active = 0
  private readonly waiting: (() => void)[] = []
  /** Takes a free turn, or says there is none (then `wait`). */
  take(): boolean {
    if (this.active >= pickerListings) return false
    this.active++
    return true
  }
  wait(): Promise<void> { return new Promise(resolve => { this.waiting.push(resolve) }) }
  /** Hands the turn to the next waiting request, or frees it. */
  release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.active--
  }
}

/** The folder a picker opens in without a path: the instance's default backup folder for backups, data and log folders for files. */
function defaultFolder(purpose: ServerFilePurpose, roots: readonly ServerRoot[]): string | undefined {
  const wanted = purpose === 'backup' ? 'backup' : purpose === 'log' ? 'log' : 'data'
  return roots.find(root => root.defaults?.includes(wanted))?.path
}

const units = ['KB', 'MB', 'GB', 'TB', 'PB'] as const
/** A size as the picker's Size column shows it: 512 bytes, 4.0 MB, 212 GB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString('en-US')} bytes`
  let value = bytes / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value < 10 ? value.toFixed(1) : Math.round(value).toLocaleString('en-US')} ${units[unit]}`
}
/** A drive's free space: "212 GB free". */
export const formatFree = (freeMb: number): string => `${formatSize(freeMb * 1024 * 1024)} free`
/** The server's local time without seconds: 2026-10-12 14:03. */
export const formatModified = (modified: string): string => modified.slice(0, 16).replace('T', ' ')
/** A default folder's tags: "default backup folder". */
export const defaultTags = (root: ServerRoot): string[] => (root.defaults ?? []).map(kind => `default ${kind} folder`)
/** The footer: "25 items · listed in 10 ms · type a path or a UNC name to go there". */
export function pickerStatus(open: OpenServerFilePicker): string {
  const hint = open.separator === '/' ? 'type a path to go there' : 'type a path or a UNC name to go there'
  if (!open.last) return hint
  return `${open.last.count.toLocaleString('en-US')} ${open.last.count === 1 ? 'item' : 'items'} · listed in ${open.last.ms.toLocaleString('en-US')} ms · ${hint}`
}
