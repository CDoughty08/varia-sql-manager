// Renders docs/object-explorer.md from the catalogue; tests/explorer-catalog.test.ts keeps the file in sync.
import {
  childParentKinds, explorerLimits, filterPropertyLabels, folderIds, folderOwnerKinds, folderServed, folderSpecs, kindScopes, kindSpecs, laterFolders, maxBand, nodeKinds, schemaGroupList,
  schemaGroupRoots, schemaPlacement, scopeFields, statusBadges, statusChipKinds, bigQueryStatusChipKinds, subfolders, folderGates, singletonOwners, type FolderId, type InsertStyle, type KindSpec, type LaterFolder, type NodeKind, type NodeSubtype
} from './catalog.ts'
import { loginChipDocs, statusChipDocs } from './status.ts'
import { peekKinds, peekLimits, peekLists, peekListsOf, peekSpecs, peekTabsOf, peekTabTitle } from './peek.ts'
import { dependencyKinds, dependencyLeafWords, dependencyLimits } from './dependencies.ts'
import { loginDetailWords, loginTypeSubtypes, type LoginType } from '../actions/logins.ts'
import { glyphSizes } from '../theme/metrics.ts'
import { languageLimits } from '../language-service.ts'

const cell = (value: string) => value.replaceAll('|', '\\|')
const row = (cells: readonly string[]) => '| ' + cells.map(cell).join(' | ') + ' |'
const table = (header: readonly string[], rows: readonly (readonly string[])[]) => [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n')
const code = (value: string) => '`' + value + '`'
const codes = (values: readonly string[]) => values.map(code).join(', ')
const versions: Readonly<Record<number, string>> = { 13: '2016', 14: '2017', 15: '2019', 16: '2022', 17: '2025' }
const since = (major?: number) => major === undefined ? '—' : `${versions[major] ?? major} (${major})`
const inserts: Readonly<Record<InsertStyle, string>> = { none: '—', onePart: '`[name]`', twoPart: '`[schema].[name]`', raw: 'the name as is (`@name`)', bqPath: "BigQuery's backtick-quoted path (`` `project.dataset.table` ``)" }
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
type Entry = { readonly label: string; readonly order: number; readonly id?: FolderId; readonly later?: LaterFolder; readonly singleton?: NodeKind }
/** A folder's (or an owner's top-level) served and planned subfolders, in SSMS order. */
function entries(owner: 'server' | 'database', parent?: FolderId): Entry[] {
  const served = (parent ? subfolders(parent) : folderIds.filter(id => !folderSpecs[id].parent && folderSpecs[id].owner === owner)).map(id => ({ label: folderSpecs[id].label, order: folderSpecs[id].order, id }))
  const later = laterFolders.filter(folder => folder.owner === owner && folder.parent === parent).map(folder => ({ label: folder.label, order: folder.order, later: folder }))
  const singletons = parent ? [] : (kindSpecs[owner].singletons ?? []).map(item => ({ label: kindSpecs[item.kind].title, order: item.order, singleton: item.kind }))
  return [...served, ...later, ...singletons].sort((a, b) => a.order - b.order)
}
function folderRows(owner: 'server' | 'database', parent?: FolderId, path = ''): string[][] {
  return entries(owner, parent).flatMap(entry => {
    const name = path + entry.label
    if (entry.later) {
      const contents = entry.later.contents ? `Planned: ${entry.later.contents.join(', ')}` : 'Planned'
      return [[name, '—', since(entry.later.since), '—', contents, '—']]
    }
    if (entry.singleton) {
      const spec = kindSpecs[entry.singleton]
      return [[name, `${code(spec.kind)} node`, '—', 'No', `Its own node; ${platforms(spec.platforms)}`, '—']]
    }
    const spec = folderSpecs[entry.id!]
    const filters = spec.filter?.map(property => filterPropertyLabels[property]).join(', ') || '—'
    return [[name, code(spec.id), since(spec.since), folderServed(spec.id, { band: maxBand, engine: 'cloud', edition: 5, linux: false }) ? 'Yes' : 'No', lists(spec.id), filters], ...folderRows(owner, spec.id, name + ' › ')]
  })
}
/** A folder below a gated node is served only where both its own gate and its owner's are (Jobs has none of its own). */
const served = (gate: readonly string[] | undefined, owner: readonly string[] | undefined) =>
  gate && owner ? gate.filter(platform => owner.includes(platform)) : gate ?? owner
/** Where a `platforms` gate serves: every server, or the SQL Server Agent platforms it lists. */
const platforms = (gate: readonly string[] | undefined) => gate ? `SQL Server Agent platforms ${codes(gate)}` : 'every server'
const folderTable = (owner: 'server' | 'database') => table(['Folder', 'Id', 'Since', 'Cloud editions', 'Lists (query)', 'Filters'], folderRows(owner))

/** A kind's static folders and singletons in SSMS order, then the rows it lists itself (`KindSpec.list`). */
const childLabels = (spec: KindSpec, folders: readonly FolderId[]) => {
  const statics = [...folders.map(id => ({ label: folderSpecs[id].label, order: folderSpecs[id].order })), ...(spec.singletons ?? []).map(item => ({ label: kindSpecs[item.kind].title + ' (its own node)', order: item.order }))]
    .sort((a, b) => a.order - b.order).map(item => item.label).join(', ')
  const rows = spec.list ? `${(spec.rows ?? []).map(kind => kindSpecs[kind].title).join(', ')} rows (${code(spec.list)})` : undefined
  return [statics, rows].filter(Boolean).join(', then ')
}
function childRows(spec: KindSpec): string[][] {
  if (!spec.folders.length && !spec.subtypeFolders && !spec.list && !spec.singletons) return []
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
    'A server with no saved expansion (first connected this run, or never shown connected before) expands on connect; its folders',
    'stay collapsed. Otherwise a connect restores the nodes it last showed expanded: at Varia\'s last close, or when it was lost',
    'or disconnected (collapsed if it showed none, or if the session file predates this).',
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
    '## SQL Server Agent',
    '',
    'The server\'s SQL Server Agent node is its own node (a singleton: its ref names only its kind), after the server\'s folders, on the',
    'servers Agent runs on (docs/sql-server-agent.md); BigQuery connections have none. Its',
    'children follow SSMS: Jobs, Job Activity Monitor (a leaf; double-clicking it opens Job Activity Monitor), Alerts, Operators, Proxies (a row per',
    'subsystem, then Unassigned Proxies) and Error Logs. Which of them a login sees depends on its Agent role, read when the node',
    'expands: sysadmin sees all; SQLAgentOperatorRole Jobs, Job Activity Monitor, Alerts and Operators; SQLAgentReaderRole and',
    'SQLAgentUserRole Jobs and Job Activity Monitor (a User sees only its own jobs, as msdb' + "'" + 's sysjobs_view filters them). Proxies and Error',
    'Logs are sysadmin' + "'" + 's alone: msdb lets no Agent role read the proxy tables, and the error logs come from xp_enumerrorlogs. A',
    'login in none of the roles gets PERMISSION_DENIED naming them; with Agent stopped or Agent XPs off the node lists nothing and',
    'says why (AGENT_DISABLED). The node' + "'" + 's chips say the Agent service' + "'" + 's state when it is not running and the jobs running, and its',
    'sublabel says Agent XPs disabled while that option is 0 (Live status). Where xp_enumerrorlogs returns no list (SQL Server on',
    'Linux), Error Logs lists Current alone. Search Objects finds the jobs the login may read, operators and, where the Alerts folder',
    'is served, alerts; Ctrl+Q reveals them below the node. Copy Name copies',
    'a job, alert, operator or proxy name unquoted, as the msdb procedures take it. The platform gates come from the Agent catalogue:',
    '',
    table(['Node', 'Id', 'Served on'], [
      ...nodeKinds.filter(kind => singletonOwners(kind).length).map(kind => [kindSpecs[kind].title, `${code(kind)} node`, platforms(kindSpecs[kind].platforms)]),
      ...folderIds.filter(id => folderOwnerKinds(id).includes('agent')).map(id => [folderSpecs[id].label, code(id), platforms(served(folderGates(id).platforms, kindSpecs.agent.platforms))])
    ]),
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
    'BigQuery objects carry their `project`, `dataset` and (for a column) `table`, and keep to BigQuery\'s own name rules and',
    'lengths (`src/shared/bigquery/names.ts`) instead, a column\'s name being its dot-joined field path; no sysname names them.',
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
    'A connected BigQuery connection has its own background view, of the `bigquery.explorer` source, under the same rules: its',
    'node\'s chip counts the principal\'s own pending and running jobs in the billing project, from jobs.list (a free API call,',
    'never a query). Its datasets have no runtime state, so they show no chips ([docs/bigquery.md](bigquery.md#object-explorer)).',
    '',
    table(['Kind', 'Probes'], [...(Object.keys(statusChipKinds) as (keyof typeof statusChipKinds)[]).map(kind => [code(kind), codes(statusChipKinds[kind])]),
      ...(Object.keys(bigQueryStatusChipKinds) as (keyof typeof bigQueryStatusChipKinds)[]).map(kind => [code(kind) + ' (BigQuery)', codes(bigQueryStatusChipKinds[kind])])]),
    '',
    table(['Node', 'Chip', 'Tone', 'When'], statusChipDocs.map(doc => [doc.kind, doc.chip, doc.tone, doc.when])),
    '',
    '## Peek',
    '',
    'Peek (the context menu\'s Peek, Space on the selected row, or resting the pointer on a row with Ctrl held, Cmd on macOS)',
    'opens a card beside the row with the object\'s definition and its properties. One `explorer.peek` request reads the',
    'properties (and a module\'s text) on the Object Explorer pool, in one constant batch per kind (`Explorer/PeekSql.cs`)',
    `within ${peekLimits.budgetMs.toLocaleString('en-US')} ms; the definition of a kind without stored text comes from Script As (CREATE). A fact whose`,
    'catalog column is newer than the server is left out. While Peek on Hover\'s modifier (Ctrl, Cmd on macOS, unless remapped) is',
    `held, rows that can peek show a zoom-in cursor. Pressing it with the pointer already on such a row peeks after ${peekLimits.pressMs} ms (a`,
    'shortcut such as Ctrl+N reaches its second key first, so it peeks nothing); a key typed since the pointer last moved means',
    'the pointer is only resting there, so the press peeks nothing until it moves. Releasing it keeps an open card, so the pointer',
    'can move into it.',
    'Esc (in the card, the tree, or a query editor that kept focus while a row was hovered), a click elsewhere or another peek',
    'closes the card, and',
    'cancels a read still running. Both the floating Peek Card (`surface="peek"`) and a promoted Peek Tab (`surface="full"`)',
    'share the unified `ObjectInspectorFrame` shell with canonical tab order (`Overview`, `Definition`, `Storage & Layout` for',
    'tables or `Usage Telemetry` for indexes, the kind\'s lists, `Dependencies`, and `Top rows`), horizontal tab overflow',
    'controls, and focus-scoped `Ctrl+1`–`9` (`⌘1`–`9` on macOS, `9` = last tab) tab switching (numeric badges stay visible on',
    'Peek Card and appear on modifier hold in Peek Tab). **Overview** shows identity facts in `FactGrid` (with click-to-copy',
    'and clickable cross-object links such as parent table, referenced table and login default database pushing onto Peek\'s Back',
    'stack) and signal-first `CapabilityChips`. For SQL Server **Foreign Keys**, Overview leads with a visual **Foreign Key',
    'Relationship** diagram (`parent.table (cols) → referenced.table (cols)`) with clickable jump-links to both tables,',
    'referential action pills (`ON DELETE` / `ON UPDATE`), and Enabled/Trusted pills; **Primary Keys** and **Unique',
    'Constraints** show a **Key Summary** block with clustered/nonclustered pills and ordered column badges; **Constraints**',
    '(`CHECK`, `DEFAULT`, `EDGE`) show a copyable **Expression** block, target column, Enabled/Trusted/System-named capability',
    'chips, and expression fallback on **Definition** when no script is available. **Storage & Layout** (tables) shows a Data vs. Index space `RatioBar` and storage',
    'facts; **Usage Telemetry** (indexes) shows a Seeks/Scans vs. Updates `RatioBar` and usage facts. The collapsible, resizable',
    'right **Vitals** rail shows compact key facts, flat meters and notable flags, remembers width and open state separately for',
    'Peek Card and Full Tab, and hides below 680 px container width instead of stacking a second vertical scroller. Fact text can',
    'be selected, and the pane\'s menu **Copy** puts the selected facts, or all of them when none is selected, on the clipboard as',
    '`Name<TAB>Value` lines.',
    '',
    'Database-scoped kinds are read in their database, as the tree reads them; a database, a login and a server trigger on the',
    'server (sys.databases and sys.master_files, so an offline or restoring database still peeks). An index or a trigger is found',
    'below its table or view (or table type for an index); a key or a constraint below its table or table type. Some kinds have lists, read in the same batch as their facts and shown on tabs of their own, at most',
    `${peekLimits.listRows.toLocaleString('en-US')} rows each: a table's, view's or table type's columns, a table's indexes, keys, constraints and triggers, a procedure's or function's parameters, an index's`,
    "key and included columns, a key's columns, a trigger's events, a database's files, a login's server roles,",
    `and its user mapping, read after the batch in each database the login may enter (at most ${peekLimits.mappingDatabases}, in name order), through`,
    '`QUOTENAME` as every database statement is, on the same connection; a database it cannot read is counted, not shown. Nothing',
    'reads LOGINPROPERTY or a password hash. An index\'s usage comes from `sys.dm_db_index_usage_stats` in a statement of its own,',
    'last in the batch, inside TRY…CATCH: a login without VIEW SERVER STATE gets the other facts and the card says why usage is missing.',
    'Each list shows in the results grid as a local table filling its tab pane edge-to-edge: cells, rows and columns select,',
    'Ctrl+C and Copy with Headers copy as a result\'s cells do, and columns sort and resize; in a Peek tab Save Results As saves it.',
    '',
    'A column\'s row shows its name, type (as the tree writes it), nullability, key (PK, FK), identity seed and increment, computed',
    'expression and default, and **Definition**, its declaration as T-SQL built by the backend: the name through `QUOTENAME`, the',
    'type as Script As writes it (sizes, `max`, a user type schema-qualified), `COLLATE` only where it is not the database\'s,',
    '`FILESTREAM`, `SPARSE`, `MASKED WITH (FUNCTION = ...)`, `IDENTITY(seed,increment)` (with `NOT FOR REPLICATION`), a period column\'s `GENERATED ALWAYS AS ROW START` (or `END`)',
    'and a ledger column\'s `GENERATED ALWAYS AS TRANSACTION_ID` or `SEQUENCE_NUMBER` `START` (or `END`), with `HIDDEN`, `ROWGUIDCOL`,',
    '`NULL` or `NOT NULL`, and `DEFAULT (expression)` without the constraint\'s name; a computed column reads `AS (expression)`, with',
    '`PERSISTED`. A parameter\'s reads `@OrderId int = 0 OUTPUT` (`READONLY` for a table type, `NOT NULL` for a natively compiled module\'s; a T-SQL module\'s defaults come from',
    'its header, so an encrypted one shows none). Copying the Definition column gives a table\'s column lines for a `CREATE TABLE`, and',
    'a module\'s parameter lines for a `CREATE PROCEDURE` or `CREATE FUNCTION` header. Constraints (keys, checks), Always Encrypted\'s',
    '`ENCRYPTED WITH` and a vector\'s base type other than the default are left to Script As.',
    '',
    'A table\'s **Indexes & Keys** list shows each key, index, constraint and trigger with its kind, name, status and **Summary**: a key\'s',
    'or index\'s type and columns, a foreign key\'s columns and referenced table, a check\'s or default\'s expression, a trigger\'s',
    'timing and events. Names are bracketed as scripts write them (`[Order]]Id]`). A summary is a description, not T-SQL to paste;',
    'Script As writes that. The columns, foreign-key pairs and trigger events behind the summaries are read up to a fixed number of rows;',
    'when a table has more, the summaries the cap reached partway or not at all end in `…`, and the cut removes no row from the list.',
    '',
    table(['List', 'Kinds', 'Columns'], (Object.keys(peekLists) as (keyof typeof peekLists)[]).map(id => [peekLists[id].title,
      codes(peekKinds.filter(kind => peekListsOf(kind).includes(id))), peekLists[id].columns.map(column => column.label).join(', ')])),
    '',
    '**Definition** shows the text in the query editor itself (`createQueryEditor`, read-only), so Tools › Options, the theme',
    "and Find reach it as they reach a query, and so will editor features added later. Each card or tab has one editor, and each",
    "definition a model of its own carrying the view's connection and database and its own UUID (`peekModelContext`), disposed",
    'as soon as the view shows another object, goes Back or refreshes; closing the card or tab disposes the editor. SQL language',
    "features serve that model as they serve a query's: hovering a name shows what IntelliSense knows of it in the view's",
    'database. Completion and analysis markers stay off, since the text is read-only, and disposing the model closes its',
    `language document. As for a query, a definition longer than ${languageLimits.documentCharacters.toLocaleString('en-US')} characters gets no hover.`,
    'Its focus key is `peekEditorFocus`, never `editorFocus`, so query',
    'commands (Execute, Parse and the rest) leave it alone, and F5 refreshes the Peek; Find, Copy and Select All are Monaco\'s',
    "own. **Script to New Query** and, for a kind that offers it, **Modify** open the definition in a query tab through Script As.",
    `A definition is never cut. A module's text comes in pages of ${peekLimits.definitionPageChars.toLocaleString('en-US')} characters: the first with the`,
    'properties, the rest one page at a time (`explorer.peekDefinition`), and the tab shows the text once it has all of it. If the',
    'module changes between pages, the tab says so and Refresh reads it again. While the pages come, the tab says how much has',
    'come. Closing the card cancels the page still being read.',
    `Only a text longer than ${peekLimits.definitionMaxChars.toLocaleString('en-US')} characters, the most Peek holds in memory, is not read:`,
    'the tab says so rather than showing part of it.',
    '',
    'Beside Definition, the card has tabs: the kind\'s lists (above; **Columns** for tables, views and table types, **Parameters**',
    'for procedures and functions), which come with the properties, and **Dependencies**',
    '(`explorer.peekDependencies`) lists what the object references (`sys.sql_expression_dependencies`, other databases and',
    'linked servers included) and the tables its foreign keys point at, and what references it or points at it by a foreign key,',
    `at most ${peekLimits.dependencies} each way in name order. It is its own request because reading \`sys.sql_expression_dependencies\``,
    'takes more than VIEW DEFINITION (db_owner by default): a login refused it still sees the properties, and the tab says why. A',
    'reference SQL Server resolved to an object in this database shows without a server or database, however the code spelled',
    "them (the database in another case, or the local server's own name), so one made several ways lists once. A",
    'dependency in the same database of a kind Peek describes opens in the same card, beside the same row, and Back returns.',
    'View Dependencies (below) follows the same listings level by level.',
    'Dependencies and Top rows are read the first time they are chosen, and again (or by Retry) when chosen after failing; the',
    'arrow keys move between tabs without choosing them, and Enter or Space chooses. **Top rows** (tables and views) runs Select',
    `Top N Rows' own script with N = ${peekLimits.rows} (the columns from \`tables.columns\`, as Select Top 1000 Rows lists them) through`,
    '`query.execute`, as a query tab runs it, and shows the rows in the results grid, where selection, Copy, Save Results As and',
    "Open Value work as in a query's results. The run has a session of its own, which closes as soon as the run ends (the backend",
    'keeps its results until they are released), and a results entry of its own, which is released when the card or tab closes,',
    'shows another object or refreshes, and when the server or the backend is lost.',
    '',
    "Open Peek as Tab (the card's button, Ctrl+Enter in the card or the tree, or Ctrl+click on a row, Cmd on macOS) shows the",
    'same unified inspector in a document tab (`surface="full"`) with breadcrumbs, a Hero KPI strip, Back, Refresh, Script As…',
    'and, for a kind that has one, the Properties verb. Promoting a SQL Server table opens or focuses its unified Table',
    'Properties document on the matching tab. BigQuery tables, views, materialized views, external tables, routines and datasets',
    'also open in the floating Peek Card from free `bigquery.properties` metadata (zero billed queries on open; lazy free',
    '`tabledata.list` Preview Rows; on-demand native-table DDL with cost prompts), and **Open as Tab** opens or focuses the',
    'unified BigQuery Properties tab on the matching canonical tab (`docs/bigquery.md`). A tab owns its reads and its Top rows',
    'run as the card does; closing it releases them.',
    '',
    table(['Kind', 'Definition', 'Tabs'], peekKinds.map(kind => [code(kind),
      peekSpecs[kind].definition === 'script' ? 'Script As' : kind === 'serverTrigger' ? 'sys.server_sql_modules' : 'sys.sql_modules',
      peekTabsOf(kind).map(tab => peekTabTitle(kind, tab)).join(', ')])),
    '',
    table(['Kind', 'Group', 'Facts'], peekKinds.flatMap(kind => peekSpecs[kind].groups.map(group => [code(kind),
      group.title + (group.subtypes ? ` (${group.subtypes.join(', ')})` : '') + (group.refused ? ' (may be refused)' : ''),
      group.facts.map(item => item.label + (item.since ? ` (band ${item.since}+)` : '')).join(', ')]))),
    '',
    '## View Dependencies',
    '',
    "SSMS's View Dependencies, on the context menu of the kinds whose Peek has a Dependencies tab, opens the Object Dependencies",
    'dialog. Its two choices list the objects that depend on the object, or the objects it depends on, as a tree whose root is the',
    "object. Each level is one of the Dependencies tab's listings, the same SQL (`explorer.dependencies`, one direction per request,",
    "on Peek's slot and budget), read the first time its node is expanded and never before; a failed level says why and offers",
    `Retry. A level lists at most ${dependencyLimits.perLevel.toLocaleString('en-US')} objects in name order, the tree at most`,
    `${dependencyLimits.nodes.toLocaleString('en-US')} in all, and a level cut by either says so. A node is a leaf, and says why, when`,
    'it is on a linked server or in another database (named, never read), unresolved, of a kind the tree cannot read (a constraint),',
    `${dependencyLimits.depth} levels down, or already above it on its branch: a cycle is marked rather than followed. A table's or view's own DML`,
    "triggers depend on it, and each depends on it, as SSMS lists them, though the server records no reference for a trigger's ON clause. Below the tree the selected node shows",
    'its name, type and dependency type (foreign key, schema-bound or non-schema-bound). Enter, a double-click or Show in Object',
    "Explorer selects the node in the tree (walking and paging to it as Search Objects' Reveal does) and closes the dialog; Peek",
    "opens the node's Peek tab. A trigger is named below its table or view, so it can be read, selected and peeked too.",
    '',
    'While the server is disconnecting, pending reads are cancelled and new reads, Peek and Show in Object Explorer pause;',
    'the loaded tree and selection stay visible. If that same connection remains connected after teardown is cancelled or',
    'fails, explicit expansion and Retry become available again without automatically reading anything. A lost or replaced',
    'connection leaves the tree read-only; reconnect and open View Dependencies again.',
    '',
    table(['Kinds', 'Leaf reasons'], [[dependencyKinds.map(code).join(', '), Object.values(dependencyLeafWords).join('; ')]]),
    '',
    '## Limits',
    '',
    table(['Limit', 'Value', 'Meaning'], (Object.keys(limitNotes) as (keyof typeof explorerLimits)[]).map(key => [code(key), explorerLimits[key].toLocaleString('en-US'), limitNotes[key]])),
    ''
  ].join('\n')
}
