// Renders docs/object-explorer.md from the catalogue; tests/explorer-catalog.test.ts keeps the file in sync.
import {
  childParentKinds, explorerLimits, filterPropertyLabels, folderIds, folderOwnerKinds, folderServed, folderSpecs, kindScopes, kindSpecs, laterFolders, maxBand, nodeKinds, schemaGroupList,
  schemaGroupRoots, schemaPlacement, scopeFields, statusBadges, statusChipKinds, subfolders, type FolderId, type InsertStyle, type KindSpec, type LaterFolder, type NodeKind, type NodeSubtype
} from './catalog.ts'
import { loginChipDocs, statusChipDocs } from './status.ts'
import { peekKinds, peekLimits, peekSpecs } from './peek.ts'
import { loginDetailWords, loginTypeSubtypes, type LoginType } from '../actions/logins.ts'
import { glyphSizes } from '../theme/metrics.ts'

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
  serverRowHeight: 'Height of a server row, in px',
  indent: 'Indentation per level, in px',
  overscan: 'Rows rendered beyond each edge of the viewport',
  deleteSlice: 'Nodes removed per task when a subtree is dropped',
  cursorLength: 'Characters in a page cursor',
  label: 'Characters in a node label',
  sublabel: 'Characters in a sublabel',
  detail: 'Characters in tooltip details',
  message: 'Characters in an error message',
  maxName: 'UTF-16 code units in the longest name a kind may declare; every other kind keeps 128',
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
/** A kind's static folders, then the rows it lists itself (`KindSpec.list`). */
const childLabels = (spec: KindSpec, folders: readonly FolderId[]) => {
  const rows = spec.list ? `${(spec.rows ?? []).map(kind => kindSpecs[kind].title).join(', ')} rows (${code(spec.list)})` : undefined
  return [folderLabels(folders), rows].filter(Boolean).join(', then ')
}
function childRows(spec: KindSpec): string[][] {
  if (!spec.folders.length && !spec.subtypeFolders && !spec.list) return []
  const special = Object.keys(spec.subtypeFolders ?? {}) as NodeSubtype[]
  const history = spec.historyLookup ?? []
  const others = (spec.subtypes ?? []).filter(subtype => !special.includes(subtype) && !history.includes(subtype))
  const rows = [[code(spec.kind), others.length ? `none, ${codes(others)}` : 'any', childLabels(spec, spec.folders)]]
  if (history.length) rows.push([code(spec.kind), codes(history), `Its history table first, then ${childLabels(spec, spec.folders)}`])
  const groups = new Map<string, NodeSubtype[]>()
  for (const subtype of special) { const key = childLabels(spec, spec.subtypeFolders![subtype]!); groups.set(key, [...groups.get(key) ?? [], subtype]) }
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
    'for them. A server whose catalog columns are newer than its reported version, such as Azure SQL Database or Managed',
    'Instance (both report version 12), is treated as the version those columns belong to. The backend embeds the same data',
    'as `backend/Varia.Backend/Explorer/explorer-catalog.json`.',
    '',
    '## Server',
    '',
    'The server row expands on connect; its folders stay collapsed.',
    '',
    folderTable('server'),
    '',
    '## Database',
    '',
    'A database expands only while it is online (or in emergency mode). Expanding one the login cannot open shows why on a row below it. Snapshots have the same folders.',
    '',
    folderTable('database'),
    '',
    '## Group by Schema',
    '',
    'SSMS 2022\'s Group by Schema (Options › SQL Server Object Explorer › Commands, `objectExplorer.groupBySchema`, or the',
    'toolbar\'s Group by Schema button) moves a database\'s schema-scoped folders below one row per schema. The database lists',
    `the folders that stay below it, then its schemas (query ${code(schemaGroupList)}): every schema but the fixed database roles'`,
    'ones, and `guest`, `INFORMATION_SCHEMA` and `sys` only while they hold an object. A schema row has the folders below,',
    'listing that schema\'s objects by name alone (the row already says the schema). A folder below a schema row is filtered on',
    'its own and offers every filter property of the folder but Schema. Children requests for a database and its folders say',
    'that grouping is on (`groupBySchema`); a schema row and its folders are named by their schema, so they need not.',
    'Search Objects\' Reveal walks the grouped path while the option is on.',
    '',
    table(['Folder', 'Id', 'Shows below'], folderIds.filter(id => schemaPlacement(id) !== undefined).map(id => {
      const place = schemaPlacement(id)!
      const path: string[] = []
      for (let at: FolderId | undefined = id; at; at = folderSpecs[at].parent) path.unshift(folderSpecs[at].label)
      return [path.join(' › '), code(id), place === 'both' ? 'A schema row and the database' : place === 'schema' ? 'A schema row' : 'The database']
    })),
    '',
    `The folders that move are those below ${(schemaGroupRoots as readonly FolderId[]).map(id => folderSpecs[id].label).join(', ')}; every other database folder stays below the database.`,
    '',
    '## Object children',
    '',
    'Child folders list their rows by name, except Columns and Parameters, which keep the object\'s order, and an SSIS project\'s Packages,',
    'which list in deployment order (`package_id`: a package name can be longer than a sysname cursor key). Every other kind is a leaf.',
    '',
    table(['Kind', 'Subtypes', 'Children'], nodeKinds.filter(kind => kind !== 'server' && kind !== 'database').flatMap(kind => childRows(kindSpecs[kind]))),
    '',
    table(['Folder', 'Id', 'Below', 'Lists (query)'], folderIds.filter(id => folderSpecs[id].owner === 'object').map(id => [folderSpecs[id].label, code(id), codes(folderOwnerKinds(id)), lists(id)])),
    '',
    `## Node kinds (${nodeKinds.length})`,
    '',
    'Icons are ids of the [icon registry](icons.md): Varia\'s own stroke icons or codicons. Folders show `folder` (`folder-opened` while expanded).',
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
    `used verbatim (never trimmed), without U+0000; a kind may allow a longer name of its own, up to ${explorerLimits.maxName}, if it`,
    'owns no folders, history row or rows (those name their owner as a sysname, so the backend refuses such a catalogue).',
    'SSIS Catalog objects carry their folder (`ssisFolder`) and project (`ssisProject`) by name instead of a database.',
    '',
    table(['Scope', 'Requires', 'Forbids', 'Kinds'], kindScopes.map(scope => [code(scope), fields(scopeFields[scope].required), fields(scopeFields[scope].forbidden), fields(kindsOfScope(scope))])),
    '',
    table(['Child kind', 'Parent kinds'], childKinds.map((kind: NodeKind) => [code(kind), codes(childParentKinds(kind))])),
    '',
    '## Status badges',
    '',
    `A ${glyphSizes.badge.px} px badge (\`--varia-glyph-badge\`) at the bottom right of the row icon.`,
    'Disabled, unavailable and inaccessible nodes are dimmed as well; read-only databases are not, because their sublabel says it.',
    'The badge is red (`errorForeground`) for a disabled node and an error, amber (`warningForeground`) for `noAccess` (a database',
    'the current login cannot open, a login denied permission to connect), grey (`disabledForeground`) for an unavailable',
    'database and a lost server, and the icon\'s colour while loading. It sits on a disc of the row\'s own fill, hovered and',
    'selected included, so the icon under it does not show through.',
    '',
    table(['Status', 'Badge'], Object.entries(statusBadges).map(([status, badge]) => [code(status), code(badge)])),
    '',
    '## Login status',
    '',
    'Security › Logins reads catalog views only (`sys.server_principals`, `sys.server_permissions` and `sys.sql_logins`), never',
    '`LOGINPROPERTY`, which waits for another session\'s open `ALTER LOGIN` whatever the isolation level. A disabled login is',
    '`disabled`; otherwise one denied permission to connect (`DENY CONNECT SQL`) is `noAccess`. They keep apart, with their own',
    'badge and chip, because they are lifted apart: Enable leaves a denial in place. A login that is both keeps the `disabled`',
    'status and badge, and the listing also sends `connectDenied`, so its row shows both chips and says both, the denial first:',
    'a narrow pane shows only the first chip, and the badge already says Disabled. The chips are static, from the listing (no',
    'probe), and their words join the row\'s accessible name ("sa, Disabled"; "x, Permission to connect denied, Disabled");',
    'their sentences are the tooltip\'s state. Beside them the name stays whole up to 65 % of the row, and the chips give way',
    'first, each ending in an ellipsis, down to none. A row\'s subtype',
    'comes from `src/shared/actions/logins.ts`: `sa` by principal_id 1 whatever its name, `system` for SQL Server\'s own `##…##`',
    'logins, else by type. Its tooltip names its kind, then Disabled and Permission to connect denied (both when both apply),',
    `then "${loginDetailWords.policyChecked}" and "${loginDetailWords.expirationChecked}" for a SQL login whose policy flags are on.`,
    'Lock-out, expiry and must-change are not shown: only LOGINPROPERTY knows them.',
    'The live Logins listing checks (`LoginListingLiveChecks.cs`, with `VARIA_TEST_SQL_SCRATCH=1`) create a scratch login',
    '(`VariaScratch_…`), take it through disabled, denied permission to connect, both, and password policy and expiration',
    'enforced, and list it while another session holds an uncommitted `ALTER LOGIN … DISABLE` on it, then drop it;',
    '`--login-listing-live` runs only them.',
    '',
    table(['Type', 'Subtype', 'Kind in the tooltip'], (Object.keys(loginTypeSubtypes) as LoginType[]).map(type => [code(type), code(loginTypeSubtypes[type]), loginDetailWords.types[type]])),
    '',
    table(['Status', 'Chip', 'Tone', 'Words', 'Tooltip'], loginChipDocs.map(doc => [code(doc.status), doc.chip, doc.tone, doc.words, doc.title])),
    '',
    '## Live status',
    '',
    'While Object Explorer shows (and Environment › Live Data › Show live status in Object Explorer is on), each connected',
    'server has one background live view of the `explorer` source ([docs/live.md](live.md)) per login, shared by every',
    'connection to that server with that login, on one session of its own in master (so it never holds the database a',
    'connection opened in; a contained database user\'s, or one whose server profile the connect could not read, stays in the',
    'connection\'s database), paused while the pane or the window is hidden. Its samples become chips at the end of the rows',
    'below; they never reload the tree. While chips show, a database row\'s state comes from them rather than its sublabel',
    '(the state when the list loaded), and its tooltip says when the two differ. A probe that fails, is unavailable (no',
    'permission, or an edition without the feature) or has no sample yet shows nothing, and the row shows its sublabel again;',
    'so does a database past the 1,000 the probe lists, by name. A running-tone chip turns its glyph only while a restore or',
    'recovery reports progress. Refresh (F5) samples the view at once and opens again one that ended (a sign-in that',
    'failed). A window runs at most 8 such views and gives their slots to views the user opens, when the window\'s 16 are',
    'taken or the backend refuses one at its 8 a server ([docs/ipc.md](ipc.md#live-subscriptions)), so a server can be',
    'without chips until a slot frees. The chips are the only part of a row\'s end that gives way: the environment tag, item',
    'count and connection dot keep their size, and the label gives up the row\'s empty space first.',
    '',
    table(['Kind', 'Probes'], (Object.keys(statusChipKinds) as (keyof typeof statusChipKinds)[]).map(kind => [code(kind), codes(statusChipKinds[kind])])),
    '',
    table(['Node', 'Chip', 'Tone', 'When'], statusChipDocs.map(doc => [doc.kind, doc.chip, doc.tone, doc.when])),
    '',
    '## Peek',
    '',
    'Peek (the context menu\'s Peek, Space on the selected row, or resting the pointer on a row with Ctrl held, Cmd on macOS)',
    'opens a card beside the row with the object\'s definition and its properties. One `explorer.peek` request reads the',
    'properties (and a module\'s text) on the Object Explorer pool, in one constant batch per kind (`Explorer/PeekSql.cs`)',
    `within ${peekLimits.budgetMs.toLocaleString('en-US')} ms; a table's definition comes from Script As (CREATE). A fact whose`,
    'catalog column is newer than the server is left out. Esc, a click elsewhere or another peek closes the card, and',
    'cancels a read still running.',
    '',
    'Beside Definition, the card has tabs. **Columns** (tables and views) or **Parameters** (procedures and functions) lists the',
    `object's folder with \`explorer.children\`, as the tree does, up to ${peekLimits.members.toLocaleString('en-US')} rows. **Dependencies**`,
    '(`explorer.peekDependencies`) lists what the object references (`sys.sql_expression_dependencies`, other databases and',
    'linked servers included) and the tables its foreign keys point at, and what references it or points at it by a foreign key,',
    `at most ${peekLimits.dependencies} each way in name order. It is its own request because reading \`sys.sql_expression_dependencies\``,
    'takes more than VIEW DEFINITION (db_owner by default): a login refused it still sees the properties, and the tab says why. A',
    'reference SQL Server resolved to an object in this database shows without a server or database, however the code spelled',
    "them (the database in another case, or the local server's own name), so one made several ways lists once. A",
    'dependency in the same database of a kind Peek describes opens in the same card, beside the same row, and Back returns.',
    'Every tab but Definition is read the first time it is chosen, and again (or by Retry) when it is chosen after failing; the',
    'arrow keys move between tabs without choosing them, and Enter or Space chooses. **Top rows** (tables and views): `explorer.peekRows` runs',
    `\`SELECT TOP (${peekLimits.rows}) *\` on Peek's slot within its budget, through the one dynamic statement Object Explorer runs, built on`,
    "the server from `QUOTENAME` of the object's names (`Explorer/PeekRowsSql.cs`, held to its own lint). It reads READ UNCOMMITTED",
    'as the tree does, and only when SQL Server refuses that for a memory-optimized table (error 10794), directly or through a view,',
    'reads again under READ COMMITTED; `SET TEXTSIZE` has the server send only the start of a large text or binary value.',
    `Values show as the results grid shows them, read by its own readers, cut at ${peekLimits.rowCellChars} characters (one fewer`,
    'rather than split a surrogate pair) and ended with an ellipsis, whose tooltip says it was cut and that Select Top 1000 Rows',
    `shows more of it (a value the readers cannot read shows as NULL, as the grid shows it, with a note); the tab shows the first ${peekLimits.rowColumns} columns.`,
    `These few bounded values are decoded in the backend and answered as text, outside the result store and the results port.`,
    '',
    table(['Kind', 'Definition', 'Group', 'Facts'], peekKinds.flatMap(kind => peekSpecs[kind].groups.map(group => [code(kind), peekSpecs[kind].definition === 'module' ? 'sys.sql_modules' : 'Script As',
      group.title, group.facts.map(item => item.label + (item.since ? ` (band ${item.since}+)` : '')).join(', ')]))),
    '',
    '## Limits',
    '',
    table(['Limit', 'Value', 'Meaning'], (Object.keys(limitNotes) as (keyof typeof explorerLimits)[]).map(key => [code(key), explorerLimits[key].toLocaleString('en-US'), limitNotes[key]])),
    ''
  ].join('\n')
}
