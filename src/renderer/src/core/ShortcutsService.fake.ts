import type { ApiResult } from '../../../shared/contracts'
import type { Platform } from '../../../shared/commands/keybindings'
import { emptyShortcutFile, type ShortcutFile } from '../../../shared/commands/shortcut-schema'
import { ShortcutsService, type ShortcutsApi, type ShortcutsFileSnapshot, type ShortcutsTargets } from './ShortcutsService'

type ImportAnswer = Awaited<ReturnType<ShortcutsApi['importFile']>>
type ExportAnswer = Awaited<ReturnType<ShortcutsApi['exportFile']>>
export interface FakeShortcutsOptions extends ShortcutsTargets {
  readonly file?: ShortcutFile
  readonly revision?: number
  readonly platform?: Platform
}
/** A `ShortcutsService` over an in-memory main, with what a test needs to steer and observe it. */
export interface FakeShortcutsService extends ShortcutsService {
  /** Every file main was asked to save, with the revision the save started from. */
  readonly saves: { readonly file: ShortcutFile; readonly baseRevision: number }[]
  /** Every file main was asked to export. */
  readonly exports: ShortcutFile[]
  /** Main's file as it is now. */
  readonly stored: () => ShortcutsFileSnapshot
  /** The next save fails with this error (and code, such as `STALE`) instead of saving. */
  failNextSave(error: string, code?: string): void
  /** Another window saved `file`: main stores it under the next revision and pushes it. */
  changeElsewhere(file: ShortcutFile): void
  /** What the next Import answers: a file and its problems, `'cancel'`, or an error. */
  answerImport(answer: { file: ShortcutFile; problems?: readonly string[] } | 'cancel' | { error: string }): void
  /** What the next Export answers; it succeeds by default. */
  answerExport(answer: 'cancel' | { error: string }): void
}

/**
 * A real `ShortcutsService` whose main is in memory, loaded at once: the Shortcuts page (lane G) and the Mouse view
 * (lane D2) test against it. Saves check the base revision as main does and answer `STALE` when another window saved
 * first; nothing is validated beyond what the service itself checks.
 */
export function createFakeShortcutsService(initial: FakeShortcutsOptions = {}): FakeShortcutsService {
  let stored: ShortcutsFileSnapshot = { file: initial.file ?? emptyShortcutFile, revision: initial.revision ?? 0 }
  let failure: { error: string; code?: string } | undefined
  let importAnswer: ImportAnswer = { ok: true, value: { cancelled: true } }
  let exportAnswer: ExportAnswer | undefined
  const listeners = new Set<(snapshot: ShortcutsFileSnapshot) => void>()
  const saves: FakeShortcutsService['saves'] = [], exports: ShortcutFile[] = []
  const api: ShortcutsApi = {
    get: async () => ({ ok: true, value: { ...stored, salvaged: false } }),
    save: async (file, baseRevision) => {
      saves.push({ file, baseRevision })
      if (failure) { const { error, code } = failure; failure = undefined; return { ok: false, error, ...code ? { code } : {} } as ApiResult<never> }
      if (baseRevision !== stored.revision) return { ok: false, error: 'The shortcuts changed in another window.', code: 'STALE' }
      stored = { file, revision: stored.revision + 1 }
      for (const listener of [...listeners]) listener(stored)
      return { ok: true, value: { revision: stored.revision } }
    },
    importFile: async () => importAnswer,
    exportFile: async file => { exports.push(file); const answer = exportAnswer ?? { ok: true, value: { cancelled: false } }; exportAnswer = undefined; return answer },
    onChanged: callback => { listeners.add(callback); return () => { listeners.delete(callback) } }
  }
  const service = new ShortcutsService({ api, platform: initial.platform ?? 'win32', initial: stored, loaded: true, keybindings: initial.keybindings, gestures: initial.gestures })
  return Object.assign(service, {
    saves,
    exports,
    stored: () => stored,
    failNextSave: (error: string, code?: string) => { failure = { error, ...code ? { code } : {} } },
    changeElsewhere: (file: ShortcutFile) => {
      stored = { file, revision: stored.revision + 1 }
      for (const listener of [...listeners]) listener(stored)
    },
    answerImport: (answer: Parameters<FakeShortcutsService['answerImport']>[0]) => {
      importAnswer = answer === 'cancel' ? { ok: true, value: { cancelled: true } }
        : 'error' in answer ? { ok: false, error: answer.error } : { ok: true, value: { file: answer.file, problems: answer.problems ?? [] } }
    },
    answerExport: (answer: 'cancel' | { error: string }) => {
      exportAnswer = answer === 'cancel' ? { ok: true, value: { cancelled: true } } : { ok: false, error: answer.error }
    }
  })
}
