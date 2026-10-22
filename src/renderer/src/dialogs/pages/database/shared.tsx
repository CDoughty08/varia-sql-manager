import type { ReactNode } from 'react'
import type { DatabasePropertiesModel } from '../../../../../shared/actions/schema.ts'
import type { DatabaseDraft } from '../../database-properties'
import type { OpenObjectDialog } from '../../ObjectDialogService'

/** The open Database Properties dialog's model and draft, once its describe has answered. */
export function databaseState(open: OpenObjectDialog): { readonly model?: DatabasePropertiesModel; readonly draft?: DatabaseDraft } {
  return open.dialog === 'databaseProperties' ? { model: open.model as DatabasePropertiesModel | undefined, draft: open.draft as DatabaseDraft | undefined } : {}
}

/** SSMS's description pane under a property grid: the selected row's name and text. */
export function DescriptionPane({ title, text, notes = [] }: { title: string; text: string; notes?: readonly string[] }) {
  return <div className="object-dialog-description" aria-live="polite"><strong>{title}</strong>{text && <p>{text}</p>}{notes.map(note => <p key={note}>{note}</p>)}</div>
}

/** A page's note (why it is read-only, what is not supported yet). */
export function PageNote({ children }: { children: ReactNode }) {
  return <p className="field-note object-dialog-note"><span className="codicon codicon-info" aria-hidden="true" />{children}</p>
}

/** "16.00 MB": two decimals in the user's locale, as SSMS shows sizes. */
export const megabytes = (value: number | undefined) => value === undefined ? '' : `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MB`
/** A date in the user's locale; 'None' (no backup) as is; unknown as blank. */
export const dateText = (value: string | undefined) => value === undefined ? '' : value === 'None' ? 'None' : Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString()
