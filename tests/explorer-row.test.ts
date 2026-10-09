import { describe, expect, it } from 'vitest'
import type { ExplorerNodeRef } from '../src/shared/explorer/refs'
import { rowName, rowTooltip } from '../src/renderer/src/explorer/ExplorerRow'
import type { TreeNode } from '../src/renderer/src/explorer/tree-model'

const tableRef: ExplorerNodeRef = { type: 'object', object: { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' } }
/** A loaded node as ExplorerService keeps it, with `fields` over a table's defaults. */
function node(fields: Partial<TreeNode> = {}): TreeNode {
  return {
    id: 7, parent: 3, connectionId: 'c', ref: tableRef, kind: 'table', folder: undefined, level: 5, label: 'dbo.Orders', lower: 'dbo.orders', sublabel: undefined, detail: undefined,
    icon: 'svg:table', subtype: undefined, status: undefined, created: undefined, hasChildren: true, expanded: false, children: undefined, staticCount: 0, total: undefined,
    cursor: undefined, load: 'none', more: 'none', error: undefined, connectionError: undefined, filtered: false, lost: false, showLoading: false, generation: 0, rev: 0,
    lastUsed: 0, descendants: 0, ...fields
  }
}

describe('Object Explorer rows', () => {
  it('name a row by its label and sublabel as shown, then its state', () => {
    expect(rowName(node({ sublabel: '(System-Versioned)' }))).toBe('dbo.Orders (System-Versioned)')
    expect(rowName(node({ kind: 'folder', folder: 'tables', label: 'Tables', filtered: true }))).toBe('Tables (filtered)')
    expect(rowName(node({ kind: 'database', label: 'Legacy', sublabel: '(Offline)', status: 'unavailable' }))).toBe('Legacy (Offline), unavailable')
    expect(rowName(node({ kind: 'database', label: 'Locked', status: 'noAccess' }))).toBe('Locked, no access')
    expect(rowName(node({ kind: 'trigger', label: 'trg', status: 'disabled' }))).toBe('trg, disabled')
    expect(rowName(node({ kind: 'database', label: 'Archive', sublabel: '(Read-Only)', status: 'readOnly' }))).toBe('Archive (Read-Only)')
    expect(rowName(node({ load: 'error', error: { code: 'PERMISSION_DENIED', message: 'Denied.', retryable: true } }))).toBe('dbo.Orders, could not load')
    expect(rowName(node({ kind: 'server', label: 'crash-server', sublabel: '(SQL Server 16.0)', lost: true }))).toBe('crash-server (connection lost)')
    // Characters that are invisible or reorder text are shown as markers, never acted on.
    expect(rowName(node({ label: 'dbo.‮sredro' }))).toBe('dbo.⟨U+202E⟩sredro')
  })
  it('give a tooltip with the kind, creation date, facts, status, and any error, within the detail limit', () => {
    expect(rowTooltip(node({ sublabel: '(System-Versioned)', created: '2024-05-01T09:30:00', detail: 'Owner dbo' }))).toBe('dbo.Orders (System-Versioned)\nTable · Created 2024-05-01 09:30:00\nOwner dbo')
    expect(rowTooltip(node({ kind: 'folder', folder: 'audits', label: 'Audits', load: 'error', error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to view Audits.', retryable: true } })))
      .toBe('Audits\nCould not load: You do not have permission to view Audits.')
    expect(rowTooltip(node({ kind: 'database', label: 'Legacy', status: 'unavailable' }))).toBe('Legacy\nDatabase\nThe database is not available. Bring it online, then refresh Databases.')
    expect(rowTooltip(node({ kind: 'server', label: 'crash-server', sublabel: '(SQL Server 16.0)', lost: true })))
      .toBe('crash-server (connection lost)\nServer\nThe connection was lost when the SQL backend restarted. Reconnect, or remove the server.')
    const long = rowTooltip(node({ detail: 'x'.repeat(2000) }))
    expect(long).toHaveLength(512)
    expect(long.endsWith('…')).toBe(true)
  })
})
