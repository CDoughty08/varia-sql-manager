import type { DatabaseFilegroup } from '../../../../../shared/actions/schema.ts'
import { displayText } from '../../../../../shared/explorer/refs.ts'
import type { PageProps } from '../../ObjectDialog'
import { databaseState, PageNote } from './shared'

const check = (value: boolean | undefined, label: string) => <input type="checkbox" checked={!!value} disabled aria-label={label} />

/** One of the page's three grids, with SSMS's columns for its kind of filegroup. */
function Section({ id, title, rows, columns, disabled }: { id: string; title: string; rows: readonly DatabaseFilegroup[]; columns: readonly ('readOnly' | 'isDefault' | 'autogrowAllFiles')[]; disabled?: string }) {
  const headers = { readOnly: 'Read-Only', isDefault: 'Default', autogrowAllFiles: 'Autogrow All Files' } as const
  return <section className="database-section" aria-labelledby={id} data-disabled={disabled ? true : undefined}>
    <div className="object-dialog-caption" id={id}>{title}</div>
    {disabled && <p className="field-note">{disabled}</p>}
    <div className="database-table">
      <table className="object-dialog-grid" aria-labelledby={id}>
        <thead><tr><th scope="col">Name</th><th scope="col">{id === 'database-filegroups-rows' ? 'Files' : 'FILESTREAM Files'}</th>{columns.map(column => <th key={column} scope="col">{headers[column]}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.name}>
          <td><bdi>{displayText(row.name)}</bdi></td><td>{row.files}</td>{columns.map(column => <td key={column}>{check(row[column], `${headers[column]} ${row.name}`)}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </section>
}

/**
 * Database Properties' Filegroups page: SSMS's Rows, FILESTREAM and Memory Optimized Data grids, read-only in this
 * version (adding, removing and changing filegroups is a follow-up).
 */
export default function FilegroupsPage({ open }: PageProps) {
  const { model } = databaseState(open)
  if (!model) return <p className="field-note">{open.phase === 'loading' ? 'Loading…' : ''}</p>
  const of = (type: DatabaseFilegroup['type']) => model.filegroups.filter(row => row.type === type)
  const filestream = model.server.filestreamLevel === 0 ? 'FILESTREAM is not enabled on this server.' : undefined
  return <div className="database-page database-filegroups">
    {model.readOnlyReason && <PageNote>{model.readOnlyReason}</PageNote>}
    <Section id="database-filegroups-rows" title="Rows" rows={of('rows')} columns={model.server.level >= 13 ? ['readOnly', 'isDefault', 'autogrowAllFiles'] : ['readOnly', 'isDefault']} />
    <Section id="database-filegroups-filestream" title="FILESTREAM" rows={of('filestream')} columns={['readOnly', 'isDefault']} disabled={filestream} />
    <Section id="database-filegroups-memory" title="Memory Optimized Data" rows={of('memoryOptimized')} columns={[]} />
    <PageNote>{model.filegroupsTruncated ? 'The database has more filegroups than are listed. ' : ''}Adding, removing and changing filegroups is not supported yet.</PageNote>
  </div>
}
