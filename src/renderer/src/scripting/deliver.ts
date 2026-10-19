import type { ApiResult, SqlFile } from '../../../shared/contracts'
import { displayText } from '../../../shared/explorer/refs.ts'
import type { ScriptDestination } from '../../../shared/scripting/catalog.ts'

/** What delivering a script needs: Script As and the object dialogs' Script button deliver alike. */
export interface DeliverScriptDeps {
  readonly documents: { newQuery(sql: string, name: string | undefined, connectionId: string, database: string, unsaved: boolean): unknown }
  readonly files: { saveCopy(name: string, content: string): Promise<SqlFile | undefined> }
  readonly api: { writeClipboardText(text: string): Promise<ApiResult<void>> }
  /** Puts the caret at the start of a new script's editor and focuses it. */
  readonly focusEditor?: () => void
}
export interface DeliverScriptRequest {
  readonly destination: ScriptDestination
  readonly text: string
  /** The database a new query window uses. */
  readonly database: string
  readonly connectionId: string
  /** What File… suggests; main makes it safe. */
  readonly fileName: string
}
export const clipboardNotice = 'Script copied to the clipboard.'

/**
 * Delivers a script to a new query window (not marked unsaved: the menu can always produce it again), a file the user
 * picks, or the clipboard. Resolves to the notice to show, if any; a failure throws its message.
 */
export async function deliverScript(request: DeliverScriptRequest, deps: DeliverScriptDeps): Promise<string | undefined> {
  switch (request.destination) {
    case 'newQuery':
      deps.documents.newQuery(request.text, undefined, request.connectionId, request.database, false)
      deps.focusEditor?.()
      return undefined
    case 'file': {
      const saved = await deps.files.saveCopy(request.fileName, request.text)
      return saved ? `Saved ${displayText(saved.name)}.` : undefined
    }
    case 'clipboard': {
      const result = await deps.api.writeClipboardText(request.text)
      if (!result.ok) throw new Error(result.error)
      return clipboardNotice
    }
  }
}
