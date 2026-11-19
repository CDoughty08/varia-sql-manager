import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TablePropertiesModel } from '../src/shared/actions/tables'
import { boundTable, localCopyText } from '../src/shared/results/local-table'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import { filegroupLists, filegroupsTable, filesTable, partitionsTable, permissionsTable, predicatesTable } from '../src/renderer/src/properties/grids'
import PropertiesGrid, { propertiesGridHeight, propertiesGridRows } from '../src/renderer/src/properties/PropertiesGrid'
import { databaseModel } from './fixtures/database-properties'
import { workbenchFixture } from './fixtures/workbench'

/** Only what the lists read of a table's describe. */
const tableModel = (patch: Partial<TablePropertiesModel>) => ({
  storage: { rowCount: 0, compression: 'NONE', partitioned: true, partitions: [], partitionsTruncated: false },
  permissions: [], permissionsTruncated: false, securityPredicates: [], securityPredicatesTruncated: false, ...patch
}) as unknown as TablePropertiesModel

describe('Properties lists as local tables', () => {
  it('lists permissions with their words, a column only where one is named', () => {
    const table = permissionsTable(tableModel({ permissions: [
      { principal: 'app', principalType: 'SQL_USER', permission: 'SELECT', state: 'GRANT', grantor: 'dbo' },
      { principal: 'auditor', principalType: 'DATABASE_ROLE', permission: 'UPDATE', column: 'Total', state: 'GRANT_WITH_GRANT_OPTION', grantor: 'dbo' }
    ] }))
    expect(table.columns.map(column => column.name)).toEqual(['Principal', 'Type', 'Permission', 'Column', 'State', 'Grantor'])
    expect(table.rows).toEqual([['app', 'Sql user', 'SELECT', '', 'Grant', 'dbo'], ['auditor', 'Database role', 'UPDATE', 'Total', 'Grant with grant', 'dbo']])
  })
  it('writes numbers as plain digits in number columns, so they sort by value and save as numbers', () => {
    const table = partitionsTable(tableModel({ storage: { partitioned: true, partitions: [{ number: 1, rows: 1_200_000, compression: 'PAGE', filegroup: 'FG1' }, { number: 2, rows: 0, compression: 'NONE' }] } as unknown as TablePropertiesModel['storage'] }))
    expect(table.columns).toEqual([{ name: 'Partition', kind: 'number' }, { name: 'Rows', kind: 'number' }, { name: 'Compression' }, { name: 'Filegroup' }])
    expect(table.rows).toEqual([['1', '1200000', 'Page', 'FG1'], ['2', '0', 'None', '']])
    const files = filesTable(databaseModel())
    expect(files.columns.filter(column => column.kind === 'number').map(column => column.name)).toEqual(['Size (MB)'])
    expect(files.rows[0]).toEqual(['AppData', 'ROWS Data', 'PRIMARY', '8', 'By 64 MB, Unlimited', 'C:\\Data', 'AppData.mdf'])
    // A log has no filegroup; a FILESTREAM container has no size.
    expect(files.rows[1][2]).toBe('Not Applicable')
    const stream = filesTable(databaseModel({ files: [{ name: 'Docs', type: 'filestream', filegroup: 'FS', sizeMb: 0, growth: { enabled: false }, path: 'C:\\Docs', fileName: 'Docs', isPrimary: false }] as never }))
    expect(stream.rows[0][3]).toBe('')
  })
  it('keeps a cut predicate\'s ellipsis and reads an operation-less predicate as All', () => {
    const table = predicatesTable(tableModel({ securityPredicates: [
      { policy: 'rls.Tenant', type: 'FILTER', predicate: '([rls].[fn]([TenantId]))', enabled: true },
      { policy: 'rls.Tenant', type: 'BLOCK', operation: 'AFTER_INSERT', predicate: 'x'.repeat(10), predicateTruncated: true, enabled: false }
    ] }))
    expect(table.rows).toEqual([['rls.Tenant', 'Filter', 'All', '([rls].[fn]([TenantId]))', 'True'], ['rls.Tenant', 'Block', 'After insert', `${'x'.repeat(10)}…`, 'False']])
  })
  it('splits filegroups into SSMS\'s three lists, Autogrow All Files only from SQL Server 2016', () => {
    const model = databaseModel({ filegroups: [
      { name: 'PRIMARY', type: 'rows', files: 1, readOnly: false, isDefault: true, autogrowAllFiles: false },
      { name: 'Docs', type: 'filestream', files: 2, readOnly: true, isDefault: false },
      { name: 'Hot', type: 'memoryOptimized', files: 1, readOnly: false, isDefault: false }
    ] })
    const [rows, stream, memory] = filegroupLists(model).map(list => filegroupsTable(model, list))
    expect(rows).toEqual({ columns: [{ name: 'Name' }, { name: 'Files', kind: 'number' }, { name: 'Read-Only' }, { name: 'Default' }, { name: 'Autogrow All Files' }], rows: [['PRIMARY', '1', 'No', 'Yes', 'No']] })
    expect(stream).toEqual({ columns: [{ name: 'Name' }, { name: 'FILESTREAM Files', kind: 'number' }, { name: 'Read-Only' }, { name: 'Default' }], rows: [['Docs', '2', 'Yes', 'No']] })
    expect(memory).toEqual({ columns: [{ name: 'Name' }, { name: 'FILESTREAM Files', kind: 'number' }], rows: [['Hot', '1']] })
    const old = databaseModel({ server: { ...model.server, level: 12 } })
    expect(filegroupLists(old)[0].flags).toEqual(['readOnly', 'isDefault'])
  })
  it('copies what the page shows, with headers, as a results grid writes it', async () => {
    const table = boundTable(filesTable(databaseModel()))
    const copied = await localCopyText(table, [{ rows: [[0, 1]], columns: [[0, 2]] }], { headers: true, crlf: false })
    expect(copied.text).toBe([['Logical Name', 'File Type', 'Filegroup'], ['AppData', 'ROWS Data', 'PRIMARY'], ['AppData_log', 'LOG', 'Not Applicable']].map(row => row.join('\t')).join('\n'))
  })
})

describe('Properties grid', () => {
  it('is as tall as its rows up to a window of them, with room for its words when empty', () => {
    expect(propertiesGridHeight(3, 0)).toBe(22 + 3 * 20 + 2)
    expect(propertiesGridHeight(500, 17)).toBe(22 + propertiesGridRows * 20 + 17 + 2)
    expect(propertiesGridHeight(0, 17)).toBe(22 + 48 + 2)
  })
  it('draws a page grid named for its list inside a box of that height', () => {
    const workbench = { ...workbenchFixture(), platform: 'win32' } as unknown as Workbench
    const markup = renderToStaticMarkup(createElement(WorkbenchProvider, { workbench, children: createElement(PropertiesGrid, { table: filesTable(databaseModel()), label: 'Database files', empty: 'No files are listed.', suggestedName: 'AppData files' }) }))
    expect(markup).toContain(`<div class="properties-grid" style="height:${propertiesGridHeight(2, 0)}px">`)
    expect(markup).toMatch(/class="rg-frame local-grid" data-local-grid="page"/)
    expect(markup).toMatch(/role="grid"[^>]*aria-label="Database files"|aria-label="Database files"[^>]*role="grid"/)
  })
})
