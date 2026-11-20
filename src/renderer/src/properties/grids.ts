// Table and Database Properties' lists as local tables (docs/architecture.md, Local tables), without the DOM: each is
// built from the text the page shows, so Copy and Save take what is on screen. Node tests run it.
import { autogrowthText, fileTypeLabel, notApplicable } from '../../../shared/actions/database.ts'
import type { DatabaseFilegroup, DatabasePropertiesModel } from '../../../shared/actions/schema.ts'
import type { TablePropertiesModel } from '../../../shared/actions/tables.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { localTableLimits, type LocalTableData } from '../../../shared/results/local-table.ts'
import { tokenText } from './table-fields'

const number = (name: string) => ({ name, kind: 'number' as const })

/** Permissions granted or denied on the table: one row per permission, as sys.database_permissions lists them. */
export function permissionsTable(model: TablePropertiesModel): LocalTableData {
  return {
    columns: [{ name: 'Principal' }, { name: 'Type' }, { name: 'Permission' }, { name: 'Column' }, { name: 'State' }, { name: 'Grantor' }],
    rows: model.permissions.map(row => [displayText(row.principal), tokenText(row.principalType), row.permission, row.column ? displayText(row.column) : '',
      row.state === 'GRANT_WITH_GRANT_OPTION' ? 'Grant with grant' : tokenText(row.state), displayText(row.grantor)])
  }
}

/** A partitioned table's partitions; numbers as plain digits, as a results grid shows them, so they sort and save as numbers. */
export function partitionsTable(model: TablePropertiesModel): LocalTableData {
  return {
    columns: [number('Partition'), number('Rows'), { name: 'Compression' }, { name: 'Filegroup' }],
    rows: model.storage.partitions.map(row => [String(row.number), String(row.rows), tokenText(row.compression), displayText(row.filegroup ?? '')])
  }
}

/** A definition the describe cut ends in an ellipsis, as it did on screen, within the cell bound: the describe's cut is
 *  already the bound's length, and a cell past it would lose the ellipsis and be marked cut by the grid instead. */
const cutText = (text: string, truncated: boolean | undefined) => truncated ? `${text.slice(0, localTableLimits.cellChars - 1)}…` : text
/** Row-level security predicates on the table. */
export function predicatesTable(model: TablePropertiesModel): LocalTableData {
  return {
    columns: [{ name: 'Security policy' }, { name: 'Type' }, { name: 'Operation' }, { name: 'Predicate' }, { name: 'Enabled' }],
    rows: (model.securityPredicates ?? []).map(row => [displayText(row.policy), tokenText(row.type), row.operation ? tokenText(row.operation) : 'All',
      cutText(displayText(row.predicate), row.predicateTruncated), row.enabled ? 'True' : 'False'])
  }
}

/** The database's files in SSMS's columns; a log has no filegroup and a FILESTREAM container no size. */
export function filesTable(model: DatabasePropertiesModel): LocalTableData {
  return {
    columns: [{ name: 'Logical Name' }, { name: 'File Type' }, { name: 'Filegroup' }, number('Size (MB)'), { name: 'Autogrowth / Maxsize' }, { name: 'Path' }, { name: 'File Name' }],
    rows: model.files.map(file => [displayText(file.name), fileTypeLabel[file.type], file.type === 'log' ? notApplicable : displayText(file.filegroup ?? ''),
      file.type === 'filestream' ? '' : String(file.sizeMb), autogrowthText(file.growth, file.type), displayText(file.path), displayText(file.fileName)])
  }
}

/** A filegroup flag's column; Autogrow All Files only from SQL Server 2016 (level 13). */
export type FilegroupFlag = 'readOnly' | 'isDefault' | 'autogrowAllFiles'
const flagNames: Readonly<Record<FilegroupFlag, string>> = { readOnly: 'Read-Only', isDefault: 'Default', autogrowAllFiles: 'Autogrow All Files' }
/** SSMS's three filegroup lists, in its order, with the flags each shows. */
export interface FilegroupList { readonly key: 'rows' | 'filestream' | 'memory'; readonly title: string; readonly type: DatabaseFilegroup['type']; readonly flags: readonly FilegroupFlag[] }
export function filegroupLists(model: DatabasePropertiesModel): readonly FilegroupList[] {
  return [
    { key: 'rows', title: 'Rows', type: 'rows', flags: model.server.level >= 13 ? ['readOnly', 'isDefault', 'autogrowAllFiles'] : ['readOnly', 'isDefault'] },
    { key: 'filestream', title: 'FILESTREAM', type: 'filestream', flags: ['readOnly', 'isDefault'] },
    { key: 'memory', title: 'Memory Optimized Data', type: 'memoryOptimized', flags: [] }
  ]
}
/** One filegroup list: name, file count and its flags as Yes or No. */
export function filegroupsTable(model: DatabasePropertiesModel, list: FilegroupList): LocalTableData {
  return {
    columns: [{ name: 'Name' }, number(list.key === 'rows' ? 'Files' : 'FILESTREAM Files'), ...list.flags.map(flag => ({ name: flagNames[flag] }))],
    rows: model.filegroups.filter(row => row.type === list.type).map(row => [displayText(row.name), String(row.files), ...list.flags.map(flag => row[flag] ? 'Yes' : 'No')])
  }
}
