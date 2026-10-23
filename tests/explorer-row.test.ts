import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ExplorerNodeRef } from '../src/shared/explorer/refs'
import ExplorerRow, { rowDescription, rowName, rowTooltip, type RowActions } from '../src/renderer/src/explorer/ExplorerRow'
import { RowKind } from '../src/renderer/src/explorer/tree-model'
import type { TreeNode } from '../src/renderer/src/explorer/tree-model'

// A server row draws its connection colour through the theme, which server rendering has no store for.
vi.mock('../src/renderer/src/core/WorkbenchContext', async original => ({ ...await original<object>(), useConnectionAccent: () => undefined }))

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
    expect(rowTooltip(node({ load: 'error', error: { code: 'NOT_FOUND', message: 'dbo.a\u202eb\nc no longer exists.', retryable: false } })))
      .toBe('dbo.Orders\nTable\nCould not load: dbo.a⟨U+202E⟩b⟨U+000A⟩c no longer exists.')
    const long = rowTooltip(node({ detail: 'x'.repeat(2000) }))
    expect(long).toHaveLength(512)
    expect(long.endsWith('…')).toBe(true)
  })
  it('describe a row with its tooltip after the name, which the accessible name already says', () => {
    expect(rowDescription(node({ sublabel: '(System-Versioned)', created: '2024-05-01T09:30:00', detail: 'Owner dbo' }))).toBe('Table · Created 2024-05-01 09:30:00\nOwner dbo')
    expect(rowDescription(node({ kind: 'database', label: 'Legacy', sublabel: '(Offline)', status: 'unavailable' })))
      .toBe('Database\nThe database is not available. Bring it online, then refresh Databases.')
    expect(rowDescription(node({ kind: 'folder', folder: 'tables', label: 'Tables' }))).toBeUndefined()
    expect(rowDescription(node({ detail: 'x'.repeat(2000) }))).toHaveLength(512)
  })
  it('render the inline Rename box in place of the label: the name without its schema, at most 128 units, named for the kind', () => {
    const actions: RowActions = { select: vi.fn(), toggle: vi.fn(), reconnect: vi.fn(), remove: vi.fn(), dragStart: vi.fn(() => true), commitRename: vi.fn(async () => true), cancelRename: vi.fn() }
    const render = (renaming: boolean) => renderToStaticMarkup(createElement(ExplorerRow, {
      rowId: 7, kind: RowKind.Node, index: 0, level: 5, posinset: 1, setsize: 1, node: node(), rev: 0, text: '', selected: true, draggable: true, active: false, color: undefined, actions, menuTarget: () => {}, renaming
    }))
    const editing = render(true)
    expect(editing).toContain('<input class="explorer-rename" maxLength="128" aria-label="Rename Table"')
    expect(editing).toContain('value="Orders"')
    expect(editing).not.toContain('oe-label')
    // While editing, the row cannot be dragged into a query, so selecting text in the box never starts a drag.
    expect(editing).not.toContain('draggable')
    const plain = render(false)
    expect(plain).toContain('<bdi class="oe-label">dbo.Orders</bdi>')
    expect(plain).not.toContain('explorer-rename')
  })
  it('end a server row with its environment tag, and say it in the row name and tooltip', () => {
    const actions: RowActions = { select: vi.fn(), toggle: vi.fn(), reconnect: vi.fn(), remove: vi.fn(), dragStart: vi.fn(() => false), commitRename: vi.fn(async () => true), cancelRename: vi.fn() }
    const render = (fields: Partial<TreeNode>, environment?: string) => renderToStaticMarkup(
      createElement(ExplorerRow, { rowId: 1, kind: RowKind.Node, index: 0, level: 1, posinset: 1, setsize: 1, node: node(fields), rev: 0, text: '', selected: false, draggable: false, active: false, color: undefined, environment, actions, menuTarget: () => {} }))
    const server = { id: 1, parent: 0, kind: 'server' as const, ref: { type: 'object' as const, object: { kind: 'server' as const } }, label: 'sql-prod-01', sublabel: '(SQL Server 17.0 - dba)', level: 1 }
    const prod = render(server, 'Production')
    expect(prod).toContain('<span class="environment-tag" data-place="explorer" data-tone="critical"><span class="status-pill tag small" data-tone="critical" title="Production environment"><span class="status-pill-label">PROD</span></span></span>')
    expect(prod).toContain('aria-label="sql-prod-01 (SQL Server 17.0 - dba), Production environment"')
    expect(prod).toContain('title="sql-prod-01 (SQL Server 17.0 - dba)\nServer\nProduction environment"')
    expect(render(server, 'UAT')).toContain('data-tone="neutral" title="UAT environment"><span class="status-pill-label">UAT</span>')
    expect(render(server)).not.toContain('environment-tag')
    // Only a server row has one.
    expect(render({}, 'Production')).not.toContain('environment-tag')
  })
})
