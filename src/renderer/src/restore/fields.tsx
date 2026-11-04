// The pieces both restore documents' sections share (Restore Database's and Restore Files and Filegroups'): field ids, the
// section props, the problem list and a path field with SSMS's "…" button.
import type { ServerFilePurpose } from '../../../shared/actions/catalog.ts'
import Icon from '../Icon'
import PropertyField from '../kit/PropertyField'
import type { RestoreDraft, RestoreFacts } from './model'
import type { RestoreService, RestoreState } from './RestoreService'

export const fieldId = (documentId: string, key: string) => `restore-${documentId}-${key}`

export interface SectionProps {
  readonly state: RestoreState
  readonly draft: RestoreDraft
  readonly facts: RestoreFacts
  readonly service: RestoreService
  readonly problems: readonly string[]
  readonly browse: (purpose: ServerFilePurpose, initialPath?: string) => Promise<string | undefined>
}

export function Problems({ problems }: { readonly problems: readonly string[] }) {
  return problems.length === 0 ? null : <ul className="restore-problems">{problems.map(problem => <li key={problem}><Icon name="error" />{problem}</li>)}</ul>
}

/** A path field with SSMS's "…" button, which opens the server file picker. */
export function PathField({ id, label, value, disabled, note, purpose, browse, onChange }: {
  readonly id: string; readonly label: string; readonly value: string; readonly disabled?: boolean; readonly note?: string; readonly purpose: ServerFilePurpose
  readonly browse: SectionProps['browse']; readonly onChange: (value: string) => void
}) {
  return <PropertyField id={id} label={label} note={note}>
    <span className="property-input-action">
      <input id={id} className="property-input" type="text" spellCheck={false} maxLength={260} value={value} title={value} disabled={disabled} onChange={event => onChange(event.target.value)} />
      <button type="button" className="property-browse" aria-label={`Browse for ${label.replace(/:$/, '').toLowerCase()}`} title={`Browse for ${label.replace(/:$/, '').toLowerCase()}`} disabled={disabled}
        onClick={() => void browse(purpose, value || undefined).then(path => { if (path) onChange(path) })}>…</button>
    </span>
  </PropertyField>
}
