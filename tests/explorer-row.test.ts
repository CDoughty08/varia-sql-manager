import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ExplorerNodeRef } from '../src/shared/explorer/refs'
import ExplorerRow, { changedSentence, connectionState, itemCount, Label, liveDatabase, RowEnd, rowDescription, rowName, rowTooltip, shownSublabel, type RowActions, type RowProps } from '../src/renderer/src/explorer/ExplorerRow'
import { onlineStatus, type RowStatus } from '../src/renderer/src/explorer/ExplorerStatusService'
import { databaseChips, serverChips } from '../src/shared/explorer/status'
import { RowKind } from '../src/renderer/src/explorer/tree-model'
import type { TreeNode } from '../src/renderer/src/explorer/tree-model'

// A server row draws its connection colour through the theme, which server rendering has no store for.
vi.mock('../src/renderer/src/core/WorkbenchContext', async original => ({ ...await original<object>(), useConnectionAccent: () => undefined }))

const tableRef: ExplorerNodeRef = { type: 'object', object: { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' } }
/** A loaded node as ExplorerService keeps it, with `fields` over a table's defaults. */
function node(fields: Partial<TreeNode> = {}): TreeNode {
  return {
    id: 7, parent: 3, connectionId: 'c', ref: tableRef, kind: 'table', folder: undefined, level: 5, label: 'dbo.Orders', lower: 'dbo.orders', sublabel: undefined, detail: undefined,
    icon: 'table', subtype: undefined, status: undefined, created: undefined, hasChildren: true, expanded: false, children: undefined, staticCount: 0, total: undefined,
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
    const actions: RowActions = { select: vi.fn(), toggle: vi.fn(), activate: vi.fn(), reconnect: vi.fn(), remove: vi.fn(), dragStart: vi.fn(() => true), commitRename: vi.fn(async () => true), cancelRename: vi.fn() }
    const render = (renaming: boolean) => renderToStaticMarkup(createElement(ExplorerRow, {
      rowId: 7, kind: RowKind.Node, top: 0, level: 5, posinset: 1, setsize: 1, node: node(), rev: 0, text: '', selected: true, draggable: true, active: false, color: undefined, actions, menuTarget: () => {}, renaming
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
    const actions: RowActions = { select: vi.fn(), toggle: vi.fn(), activate: vi.fn(), reconnect: vi.fn(), remove: vi.fn(), dragStart: vi.fn(() => false), commitRename: vi.fn(async () => true), cancelRename: vi.fn() }
    const render = (fields: Partial<TreeNode>, environment?: string) => renderToStaticMarkup(
      createElement(ExplorerRow, { rowId: 1, kind: RowKind.Node, top: 0, level: 1, posinset: 1, setsize: 1, node: node(fields), rev: 0, text: '', selected: false, draggable: false, active: false, color: undefined, environment, actions, menuTarget: () => {} }))
    const server = { id: 1, parent: 0, kind: 'server' as const, ref: { type: 'object' as const, object: { kind: 'server' as const } }, label: 'sql-prod-01', sublabel: '(SQL Server 17.0 - dba)', level: 1 }
    const prod = render(server, 'Production')
    // In the row's end (RowEnd's indicator slot), before the connection dot.
    expect(prod).toContain('<span class="oe-end"><span class="environment-tag" data-place="explorer" data-tone="critical"><span class="status-pill tag small" data-tone="critical" title="Production environment"><span class="status-pill-label">PROD</span></span></span><span class="oe-dot" data-state="online"')
    expect(prod).toContain('aria-label="sql-prod-01 (SQL Server 17.0 - dba), Production environment"')
    expect(prod).toContain('title="sql-prod-01 (SQL Server 17.0 - dba)\nServer\nProduction environment"')
    expect(render(server, 'UAT')).toContain('data-tone="neutral" title="UAT environment"><span class="status-pill-label">UAT</span>')
    expect(render(server)).not.toContain('environment-tag')
    // Only a server row has one.
    expect(render({}, 'Production')).not.toContain('environment-tag')
  })
})

describe('Object Explorer row visuals', () => {
  const actions: RowActions = { select: vi.fn(), toggle: vi.fn(), activate: vi.fn(), reconnect: vi.fn(), remove: vi.fn(), dragStart: vi.fn(() => true), commitRename: vi.fn(async () => true), cancelRename: vi.fn() }
  // Folder and object rows need no workbench (server rows read the theme for their connection color).
  const render = (value: TreeNode, props: Partial<RowProps> = {}) => renderToStaticMarkup(createElement(ExplorerRow, {
    rowId: value.id, kind: RowKind.Node, top: 52, level: value.level, posinset: 1, setsize: 1, node: value, rev: 0, text: '', selected: false, draggable: false, active: false,
    color: undefined, actions, menuTarget: () => {}, ...props
  }))
  const tables = (fields: Partial<TreeNode> = {}) => node({ kind: 'folder', folder: 'tables', label: 'Tables', lower: 'tables', ref: { type: 'folder', owner: { kind: 'database', name: 'AppData' }, folder: 'tables' }, ...fields })
  const server = (fields: Partial<TreeNode> = {}) => node({ parent: 0, level: 1, kind: 'server', label: 'localhost', sublabel: '(SQL Server 17.0.1000.7 - sa)', brief: '17.0 · sa', ...fields })
  it('count the objects a listing folder holds, without its static subfolders, once it has loaded', () => {
    expect(itemCount(tables({ total: 72, staticCount: 1 }))).toBe(71)
    expect(itemCount(tables())).toBeUndefined()
    expect(itemCount(node({ total: 3 }))).toBeUndefined()
    // A folder that lists nothing of its own (Security) has no count.
    expect(itemCount(node({ kind: 'folder', folder: 'serverSecurity', total: 2 }))).toBeUndefined()
    const markup = render(tables({ total: 1_235, staticCount: 1 }))
    expect(markup).toContain('<span class="oe-end"><span class="oe-count" aria-hidden="true">1,234</span></span>')
    expect(rowTooltip(tables({ total: 2, staticCount: 1 }))).toBe('Tables\n1 item')
    expect(rowDescription(tables({ total: 1_235, staticCount: 1 }))).toBe('1,234 items')
    // While Filter loaded objects shows only some of its rows, the folder says no count, to the eye or in words.
    const partial = render(tables({ total: 1_235, staticCount: 1 }), { match: 'ord', partial: true })
    expect(partial).toContain('<span class="oe-end"></span>')
    expect(partial).not.toContain('1,234')
    expect(partial).toContain('title="Tables"')
    expect(rowDescription(tables({ total: 1_235, staticCount: 1 }), false)).toBeUndefined()
    // Placed by its offset, so rows below a taller server row sit lower; a row with nothing at its end has an empty one.
    expect(markup).toContain('transform:translateY(52px)')
    expect(render(node())).toContain('<span class="oe-end"></span>')
  })
  it('show a server\'s version and login in brief, keeping SSMS\'s text for its name and tooltip, and end with its connection', () => {
    expect(shownSublabel(server())).toBe('17.0 · sa')
    expect(shownSublabel(server({ lost: true }))).toBe('(connection lost)')
    expect(shownSublabel(node({ sublabel: '(int, not null)' }))).toBe('(int, not null)')
    expect(rowName(server())).toBe('localhost (SQL Server 17.0.1000.7 - sa)')
    expect(rowTooltip(server())).toBe('localhost (SQL Server 17.0.1000.7 - sa)\nServer')
    expect([connectionState(server()), connectionState(server({ connectionError: { code: 'CONNECTION_LOST', message: 'x', retryable: true } })), connectionState(server({ lost: true }))]).toEqual(['online', 'error', 'lost'])
    const end = (props: Parameters<typeof RowEnd>[0]) => renderToStaticMarkup(createElement(RowEnd, props))
    expect(end({ connection: 'online' })).toBe('<span class="oe-end"><span class="oe-dot" data-state="online" title="Connected" aria-hidden="true"></span></span>')
    expect(end({ connection: 'error' })).toContain('data-state="error" title="Connection failed"')
    // Later indicators come first, then the count and dot, then a lost server's buttons.
    expect(end({ connection: 'lost', count: 3, children: createElement('i', null, 'PROD'), actions: createElement('b', null, 'Reconnect') }))
      .toBe('<span class="oe-end"><i>PROD</i><span class="oe-count" aria-hidden="true">3</span><span class="oe-dot" data-state="lost" title="Connection lost" aria-hidden="true"></span><b>Reconnect</b></span>')
    // The active query's server is marked by a glyph before its dot, not by a fill that would pass for a selection.
    expect(end({ connection: 'online', active: true })).toBe('<span class="oe-end"><span class="oe-active" title="Server of the active query" aria-hidden="true"><span class="codicon codicon-file-code" data-icon="file-code" aria-hidden="true"></span></span><span class="oe-dot" data-state="online" title="Connected" aria-hidden="true"></span></span>')
  })
  it('show a database\'s live state as chips in place of its listed sublabel, and say when it differs from the list', () => {
    const database = (fields: Partial<TreeNode> = {}) => node({ kind: 'database', label: 'Sales', lower: 'sales', ref: { type: 'object', object: { kind: 'database', name: 'Sales' } }, icon: 'database', level: 3, ...fields })
    const restoring: RowStatus = { chips: databaseChips({ name: 'Sales', state: 1, userAccess: 1, readOnly: false, standby: false }, { name: 'Sales', command: 'RESTORE DATABASE', percent: 42 }), live: true, words: 'Restoring 42 %, Single user', state: 'unavailable' }
    // Listed online, now restoring: chips at the row's end, no sublabel, dimmed with the unavailable badge, and a note.
    const markup = render(database(), { status: restoring })
    expect(markup).toContain('<span class="oe-end"><span class="oe-chips" aria-hidden="true"><span class="status-pill small" data-tone="running" title="The database is being restored, or waits for more backups to restore (WITH NORECOVERY). RESTORE DATABASE: 42 % done.">')
    // The percentage never gives way: the word beside it ends in an ellipsis first, and the pill still reads the whole label.
    expect(markup).toContain('<span class="status-pill-label">RESTORING </span><span class="status-pill-value">42 %</span>')
    expect(markup).toContain('<span class="status-pill-label">SINGLE USER</span>')
    expect(markup).not.toContain('oe-sublabel')
    expect(markup).toContain('class="explorer-row dimmed"')
    expect(markup).toContain('aria-label="Sales (Restoring 42 %, Single user), unavailable"')
    expect(markup).toContain(`aria-description="Database\nThe database is not available. Bring it online, then refresh Databases.\n${changedSentence}"`)
    // Listed offline, now online: no chips, no sublabel, not dimmed, and the note says to refresh.
    const online = render(database({ sublabel: '(Offline)', status: 'unavailable', hasChildren: false }), { status: onlineStatus })
    expect(online).toContain('<span class="oe-end"></span>')
    expect(online).not.toContain('Offline')
    expect(online).not.toContain('dimmed')
    expect(online).toContain(`title="Sales\nDatabase\n${changedSentence}"`)
    // Listed as it is: no note. A login without access keeps noAccess while the database is usable.
    expect(render(database({ sublabel: '(Read-Only)', status: 'readOnly' }), { status: { chips: databaseChips({ name: 'Sales', state: 0, userAccess: 0, readOnly: true, standby: false }), live: true, words: 'Read-only', state: 'readOnly' } }))
      .toContain('title="Sales (Read-only)\nDatabase"')
    expect(liveDatabase(database({ status: 'noAccess' }), onlineStatus)).toMatchObject({ node: { status: 'noAccess' }, changed: false })
    expect(liveDatabase(database({ status: 'noAccess' }), restoring)).toMatchObject({ node: { status: 'unavailable' }, changed: true })
    // Without live status (no sample yet, the probe failing, or the setting off) the row is as listed.
    expect(render(database({ sublabel: '(Offline)', status: 'unavailable' }))).toContain('<span class="oe-sublabel">(Offline)</span>')
    // Other rows take no database state from a status.
    expect(render(node(), { status: restoring })).not.toMatch(/Restoring|RESTORING|oe-chips/)
  })
  it('end a server row with its live chips before its environment tag, and say them after its name', () => {
    const chips = serverChips(2, [{ name: 'AG‮1', health: 1, role: 1 }])
    const status: RowStatus = { chips, live: true, words: chips.map(chip => chip.words).join(', ') }
    const markup = render(server(), { status })
    expect(markup).toContain('<span class="status-pill-value">2</span><span class="status-pill-label"> jobs running</span>')
    // Group names are the server's text: markers for hidden characters, in the chip and its tooltip.
    expect(markup).toContain('<span class="status-pill-label">AG⟨U+202E⟩1 partially healthy</span>')
    expect(markup).toContain('title="Availability groups\nAG⟨U+202E⟩1: partially healthy, primary"')
    expect(markup).toContain('aria-label="localhost (SQL Server 17.0.1000.7 - sa), SQL Server Agent: 2 jobs running, Availability groups: AG⟨U+202E⟩1 partially healthy"')
    expect(markup).toContain('<span class="oe-sublabel">17.0 · sa</span>')
  })
  it('mark the part of the label that matches the filter, keeping the label\'s text whole', () => {
    expect(render(node(), { match: 'ord' })).toContain('<bdi class="oe-label">dbo.<span class="oe-match">Ord</span>ers</bdi>')
    expect(render(node(), { match: 'zzz' })).toContain('<bdi class="oe-label">dbo.Orders</bdi>')
    // The match is found in the text as shown, markers for hidden characters included.
    expect(renderToStaticMarkup(createElement(Label, { text: 'dbo.a\u202eorders', match: 'ord' }))).toBe('<bdi class="oe-label">dbo.a⟨U+202E⟩<span class="oe-match">ord</span>ers</bdi>')
    // Where lower-casing changes the length, nothing is marked rather than the wrong letters.
    expect(renderToStaticMarkup(createElement(Label, { text: 'İstanbul', match: 'stan' }))).toBe('<bdi class="oe-label">İstanbul</bdi>')
  })
})
