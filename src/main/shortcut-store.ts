import { z } from 'zod'
import {
  emptyShortcutFile, parseShortcutText, readShortcutFile, shortcutFileSchema, shortcutFileText, shortcutLimits, type ShortcutFile, type ShortcutReadOptions
} from '../shared/commands/shortcut-schema'
import { gestureChoiceTexts } from '../shared/commands/gesture-choices'
import type { ShortcutsExport, ShortcutsImport, ShortcutsLoad, ShortcutsSaved, ShortcutsSnapshot } from '../shared/contracts'
import { BackendError } from './backend/errors'
import { quarantine, readJsonFile, readRegularFile, writeBytesAtomic, type JsonInvalidReason } from './json-file'

/**
 * How gesture entries are read: a gesture this build does not offer, or a choice it does not offer for that gesture,
 * moves to `unknown` (kept verbatim for the build that knows it) rather than staying a live entry no view can show.
 */
const readOptions: ShortcutReadOptions = { gestures: gestureChoiceTexts }

/** Fixed sentences: never file content, paths or names. */
export const shortcutSentences = {
  unreadable: 'Shortcuts could not be read, so changes are not saved.',
  newer: 'Shortcuts were saved by a newer version of Varia, so this version does not change them.',
  stale: 'Shortcuts changed since they were opened. Review them and save again.',
  tooLarge: `Shortcuts exceed their size limit of ${shortcutLimits.fileBytes / 1024} KiB.`,
  importNotFile: 'The chosen file could not be read as a file.',
  importInvalid: 'The chosen file is not a Varia shortcuts file.',
  importNewer: 'The chosen file was saved by a newer version of Varia.',
  importSize: `The chosen file is larger than ${shortcutLimits.fileBytes / 1024} KiB.`,
  saveFailed: 'Shortcuts could not be saved: the file could not be written.',
  exportFailed: 'The shortcuts could not be exported: the file could not be written.',
  overLimit: 'The shortcuts are over their limits.'
} as const
const invalidWords: Record<JsonInvalidReason | 'values', string> = { size: `larger than ${shortcutLimits.fileBytes / 1024} KiB`, encoding: 'not UTF-8', json: 'not valid JSON', values: 'not a shortcuts file' }
/** The notice for a file the store had to set aside. */
export const resetNotice = (reason: JsonInvalidReason | 'values') => `Shortcuts were invalid (${invalidWords[reason]}) and were reset; the original file was kept.`
export const salvageNotice = 'Some shortcuts could not be read and were left out; the original file was kept.'

const canonical = (file: ShortcutFile) => JSON.stringify(file)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
/**
 * The strict file from the renderer, as plain JSON values. Its counts are checked first, so a page over a limit gets the
 * one fixed sentence rather than zod's issues (the schema also refuses an oversized list or gesture map before parsing
 * its elements: zod caps arrays itself, and `boundedRecord` the map).
 */
function parseFile(value: unknown): ShortcutFile {
  if (isRecord(value)) {
    const over = (list: unknown, max: number) => Array.isArray(list) && list.length > max
    if (over(value.bindings, shortcutLimits.bindings) || over(value.unknown, shortcutLimits.unknown) ||
      (isRecord(value.gestures) && Object.keys(value.gestures).length > shortcutLimits.gestures)) throw new Error(shortcutSentences.overLimit)
  }
  // IPC is a structured clone, which also carries ArrayBuffers, Maps and Dates: each serializes to a few bytes of JSON, so
  // the limits never saw them. Only what JSON carries is kept, which is exactly what the file will hold.
  const plain: unknown = JSON.parse(JSON.stringify(shortcutFileSchema.parse(value)))
  // Then it is read as the next re-read will read it (a gesture choice the catalogue does not offer moves to `unknown`,
  // a record there that this build understands moves back), so saving what main holds is never a change, or a STALE.
  const read = readShortcutFile(plain, readOptions)
  if (!read.ok) throw new Error(read.error === 'size' ? shortcutSentences.tooLarge : shortcutSentences.overLimit)
  return read.file
}
/**
 * Writes `file` to `path` in `shortcutFileText`'s form, the one reads measure; a failure is a fixed sentence, since the
 * system's message names the path (and the user).
 */
async function writeFile(path: string, file: ShortcutFile, failed: string): Promise<void> {
  const text = shortcutFileText(file)
  if (text === undefined) throw new Error(shortcutSentences.tooLarge)
  try { await writeBytesAtomic(path, Buffer.from(text)) } catch { throw new Error(failed) }
}
type Read = { kind: 'missing' } | { kind: 'ok'; file: ShortcutFile } | { kind: 'salvage'; file: ShortcutFile } | { kind: 'reset'; reason: JsonInvalidReason | 'values' } | { kind: 'newer' }

/** Reads shortcuts.json: file-system failures throw (so nothing is ever written over a file the store could not read). */
async function readStored(path: string): Promise<Read> {
  const read = await readJsonFile(path, shortcutLimits.fileBytes)
  if (read.kind === 'missing') return read
  if (read.kind === 'invalid') return { kind: 'reset', reason: read.reason ?? 'json' }
  const parsed = readShortcutFile(read.value, readOptions)
  if (!parsed.ok) return parsed.error === 'newer' ? { kind: 'newer' } : { kind: 'reset', reason: parsed.error === 'size' ? 'size' : 'values' }
  return parsed.problems.length ? { kind: 'salvage', file: parsed.file } : { kind: 'ok', file: parsed.file }
}

/**
 * `<userData>/shortcuts.json`, the user's keyboard and mouse shortcuts (Tools › Options › Environment › Shortcuts),
 * following `SettingsStore`. Work runs one task at a time, and every save reads the file again first:
 *
 * - an unreadable file (not JSON, not UTF-8, too large, not a shortcuts file) is quarantined and replaced by an empty one;
 * - a file with some entries this build cannot read is salvaged: quarantined, then written back with the entries it
 *   could read. Records this build does not understand (a newer build's commands, scopes or members) are not damage:
 *   `readShortcutFile` keeps them in `unknown`, which is written back verbatim;
 * - a file from a newer version is left alone, applied as empty, and never written;
 * - a read that fails (permissions, a folder at the path) throws and writes nothing.
 *
 * `revision` counts the content this session knows. A hand edit noticed by a save's re-read is a new revision (and a
 * change event), so a save based on an earlier revision is refused with `STALE` instead of overwriting either edit.
 */
export class ShortcutStore {
  private queue: Promise<void> = Promise.resolve()
  private file: ShortcutFile = emptyShortcutFile
  private revision = 0
  private loaded = false
  /** Since the last load that set something aside, until a save: the page shows the notice while this holds. */
  private notice?: string
  /** Names each notice main raises (a set-aside, or a newer version's file), so the page shows each once: main repeats a
   *  notice on every load until a save, in fixed words, across revisions (a valid hand edit after a salvage keeps it). */
  private noticeId = 0
  private newerNoticeId = 0
  private noticeCounter = 0
  private newer = false
  /** A read failed before any succeeded: the first one that does is announced, since main's menus still show the catalogue's keys. */
  private readFailed = false
  private listeners = new Set<(snapshot: ShortcutsSnapshot) => void>()
  constructor(private readonly path: string) {}

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.then(() => {}, () => {})
    return next
  }
  /** The last file known, synchronously: empty until the first load. Main's menus read it. */
  current(): ShortcutFile { return this.file }
  onDidChange(listener: (snapshot: ShortcutsSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private snapshot(): ShortcutsSnapshot { return { file: this.file, revision: this.revision } }
  private emit(): void {
    const snapshot = this.snapshot()
    // The file is written; a listener's failure must not report the save as failed.
    for (const listener of [...this.listeners]) { try { listener(snapshot) } catch (error) { console.error(error) } }
  }

  /**
   * The file, its revision, and whether a load set part or all of it aside. Every load reads the file again, so a page
   * that opens Shortcuts sees a hand edit (as a new revision, announced to listeners too).
   */
  load(): Promise<ShortcutsLoad> {
    return this.serial(async () => {
      await this.refresh(this.loaded)
      const notice = this.notice ?? (this.newer ? shortcutSentences.newer : undefined)
      const noticeId = this.notice !== undefined ? this.noticeId : this.newerNoticeId
      return { ...this.snapshot(), salvaged: this.notice !== undefined, ...(notice ? { notice, noticeId } : {}) }
    })
  }

  /**
   * Writes `file` (strict) when the store's revision is still `baseRevision`; resolves to the new revision. A save whose
   * own re-read set a hand edit aside is refused with `STALE` even when what remains equals what the page holds: the save
   * reply has no notice, and `STALE` makes the page read again, which shows it.
   */
  async save(value: unknown, baseRevision: number): Promise<ShortcutsSaved> {
    const file = parseFile(value)
    return this.serial(async () => {
      const setAside = await this.refresh(true)
      if (this.newer) throw new Error(shortcutSentences.newer)
      if (setAside || baseRevision !== this.revision) throw new BackendError('STALE', shortcutSentences.stale)
      if (canonical(file) !== canonical(this.file)) {
        await writeFile(this.path, file, shortcutSentences.saveFailed)
        this.file = file
        this.revision++
        this.notice = undefined
        this.emit()
      }
      return { revision: this.revision }
    })
  }

  /**
   * Reads the file again. When it differs from what the store knows, it becomes the next revision; `notify` (a save's
   * re-read) announces it, since the page holds the old content. A first load starts at revision 1. Resolves to whether
   * this read set part or all of the file aside.
   */
  private async refresh(notify: boolean): Promise<boolean> {
    let read: Read
    try { read = await readStored(this.path) } catch { if (!this.loaded) this.readFailed = true; throw new Error(shortcutSentences.unreadable) }
    let next: ShortcutFile
    if (read.kind === 'newer' && !this.newer) this.newerNoticeId = ++this.noticeCounter
    this.newer = read.kind === 'newer'
    if (read.kind === 'missing' || read.kind === 'newer') next = emptyShortcutFile
    else if (read.kind === 'ok') next = read.file
    else {
      next = read.kind === 'salvage' ? read.file : emptyShortcutFile
      try { await quarantine(this.path) } catch { if (!this.loaded) this.readFailed = true; throw new Error(shortcutSentences.unreadable) }
      this.notice = read.kind === 'salvage' ? salvageNotice : resetNotice(read.reason)
      this.noticeId = ++this.noticeCounter
      // The original is kept beside it; a failed write back leaves the file missing, which reads as empty.
      await writeFile(this.path, next, shortcutSentences.saveFailed).catch(() => {})
    }
    const setAside = read.kind === 'salvage' || read.kind === 'reset'
    const first = !this.loaded
    this.loaded = true
    if (first) {
      this.file = next
      this.revision = 1
      if (this.readFailed) { this.readFailed = false; this.emit() }
      return setAside
    }
    if (canonical(next) === canonical(this.file)) return setAside
    this.file = next
    this.revision++
    if (notify) this.emit()
    return setAside
  }
}

/** The dialogs main opens for import and export; each resolves to the chosen path, or undefined when cancelled. */
export interface ShortcutDialogs {
  chooseImport(): Promise<string | undefined>
  chooseExport(): Promise<string | undefined>
}

const noArgument = z.undefined()
const saveRequestSchema = z.strictObject({ file: z.unknown(), baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
const exportRequestSchema = z.strictObject({ file: z.unknown() })

/** Reads a file the user chose in main's open dialog; nothing is saved (the page previews it, then saves). */
export async function importShortcuts(path: string): Promise<ShortcutsImport> {
  let bytes: Buffer | undefined
  try { bytes = await readRegularFile(path, shortcutLimits.fileBytes) } catch { throw new Error(shortcutSentences.importNotFile) }
  if (!bytes) throw new Error(shortcutSentences.importNotFile)
  if (bytes.length > shortcutLimits.fileBytes) throw new Error(shortcutSentences.importSize)
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error(shortcutSentences.importInvalid) }
  const parsed = parseShortcutText(text, readOptions)
  if (!parsed.ok) throw new Error(parsed.error === 'newer' ? shortcutSentences.importNewer : parsed.error === 'size' ? shortcutSentences.importSize : shortcutSentences.importInvalid)
  return { file: parsed.file, problems: parsed.problems }
}

/**
 * The IPC handlers behind `window.varia.shortcuts`, each taking the renderer's raw value. Import and export take no
 * path from the renderer: the only paths are those main's own dialogs return.
 */
export function shortcutHandlers(store: ShortcutStore, dialogs: ShortcutDialogs) {
  return {
    get: async (value: unknown): Promise<ShortcutsLoad> => { noArgument.parse(value); return store.load() },
    save: async (value: unknown): Promise<ShortcutsSaved> => {
      const request = saveRequestSchema.parse(value)
      return store.save(request.file, request.baseRevision)
    },
    importFile: async (value: unknown): Promise<ShortcutsImport> => {
      noArgument.parse(value)
      const path = await dialogs.chooseImport()
      return path === undefined ? { cancelled: true } : importShortcuts(path)
    },
    exportFile: async (value: unknown): Promise<ShortcutsExport> => {
      const file = parseFile(exportRequestSchema.parse(value).file)
      const path = await dialogs.chooseExport()
      if (path === undefined) return { cancelled: true }
      await writeFile(path, file, shortcutSentences.exportFailed)
      return { cancelled: false }
    }
  }
}
