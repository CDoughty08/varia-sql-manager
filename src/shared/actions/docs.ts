// Renders docs/object-actions.md from the actions catalogue; tests/object-actions-catalog.test.ts keeps the file in sync.
import { kindSpecs, nodeKinds, serverEngines, type NodeSubtype } from '../explorer/catalog.ts'
import { longRunKinds, longRunLimits, longRunSubjects } from '../long-runs.ts'
import {
  actionCommandEntries, actionContextKey, actionErrorCodes, actionErrorRetryable, actionKindSpecs, actionLimits, actionMenus, actionRow, actionStatuses, databaseActionRules, databaseStateIds,
  dialogIds, dialogSpecs, objectActions, objectActionSpecs, scriptActionTitles, unknownOutcomeMessage
} from './catalog.ts'
import { actionPromptBox, actionPrompts, promptLimits, type ActionPromptRequest } from './prompts.ts'
import { compatibilityLabel, compatibilityLevels, databaseOptionDefs, noScriptNotice, openConnectionsPrompt, ownerNotOn, scopedConfigurationDefs, type DatabaseOptionDef } from './database.ts'

const cell = (value: string) => value.replaceAll('|', '\\|')
const row = (cells: readonly string[]) => '| ' + cells.map(cell).join(' | ') + ' |'
const table = (header: readonly string[], rows: readonly (readonly string[])[]) => [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n')
const code = (value: string) => '`' + value + '`'
const yesNo = (value: boolean) => value ? 'Yes' : 'No'
const mark = (state: string | undefined) => state === 'enabled' ? '✓' : state === 'disabled' ? '○' : '–'
const limitNotes: Readonly<Record<keyof typeof actionLimits, string>> = {
  describeMs: 'The backend\'s budget for reading what a dialog shows, in ms; then `TIMEOUT`',
  scriptMs: 'The backend\'s budget for building a script, in ms; then `TIMEOUT`',
  readLockTimeoutMs: '`LOCK_TIMEOUT` while reading for a dialog or a script, in ms; then `BLOCKED`. DDL itself waits without one',
  gateWaitMs: 'How long a request waits for its gate before the backend answers `BUSY`, in ms',
  readPerConnection: 'Describe and script requests at once per server',
  readTotal: 'Describe and script requests at once in total',
  executePerConnection: 'Actions running at once per server',
  executeTotal: 'Actions running at once in total',
  registered: 'Requests the backend tracks; more fail with `BUSY`',
  cancelIds: 'Request ids per cancellation',
  tombstones: 'Cancelled request ids remembered for requests that have not arrived yet',
  tombstoneMs: 'How long a cancelled request id is remembered, in ms',
  dependents: 'Dependents listed per kind of dependent; more set `dependentsTruncated`',
  messageChars: 'Characters in an error message',
  infoMessages: 'Informational messages an action returns',
  infoMessageChars: 'Characters in an informational message',
  scriptChars: 'Characters in a script: main\'s limit for a query, so a script sent to a new query window can run there',
  newName: 'UTF-16 code units in a new name (used verbatim, never trimmed)',
  files: 'Files Database Properties lists; more make the Files page say so',
  filegroups: 'Filegroups Database Properties lists; more make the Filegroups page say so',
  logins: 'Logins the Owner field suggests',
  collations: 'Collations the Collation list offers',
  statements: 'Statements one Database Properties request may plan',
  stopGraceMs: 'How long a stopped action waits for SQL Server to end its statement before it answers `CANCELLED` with an unknown outcome, in ms',
  statusDelayMs: 'How long a state action (a rename, a login\'s Disable or Enable) runs before the status bar shows it with Stop, in ms'
}

// As src/shared/commands/menus.ts titles them (that module needs a bundler; this one loads in plain Node).
const submenuTitles = { 'explorer.tasks': 'Tasks', 'explorer.tasks.restore': 'Tasks › Restore' } as const
/** Menus, statuses, database states and servers: what narrows an action beyond its kind and subtype. */
function narrowingDocs(): string[] {
  const overlays = nodeKinds.flatMap(kind => actionStatuses(kind).map(status => {
    const overlay = actionKindSpecs[kind]?.statuses?.[status] ?? {}
    return [code(kind), code(status), objectActions.filter(action => action in overlay).map(action => `${objectActionSpecs[action].title}: ${mark(overlay[action] || undefined)}`).join(', ')]
  }))
  return [
    '## Menus, statuses, database states and servers',
    '',
    `An action's item goes in ${actionMenus.map(menu => code(menu)).join(', ')}: Object Explorer's menu, or its Tasks submenus. ` +
      actionMenus.filter(menu => menu !== 'explorer.context').map(menu => `${submenuTitles[menu as Exclude<typeof menu, 'explorer.context'>]} (${code(menu)})`).join(' and ') +
      ' stay hidden while nothing is placed in them, so they appear with their first action.',
    '',
    'A node\'s status badge (`explorerNodeStatus`) can overlay its row: a disabled login offers Enable in place of Disable.',
    overlays.length ? table(['Kind', 'Status', 'Changes'], overlays) : 'No kind changes its actions by status yet.',
    '',
    `A database row carries its runtime state as listed (state, user access, read-only, standby); a newer live status sample wins.`,
    `Rules narrow a database's actions by it, each with the reason a greyed item shows. The states: ${Object.values(databaseStateIds).map(code).join(', ')}, \`other\`.`,
    databaseActionRules.length
      ? table(['Action', 'States', 'Access', 'Read-only', 'Effect', 'Reason'], databaseActionRules.map(rule => [objectActionSpecs[rule.action].title, rule.states?.join(', ') ?? 'Any', rule.access?.join(', ') ?? 'Any',
        rule.readOnly === undefined ? 'Any' : yesNo(rule.readOnly), rule.hide ? 'Hidden' : 'Greyed', rule.reason]))
      : 'No rule narrows a database\'s actions yet.',
    '',
    `An action can name the servers that offer it (${serverEngines.map(code).join(', ')}: an on-premises SQL Server or a container, Azure SQL Managed Instance, Azure SQL Database);`,
    'the Servers column above says which. Menus read the server through `explorerServerEngine` and `explorerServerLinux`.',
    ''
  ]
}

const promptSamples: { readonly [P in ActionPromptRequest['prompt']]: Extract<ActionPromptRequest, { prompt: P }>['facts'] } = {
  renameDatabase: { database: 'Sales', sessions: 3, transactions: 1, tabs: 2, tabsWithTransactions: ['Query 1.sql'], canClose: true },
  disableLogin: { login: 'app_user', sessions: 2, service: 'SQL Server Agent (MSSQLSERVER)', sysadmin: false }
}
/** The native confirmations, with an example of each. */
function promptDocs(): string[] {
  return [
    '## Confirmations',
    '',
    'An action that asks first (A13) sends main a prompt id and bounded facts (`varia:confirm-action`); main checks them',
    `(names up to ${promptLimits.name} characters, counts up to ${promptLimits.count.toLocaleString('en-US')}, at most ${promptLimits.tabs} query window names, no unknown members), writes`,
    'the message box from `src/shared/actions/prompts.ts` with names shown through `displayText`, and answers with the',
    'chosen button\'s id; Escape, a closed box or a page that went away answers Cancel. The page can neither word a prompt nor',
    'choose its default. Database Properties\' Open Connections prompt keeps its own channel.',
    '',
    table(['Prompt', 'Title', 'Buttons', 'Example'], (Object.keys(actionPrompts) as ActionPromptRequest['prompt'][]).map(prompt => {
      const box = actionPromptBox({ prompt, facts: promptSamples[prompt] } as ActionPromptRequest)
      return [code(prompt), box.title, box.buttons.map((label, index) => index === box.defaultId ? `**${label}**` : label).join(', '), [box.message, box.detail].join(' ').replaceAll('\n\n', ' ')]
    })),
    '',
    'The default button is bold. Rename Database defaults to Rename When Free where Varia may not close the connections, and',
    'Disable Login to Cancel for a login a service runs as.',
    ''
  ]
}

/** The long-run registry. */
function longRunDocs(): string[] {
  return [
    '## Long runs',
    '',
    'An action that changes a server for seconds or hours registers as a long run (`LongRunService`) while it runs. Until it',
    'ends, closing the window is refused with a banner naming it and its server, Disconnect of its server and Restart SQL',
    'Backend are refused with "<Run> is running on <server>. Stop it first.", and main\'s reload prompt names it first',
    `(the page reports at most ${longRunLimits.runs} runs, server names up to ${longRunLimits.server} characters, and counts the rest; \`varia:long-runs\`).`,
    'A run shown in a modal dialog (Create Catalog) repeats a refused close or Restart in that dialog, which covers the banner.',
    'While the backend does not answer, the run cannot be stopped either, so Restart SQL Backend goes on to main\'s prompt,',
    'which names the run it would stop part way.',
    'A long run never holds the document task, so nothing waits for it silently; main\'s drain of a stopping backend stays the',
    'last resort.',
    '',
    table(['Kind', 'Named as'], longRunKinds.map(kind => [code(kind), longRunSubjects[kind]])),
    '',
    'Create Catalog is the only long run so far; the others are reserved for the actions that will use them.',
    '',
    'A short state action (a rename; later a login\'s Disable and Enable) runs as a status-bar job instead: one per node,',
    'shown with Stop after `statusDelayMs`, naming its step when it has several ("Renaming Sales to Sales2: Closing',
    'connections…").',
    ''
  ]
}

/** One line per kind and run of subtypes that act alike. */
function kindRows(): string[][] {
  return nodeKinds.flatMap(kind => {
    if (!actionKindSpecs[kind]) return []
    const groups = new Map<string, string[]>()
    for (const subtype of [undefined, ...kindSpecs[kind].subtypes ?? []] as (NodeSubtype | undefined)[]) {
      const states = objectActions.map(action => mark(actionRow(kind, subtype)?.[action])).join('\n')
      groups.set(states, [...groups.get(states) ?? [], subtype ? code(subtype) : 'none'])
    }
    return [...groups].map(([states, subtypes]) => [code(kind), subtypes.join(', '), ...states.split('\n')])
  })
}

export function renderObjectActionsDocs(): string {
  const commands = actionCommandEntries()
  // Keys as menus show them; the catalogue's specs are single chords of these keys.
  const names: Readonly<Record<string, string>> = { f2: 'F2', delete: 'Delete', 'mod+backspace': '⌘⌫', 'meta+i': '⌘I' }
  const keys = (action: typeof objectActions[number], mac: boolean) => {
    const bindings = commands[objectActionSpecs[action].command].keybindings ?? []
    return bindings.flatMap(binding => { const spec = mac ? binding.mac ?? binding.key : binding.win ?? binding.key; return spec ? [names[spec] ?? spec] : [] }).join(', ') || '—'
  }
  return [
    '# Object actions',
    '',
    '<!-- Generated from src/shared/actions/catalog.ts. Regenerate with: npx vitest run tests/object-actions-catalog.test.ts -u -->',
    '',
    'Object Explorer\'s actions on objects: Select Top 1000 Rows, Rename, Delete and Properties. Which kinds and subtypes offer each is',
    'data in `src/shared/actions/catalog.ts`; the backend embeds the same data as `backend/Varia.Backend/Actions/actions-catalog.json`',
    'and re-derives the subtype in the action\'s own connection before any DDL runs.',
    '',
    '## Actions',
    '',
    table(['Action', 'Menu title', 'Command', 'Kind', 'Menu', 'Group', 'Mnemonic', 'Windows and Linux', 'macOS', 'Servers', 'Context key'], objectActions.map(action => {
      const spec: (typeof objectActionSpecs)[typeof action] & { readonly menuTitle?: string; readonly menu?: string; readonly engines?: readonly string[] } = objectActionSpecs[action]
      return [code(action), spec.menuTitle ?? spec.title, code(spec.command), spec.class + (spec.dialog ? ` (${code(spec.dialog)})` : ''), code(spec.menu ?? 'explorer.context'), `${code(spec.group)} ${spec.order}`, spec.mnemonic,
        keys(action, false), keys(action, true), spec.engines?.join(', ') ?? 'All', code(actionContextKey(action))]
    })),
    '',
    'Keys work while Object Explorer has focus and no text field does. Delete\'s access key is E: Disconnect has SSMS\'s D in',
    'Varia\'s one Object Explorer menu.',
    'Select Top 1000 Rows follows Tools › Options › SQL Server Object Explorer › Commands (Select Top <n> Rows).',
    'Properties is the last item, after Refresh, and is offered on SQL Server\'s own databases too, as in SSMS. SSMS 22\'s',
    'access key and shortcut for it are unverified: Varia uses P, and ⌘I (Finder\'s Get Info) on macOS only, because Alt+Enter',
    'is reserved on Windows and Linux.',
    '',
    '## Object kinds',
    '',
    '✓ enabled, ○ shown greyed, – not offered.',
    '',
    table(['Kind', 'Subtypes', ...objectActions.map(action => objectActionSpecs[action].title)], kindRows()),
    '',
    ...narrowingDocs(),
    '## Dialogs',
    '',
    table(['Dialog', 'Title', 'Opens as', 'Action', 'Pages', 'Steps panel'], dialogIds.map(dialog => {
      const spec: (typeof dialogSpecs)[typeof dialog] & { readonly steps?: true } = dialogSpecs[dialog]
      return [code(dialog), spec.title + (spec.titleFormat === 'withName' ? ' - <name>' : ''), spec.surface === 'modal' ? 'Modal dialog' : 'Document tab', code(spec.action),
        spec.pages.map(page => `${page.title} (${code(page.icon)}${page.keepMounted ? ', kept mounted' : ''})`).join(', '), yesNo(!!spec.steps)]
    })),
    '',
    'A modal dialog is for a confirmation (Delete Object). A property sheet opens as a document tab instead (U1 D2): its',
    'pages are sections in one scrolling column with a section list beside it, and a Script drawer under it.',
    '',
    'A modal dialog with more than one page lists them beside the page (SSMS\'s "Select a page"); where the dialog is narrower',
    'than 720 px (a viewport under 768 CSS px, as when zoomed in: the window is at least 1024 px wide) the list becomes a row of tabs above the page (a `tablist` named "Select a page", arrow keys, Home and End). A',
    'page marked kept mounted stays in the page once visited, hidden while another shows, so what it holds (a running list,',
    'a typed value) survives switching away. A dialog with a steps panel shows its plan as a list of steps, scrolling in at most 40 % of the column',
    '(`kit/StepList.tsx`, Create Catalog\'s too), each pending, running, done, failed, cancelled or skipped, with an optional',
    'progress bar under a running step.',
    '',
    `In a modal dialog, the Script button scripts to a new query window; its arrow lists ${Object.values(scriptActionTitles).join(', ')}. Script never runs anything.`,
    'OK runs the action; Cancel reads Stop while it runs, and Stop cancels the statement in SQL Server.',
    '',
    'Delete Object for a database also offers "Delete backup and restore history information for databases" (checked,',
    'greyed for a snapshot) and "Close existing connections" (unchecked), as SSMS does. OK in the dialog is the only',
    'confirmation.',
    '',
    'The Table Designer (New › Table…) uses the same requests without being a dialog: `actions.describe` with',
    '`tableDesigner` and a database, and the `createTable` action; its ids live in `src/shared/designer/catalog.ts`, and',
    '[docs/table-designer.md](table-designer.md) describes them.',
    '',
    ...promptDocs(),
    ...longRunDocs(),
    ...databasePropertiesDocs(),
    '## SQL',
    '',
    'DDL runs on its own unpooled connection (the program name plus " - Object Actions"), never Object Explorer\'s or',
    'scripting\'s pools, after a preflight in the same connection that finds the object again, re-derives its subtype and',
    'checks permissions and name collisions. Statements are built by SQL Server from constant text: names are nvarchar(128)',
    'parameters passed through `QUOTENAME`. DDL waits for locks without a timeout, as SSMS does, and Stop is always',
    'available: the dialog\'s or document\'s Stop, or the status bar\'s Stop for a rename. A stopped action answers once SQL',
    'Server has ended the statement, with each step done, cancelled or skipped, so the dialog or document says what completed',
    'before Stop.',
    '',
    'Deleting a database runs SSMS\'s statements in a safer order: Close existing connections (`SET SINGLE_USER WITH ROLLBACK',
    'IMMEDIATE`), then `DROP DATABASE`, and only after the DROP succeeds, the backup and restore history',
    '(`msdb.dbo.sp_delete_database_backuphistory`). SSMS deletes the history first, so a DROP that fails (for example, a',
    'query window still uses the database) would lose it; Script Action shows the order Varia runs.',
    '',
    `If the backend stops while an action runs: "${unknownOutcomeMessage}"`,
    '',
    '## Errors',
    '',
    'Failures come back as values in the result. Retryable ones can succeed when tried again.',
    '',
    table(['Code', 'Retryable'], actionErrorCodes.map(error => [code(error), yesNo(actionErrorRetryable[error])])),
    '',
    '## Limits',
    '',
    table(['Limit', 'Value', 'Meaning'], (Object.keys(limitNotes) as (keyof typeof actionLimits)[]).map(key => [code(key), actionLimits[key].toLocaleString('en-US'), limitNotes[key]])),
    ''
  ].join('\n')
}

const notOnText = (def: DatabaseOptionDef) => def.notOn?.join(', ') ?? ''
const sqlForms = { compat: '`COMPATIBILITY_LEVEL`', collate: '`COLLATE`', autoCreateStats: '`AUTO_CREATE_STATISTICS`', snapshotIsolation: '`ALLOW_SNAPSHOT_ISOLATION`', filestream: '`FILESTREAM( NON_TRANSACTED_ACCESS = … )`' } as const
function optionSql(def: DatabaseOptionDef): string {
  const sql = def.sql
  if (!sql) return ''
  if (sql.kind === 'set') return [sql.keyword.trim() ? code(sql.keyword.trim()) : '', sql.tokens ? Object.values(sql.tokens).map(text => code(text.trim())).join(', ') : sql.seconds ? '`n SECONDS`' : ''].filter(Boolean).join(' ')
  if (sql.kind === 'scoped') return code((sql.secondary ? 'FOR SECONDARY SET ' : 'SET ') + sql.name)
  return sqlForms[sql.kind]
}
const optionRow = (def: DatabaseOptionDef): string[] =>
  [def.label, def.category === 'header' ? 'Header' : def.category, yesNo(def.settable), optionSql(def), def.exclusive ? 'Yes' : '', def.settable && def.refusedReadOnly ? 'Yes' : '', def.since ? String(def.since) : '', notOnText(def)]

/** Database Properties: its pages, the options it changes, the order its statements run in, and the Open Connections rule. */
function databasePropertiesDocs(): string[] {
  return [
    '## Database Properties',
    '',
    'Database Properties opens as a document tab, one per database and connection (Properties on a database whose',
    'document is open brings that tab forward). Its header names the server and the database, shows the database\'s',
    'state in SMO\'s words ("Normal", "Restoring, Standby", "Normal, Read-Only"), and offers Refresh, Discard Changes and',
    'Apply; Stop replaces them while the changes run. Its sections are SSMS\'s pages. General shows read-only facts as',
    'text: backups, name, status, owner, date created, size, space available, number of users, memory-optimized memory and',
    'collation. Files and Filegroups list the database\'s files and filegroups read-only in this version; Owner in Files is',
    'editable (typed, suggested from the server\'s logins, or chosen in Select Database Owner). Options shows Collation,',
    'Recovery model, Compatibility level and Containment type, then every option under its category: a boolean as a',
    'switch, an enum of four values or fewer as a segmented control, a longer or server-supplied one as a list, a number as',
    'a number field, and what Varia does not change as text. A row\'s whole description shows in a strip under the',
    'sections while the pointer or focus is in the row, and as the label\'s tooltip; why a row is greyed and what is wrong',
    'with a value show under it, and a section with a problem is marked in the list. Changed values are bold and say',
    '"Changed" (part of the control\'s description for screen readers), and the tab shows unsaved changes.',
    '',
    'Apply (also File › Save, Ctrl+S, and the close prompt\'s Save, which bring the document forward with its Stop) is',
    'SSMS\'s OK that keeps the document open: it runs only the values that changed, reloads the Databases listing, and',
    'reads the database again; if that read fails, the message says the changes were applied. File › Save All leaves the',
    'document out, because its ALTER DATABASE can wait on locks. Refresh waits until the changes are applied or discarded.',
    'When whether an Apply completed is unknown (the server or backend went, or Stop got no answer in time), the fields lock',
    'until a Refresh, and the message says to Discard Changes, then Refresh. The Script drawer previews what Apply would',
    'run while it is open,',
    `once typing pauses; with nothing changed it says "${noScriptNotice}" A snapshot, a database that is not online or`,
    'not accessible, a database the login may not ALTER, and Azure SQL Managed Instance open read-only with a note.',
    'Compatibility level is greyed for a login outside sysadmin (SSMS ignores the change silently), and Containment type',
    `when the server's contained database authentication is off. The owner of ${ownerNotOn.join(', ')} cannot change.`,
    'On a read-only database only Database Read-Only and Restrict Access change, and the owner is greyed. Turning Database',
    'Read-Only on cannot share an Apply with a change SQL Server applies after it and refuses on a read-only database (the',
    '"Read-only" column below, and the owner): SSMS would leave the database read-only with that change failed, so Varia',
    'says why and runs nothing.',
    '',
    `Compatibility levels offered: ${compatibilityLevels.map(compatibilityLabel).join(', ')}, up to the server's own.`,
    '',
    '### Database options',
    '',
    '"Exclusive": SSMS closes other connections to change it. "Read-only": SQL Server refuses the change on a read-only',
    'database (3906, or 5073 for COLLATE; measured on SQL Server 2025). "Not on": system databases SQL Server refuses it on',
    '(Learn\'s master, model, msdb and tempdb pages). "Since": the version band (13 = SQL Server 2016, 17 = 2025).',
    '',
    table(['Option', 'Category', 'Settable', 'SQL', 'Exclusive', 'Read-only', 'Since', 'Not on'], [...databaseOptionDefs, ...scopedConfigurationDefs].map(optionRow)),
    '',
    '### Statement order',
    '',
    'Script and OK write SSMS\'s statements in SSMS\'s order (SMO\'s Database.ScriptAlter, then SSMS\'s own steps):',
    '',
    '1. One ALTER DATABASE per changed option in SMO\'s order: containment, compatibility level, collation, then the SET',
    '   options (WITH NO_WAIT, or WITH ROLLBACK IMMEDIATE when other connections are closed), then the scoped',
    '   configurations in the database (`USE [db]`, then `ALTER DATABASE SCOPED CONFIGURATION …`).',
    '2. `ALTER DATABASE … SET ALLOW_SNAPSHOT_ISOLATION`, as SSMS\'s SetSnapshotIsolation.',
    '3. The owner: `ALTER AUTHORIZATION ON DATABASE::[db] TO [login]` in the database.',
    '',
    'Each statement is one step; the first failure stops the rest, which are skipped. Statements are built by SQL Server',
    'from constant text: names through `QUOTENAME`, numbers through `CONVERT` of range-checked parameters, keywords only',
    'from this catalogue, and a collation only as `sys.fn_helpcollations()` names it.',
    '',
    '### Open Connections',
    '',
    `When Apply changes an exclusive option and the database has sessions (or they cannot be counted), Varia asks "${openConnectionsPrompt.message}"`,
    `(${openConnectionsPrompt.buttons.join(' or ')}; ${openConnectionsPrompt.buttons[openConnectionsPrompt.defaultId]} is the default, because Yes rolls back the other sessions' transactions, and Escape answers No).`,
    'No runs nothing. Yes writes the SET options WITH ROLLBACK IMMEDIATE. SSMS counts the connections when OK is pressed, so',
    'the backend counts them again before anything runs: when sessions have joined since the document read none, it',
    'answers `IN_USE` at once and the document asks. The backend first closes its own idle pooled connections in the database',
    'and, because SQL Server lists their sessions for a few milliseconds after that, counts again every 50 ms for up to a',
    'second while the count is above zero. Without the prompt, WITH NO_WAIT makes SQL Server refuse (`IN_USE`)',
    'rather than wait for the other sessions\' transactions; SQL Server gives up after about 20 seconds. That failure advises',
    'choosing Yes only after an exclusive change made without closing connections; otherwise (Broker Enabled or Containment',
    'type with other sessions, which SSMS does not close connections for) it advises closing them first. Script never',
    'asks: it always writes WITH NO_WAIT, as SSMS does.',
    ''
  ]
}
