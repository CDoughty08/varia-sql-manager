import { SnapshotStore } from '../core/store'

/** The longest line number Go To Line accepts, in digits: more than any model's line count. */
export const maxLineDigits = 10

/** The line `text` names: only digits, at most 10 of them, from 1 to `lineCount`; otherwise undefined. */
export function parseLineNumber(text: string, lineCount: number): number | undefined {
  if (!/^[0-9]{1,10}$/.test(text)) return undefined
  const line = Number(text)
  return line >= 1 && line <= lineCount ? line : undefined
}

/** SSMS's Go To Line dialog while it is open: the query it is for, that query's line count, and the caret's line. */
export interface GoToLineRequest { readonly tabId: string; readonly lineCount: number; readonly line: number }
export interface EditorDialogsState { readonly goToLine?: GoToLineRequest }

/** The query editor's own dialogs; App mounts each while its state is set. */
export class EditorDialogs extends SnapshotStore<EditorDialogsState> {
  constructor() { super({}) }
  openGoToLine(request: GoToLineRequest): void { this.publish({ ...this.getSnapshot(), goToLine: request }) }
  closeGoToLine(): void { if (this.getSnapshot().goToLine) this.publish({ ...this.getSnapshot(), goToLine: undefined }) }
  dispose(): void { this.clearListeners() }
}
