// Object Explorer's View Dependencies (SSMS's dialog of that name): a tree of the objects that depend on the selected object,
// or of those it depends on, one level read at a time with explorer.dependencies. A level is one of Peek's two Dependencies
// listings (backend Explorer/PeekSql.cs, `PeekSql.Level`), so the dialog and Peek's tab read the same SQL.
import type { ExplorerError } from '../contracts.ts'
import type { NodeKind } from './catalog.ts'
import { peekHas, peekKinds, type PeekDependency, type PeekKind, type PeekParams } from './peek.ts'

/** The kinds View Dependencies is offered on: those whose Peek has the Dependencies tab (SSMS's: tables, views, procedures, functions, synonyms, types, triggers and sequences). */
export const dependencyKinds: readonly PeekKind[] = peekKinds.filter(kind => peekHas(kind, 'dependencies'))
export const isDependencyKind = (kind: string): kind is PeekKind => (dependencyKinds as readonly string[]).includes(kind)

/** The dialog's two choices, in SSMS's order: the objects that depend on the selected one, and the objects it depends on. */
export const dependencyDirections = ['usedBy', 'uses'] as const
export type DependencyDirection = typeof dependencyDirections[number]
/** SSMS's words for the two choices. */
export const dependencyDirectionLabels: { readonly [D in DependencyDirection]: (name: string) => string } = {
  usedBy: name => `Objects that depend on ${name}`,
  uses: name => `Objects on which ${name} depends`
}

export const dependencyLimits = {
  /** Objects one level lists (the backend's `dependencyLevel`, in the explorer catalogue's peek block); a level with more says so. */
  perLevel: 500,
  /** Levels below the selected object; a node this deep is not expanded further, and says why. */
  depth: 32,
  /** Nodes one tree holds in all; an expansion past it lists only what fits and says so. */
  nodes: 10_000
} as const

/** explorer.dependencies: one level of the tree, for an object of a `dependencyKinds` kind, on Peek's slot within its budget. */
export interface DependenciesParams extends PeekParams {
  readonly direction: DependencyDirection
}
export interface DependenciesResult {
  /** At most `dependencyLimits.perLevel` objects in name order (Peek's Dependencies rows). */
  readonly items: readonly PeekDependency[]
  readonly truncated?: true
  readonly elapsedMs: number
  /** Items are empty with an error. */
  readonly error?: ExplorerError
}

/** sys.objects types in SSMS's words, for the Type of a dependency. */
export const objectTypeWords: Readonly<Record<string, string>> = {
  U: 'Table', ET: 'External table', S: 'System table', IT: 'Internal table', V: 'View',
  P: 'Stored procedure', PC: 'CLR stored procedure', X: 'Extended stored procedure', RF: 'Replication-filter procedure',
  FN: 'Scalar-valued function', IF: 'Inline table-valued function', TF: 'Table-valued function', FS: 'CLR scalar-valued function',
  FT: 'CLR table-valued function', AF: 'Aggregate function',
  TR: 'Trigger', TA: 'CLR trigger', SN: 'Synonym', SO: 'Sequence', TT: 'User-defined table type',
  D: 'Default constraint', C: 'Check constraint', F: 'Foreign key constraint', PK: 'Primary key constraint', UQ: 'Unique constraint', EC: 'Edge constraint',
  R: 'Rule', SQ: 'Service queue'
}

/**
 * Why a node is not expanded: a linked server's or another database's object (only named, never read), a reference SQL Server
 * did not resolve, an object of a kind the tree does not describe, one already above it on its branch (a cycle), or one at the
 * depth bound.
 */
export type DependencyLeaf = 'linkedServer' | 'otherDatabase' | 'unresolved' | 'notListed' | 'cycle' | 'depth'
export const dependencyLeafWords: { readonly [L in DependencyLeaf]: string } = {
  linkedServer: 'On a linked server: not followed',
  otherDatabase: 'In another database: not followed',
  unresolved: 'Unresolved reference',
  notListed: 'Not followed',
  cycle: 'Cycle: already above on this branch',
  depth: `Not followed past ${dependencyLimits.depth} levels`
}

/** A dependency's Type: its object type in words, else what is known (a linked server's or another database's object, an unresolved name). */
export function dependencyTypeWord(item: PeekDependency, kindTitle?: (kind: NodeKind) => string): string {
  if (item.type !== undefined) return objectTypeWords[item.type] ?? item.type
  if (item.kind !== undefined && kindTitle) return kindTitle(item.kind)
  if (item.server !== undefined) return 'Linked server object'
  if (item.database !== undefined) return 'Cross-database object'
  return 'Unresolved'
}
/** A dependency's Dependency type, as SSMS words it: a foreign key, or a schema-bound or non-schema-bound reference. */
export const dependencyKindWord = (item: PeekDependency): string => item.foreignKey ? 'Foreign key' : item.schemaBound ? 'Schema-bound' : 'Non-schema-bound'
