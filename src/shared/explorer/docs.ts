// Renders docs/object-explorer.md from the catalogue; tests/explorer-catalog.test.ts keeps the file in sync.
import {
  childParentKinds, explorerLimits, filterPropertyLabels, folderIds, folderOwnerKinds, folderServed, folderSpecs, kindScopes, kindSpecs, laterFolders, maxBand, nodeKinds, scopeFields, statusBadges,
  subfolders, type FolderId, type InsertStyle, type KindSpec, type LaterFolder, type NodeKind, type NodeSubtype
} from './catalog.ts'

const cell = (value: string) => value.replaceAll('|', '\\|')
const row = (cells: readonly string[]) => '| ' + cells.map(cell).join(' | ') + ' |'
const table = (header: readonly string[], rows: readonly (readonly string[])[]) => [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n')
const code = (value: string) => '`' + value + '`'
const codes = (values: readonly string[]) => values.map(code).join(', ')
const versions: Readonly<Record<number, string>> = { 13: '2016', 14: '2017', 15: '2019', 16: '2022', 17: '2025' }
const since = (major?: number) => major === undefined ? '—' : `${versions[major] ?? major} (${major})`
const inserts: Readonly<Record<InsertStyle, string>> = { none: '—', onePart: '`[name]`', twoPart: '`[schema].[name]`', raw: 'the name as is (`@name`)' }
const limitNotes: Readonly<Record<keyof typeof explorerLimits, string>> = {
  pageSize: 'Rows per page, and the largest page a request may ask for',
  folderCap: 'Children a folder loads before it stops and suggests a filter',
  nodeBudget: 'Nodes held in the renderer before collapsed folders are evicted',
  inFlightPerConnection: 'Loads in flight per server (renderer and backend)',
  inFlightTotal: 'Loads in flight in total (renderer and backend)',
  queuePerConnection: 'Queued loads per server',
  cancelBatch: 'Request ids per cancellation',
  siblingLoads: 'Folders `*` (expand siblings) loads at once',
  filters: 'Filtered folders remembered per session',
  watchdogMs: 'Renderer timeout of one load, in ms',
  loadingRowDelayMs: 'Delay before a "Loading…" row appears, in ms',
  typeAheadMs: 'Type-ahead buffer reset, in ms',
  typeAheadMax: 'Type-ahead buffer length',
  rowHeight: 'Row height, in px',
  indent: 'Indentation per level, in px',
  overscan: 'Rows rendered beyond each edge of the viewport',
  deleteSlice: 'Nodes removed per task when a subtree is dropped',
  cursorLength: 'Characters in a page cursor',
  label: 'Characters in a node label',
  sublabel: 'Characters in a sublabel',
  detail: 'Characters in tooltip details',
  message: 'Characters in an error message'
}

const lists = (id: FolderId) => {
  const { list, rows = [] } = folderSpecs[id]
  return list ? `${rows.map(kind => kindSpecs[kind].title).join(', ')} (${code(list)})` : '—'
}
type Entry = { readonly label: string; readonly order: number; readonly id?: FolderId; readonly later?: LaterFolder }
/** A folder's (or an owner's top-level) served and planned subfolders, in SSMS order. */
function entries(owner: 'server' | 'database', parent?: FolderId): Entry[] {
  const served = (parent ? subfolders(parent) : folderIds.filter(id => !folderSpecs[id].parent && folderSpecs[id].owner === owner)).map(id => ({ label: folderSpecs[id].label, order: folderSpecs[id].order, id }))
  const later = laterFolders.filter(folder => folder.owner === owner && folder.parent === parent).map(folder => ({ label: folder.label, order: folder.order, later: folder }))
  return [...served, ...later].sort((a, b) => a.order - b.order)
}
function folderRows(owner: 'server' | 'database', parent?: FolderId, path = ''): string[][] {
  return entries(owner, parent).flatMap(entry => {
    const name = path + entry.label
    if (entry.later) {
      const contents = entry.later.contents ? `Planned: ${entry.later.contents.join(', ')}` : 'Planned'
      return [[name, '—', since(entry.later.since), '—', contents, '—']]
    }
    const spec = folderSpecs[entry.id!]
    const filters = spec.filter?.map(property => filterPropertyLabels[property]).join(', ') || '—'
    return [[name, code(spec.id), since(spec.since), folderServed(spec.id, { band: maxBand, engine: 'cloud' }) ? 'Yes' : 'No', lists(spec.id), filters], ...folderRows(owner, spec.id, name + ' › ')]
  })
}
const folderTable = (owner: 'server' | 'database') => table(['Folder', 'Id', 'Since', 'Cloud editions', 'Lists (query)', 'Filters'], folderRows(owner))

const folderLabels = (ids: readonly FolderId[]) => ids.map(id => folderSpecs[id].label).join(', ')
function childRows(spec: KindSpec): string[][] {
  if (!spec.folders.length && !spec.subtypeFolders) return []
  const special = Object.keys(spec.subtypeFolders ?? {}) as NodeSubtype[]
  const history = spec.historyLookup ?? []
  const others = (spec.subtypes ?? []).filter(subtype => !special.includes(subtype) && !history.includes(subtype))
  const rows = [[code(spec.kind), others.length ? `none, ${codes(others)}` : 'any', folderLabels(spec.folders)]]
  if (history.length) rows.push([code(spec.kind), codes(history), `Its history table first, then ${folderLabels(spec.folders)}`])
  const groups = new Map<string, NodeSubtype[]>()
  for (const subtype of special) { const key = folderLabels(spec.subtypeFolders![subtype]!); groups.set(key, [...groups.get(key) ?? [], subtype]) }
  for (const [labels, subtypes] of groups) rows.push([code(spec.kind), codes(subtypes), labels])
  return rows
}

function icons(spec: KindSpec): string {
  const variants = [...Object.entries(spec.subtypeIcons ?? {}), ...Object.entries(spec.variantIcons ?? {})].map(([name, icon]) => `${code(name)} → ${code(icon)}`)
  return [code(spec.icon), ...variants].join('; ')
}
const smo = (spec: KindSpec) => [spec.smo ?? '—', ...Object.entries(spec.subtypeSmo ?? {}).map(([subtype, name]) => `${code(subtype)} → ${name}`)].join('; ')
const kindsOfScope = (scope: string) => nodeKinds.filter(kind => kindSpecs[kind].scope === scope)
const fields = (values: readonly string[]) => values.length ? codes(values) : '—'

export function renderExplorerDocs(): string {
  const childKinds = nodeKinds.filter(kind => childParentKinds(kind).length)
  return [
    '# Object Explorer catalogue',
    '',
    '<!-- Generated from src/shared/explorer/catalog.ts. Regenerate with: npx vitest run tests/explorer-catalog.test.ts -u -->',
    '',
    'The tree Object Explorer serves, in SSMS order. Each folder lists its static subfolders first, then its rows. "Since" is',
    'the first SQL Server version (ProductMajorVersion) that has a folder; older servers do not show it. Planned folders are',
    'part of SSMS\'s tree but not served yet. Cloud editions (EngineEdition 5, 6, 9, 11 and 12) show only the folders marked',
    'for them. The backend embeds the same data as `backend/Varia.Backend/Explorer/explorer-catalog.json`.',
    '',
    '## Server',
    '',
    'The server row expands on connect; its folders stay collapsed.',
    '',
    folderTable('server'),
    '',
    '## Database',
    '',
    'A database expands only while it is online (or in emergency mode) and the login can open it. Snapshots have the same folders.',
    '',
    folderTable('database'),
    '',
    '## Object children',
    '',
    'Child folders list their rows by name, except Columns and Parameters, which keep the object\'s order. Every other kind is a leaf.',
    '',
    table(['Kind', 'Subtypes', 'Children'], nodeKinds.filter(kind => kind !== 'server' && kind !== 'database').flatMap(kind => childRows(kindSpecs[kind]))),
    '',
    table(['Folder', 'Id', 'Below', 'Lists (query)'], folderIds.filter(id => folderSpecs[id].owner === 'object').map(id => [folderSpecs[id].label, code(id), codes(folderOwnerKinds(id)), lists(id)])),
    '',
    `## Node kinds (${nodeKinds.length})`,
    '',
    'Icons are codicons, or `svg:` stroke icons drawn by `Icon.tsx`. Folders show `folder` (`folder-opened` while expanded).',
    'Inserts is what dragging the node into a query or Copy Name produces; names are bracket-quoted with `]` doubled.',
    '',
    table(['Kind', 'Title', 'Scope', 'Icons', 'SMO', 'Scriptable', 'Inserts'], nodeKinds.map(kind => {
      const spec = kindSpecs[kind]
      return [code(kind), spec.title, code(spec.scope), icons(spec), smo(spec), spec.scriptable ? 'Yes' : 'No', inserts[spec.insert]]
    })),
    '',
    '## Node identity',
    '',
    'A node is an object ref, or a folder below its nearest object (the server, a database, or a parent object). Refs carry',
    'names, never paths or object ids, and each scope fixes which fields a ref has. Names are 1 to 128 UTF-16 code units,',
    'used verbatim (never trimmed), without U+0000.',
    '',
    table(['Scope', 'Requires', 'Forbids', 'Kinds'], kindScopes.map(scope => [code(scope), fields(scopeFields[scope].required), fields(scopeFields[scope].forbidden), codes(kindsOfScope(scope))])),
    '',
    table(['Child kind', 'Parent kinds'], childKinds.map((kind: NodeKind) => [code(kind), codes(childParentKinds(kind))])),
    '',
    '## Status badges',
    '',
    'An 8×8 badge at the bottom right of the row icon. Disabled, unavailable and inaccessible nodes are dimmed as well;',
    'read-only databases are not, because their sublabel says it.',
    '',
    table(['Status', 'Badge'], Object.entries(statusBadges).map(([status, badge]) => [code(status), code(badge)])),
    '',
    '## Limits',
    '',
    table(['Limit', 'Value', 'Meaning'], (Object.keys(limitNotes) as (keyof typeof explorerLimits)[]).map(key => [code(key), explorerLimits[key].toLocaleString('en-US'), limitNotes[key]])),
    ''
  ].join('\n')
}
