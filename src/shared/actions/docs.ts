// Renders docs/object-actions.md from the actions catalogue; tests/object-actions-catalog.test.ts keeps the file in sync.
import { kindSpecs, nodeKinds, serverEngines, type NodeSubtype } from '../explorer/catalog.ts'
import { longRunKinds, longRunLimits, longRunSubjects } from '../long-runs.ts'
import {
  actionCommandEntries, actionContextKey, actionErrorCodes, actionErrorRetryable, actionKindSpecs, actionLimits, actionMenus, actionRow, actionStatuses, allFilesType, databaseActionRules,
  databaseStateIds, dialogIds, dialogSpecs, objectActions, objectActionSpecs, scriptActionTitles, serverActions, serverActionSpecs, serverFilePurposes, serverFilePurposeSpecs, serverFilesDescribeId, serverFileTypesLabel,
  unknownOutcomeMessage
} from './catalog.ts'
import { actionPromptBox, actionPrompts, promptLimits, type ActionPromptRequest } from './prompts.ts'
import { compatibilityLabel, compatibilityLevels, databaseOptionDefs, noScriptNotice, openConnectionsPrompt, ownerNotOn, scopedConfigurationDefs, type DatabaseOptionDef } from './database.ts'
import { loginGreyedMessage, loginLimits, loginMessages, loginRules, loginSubtypes, loginTypeSubtypes, loginVerbs, ownLoginRefuses, saPrincipalId } from './logins.ts'
import { designerEngines } from '../designer/catalog.ts'
import { backupSetTypes, backupSetTypeSpecs, plannedSetTypes, restoreDescribeId, restoreLimits, restoreMessages, restoreRecoveryLabels, restoreRecoveryStates, restoreSections, restoreSourceKinds, restoreSystemDatabases, timelineIntervals, timelineIntervalSpecs } from './restore.ts'

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
  readPerConnection: 'Describe and script requests at once per connection',
  readTotal: 'Describe and script requests at once in total',
  executePerConnection: 'Actions running at once per connection; long actions take the long gate instead',
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
  statusDelayMs: 'How long a state action (a rename, a login\'s Disable or Enable) runs before the status bar shows it with Stop, in ms',
  serverPath: 'UTF-16 code units in a path on the server (`sys.master_files.physical_name` is nvarchar(260))',
  browseEntries: 'Entries the server file picker lists per folder; more set `truncated`',
  browseMs: 'The backend\'s budget for one listing of the server file picker, in ms; then `TIMEOUT` (main\'s deadline is 15 s)',
  browsePerConnection: 'Server file picker listings at once per server, under a gate of their own rather than the describe and script gates',
  attachDatabases: 'Databases one Attach Databases OK attaches',
  attachFiles: 'Files one database to attach lists (a primary file that records more is refused)',
  cleanupMs: 'How long an action\'s compensation and cleanup steps may run after a failure or Stop, in ms, unless the action sets its own; a Stop\'s reply waits `stopGraceMs` plus this',
  progressEventMs: 'How often a long step\'s progress (SQL Server\'s message 3211, from `STATS`) may reach main as a droppable `action.progress` EVENT, at most, in ms',
  progressPerSecond: 'Progress updates main pushes to the window per request each second, at most; the first of each step always goes',
  longPerConnection: 'Long actions (a restore or backup) running at once per connection; another waits `gateWaitMs`, then `BUSY`',
  longTotal: 'Long actions running at once in total',
  drainMarginMs: 'What main adds to a long action\'s Stop wait (`stopGraceMs` plus its cleanup budget) when it lets a closing backend finish, in ms',
  newDatabaseFiles: 'Files one New Database request may create',
  newDatabaseFilegroups: 'Filegroups one New Database request may create, PRIMARY included',
  dataFileMb: 'A data file\'s initial and maximum size in New Database, in MB (2,147,483,647 pages, SQL Server\'s ceiling for a file, just under 16 TB)',
  logFileMb: 'A log file\'s initial and maximum size in New Database, in MB (2 TB, SQL Server\'s ceiling for a log file)',
  growthMb: 'A file\'s autogrowth in MB, in New Database',
  growthPercent: 'A file\'s autogrowth in percent, in New Database'
}
const engineNames = { box: 'SQL Server', managedInstance: 'Managed Instance', cloud: 'Azure SQL Database' } as const
const loginLimitNotes: Readonly<Record<keyof typeof loginLimits, string>> = {
  password: 'UTF-16 code units in a password',
  databases: 'Databases New Login and Login Properties list',
  languages: 'Languages the Default language list offers',
  serverRoles: 'Server roles listed and chosen',
  roles: 'Database roles listed and chosen per database',
  schemas: 'Schemas listed per database',
  mappings: 'Database user mappings per request',
  credentials: 'Credentials mapped per request',
  certificates: 'Certificates listed',
  asymmetricKeys: 'Asymmetric keys listed',
  permissions: 'Server permissions per request',
  sidHex: 'Characters of a SID as hexadecimal text',
  stepTitle: 'Characters in a step\'s title',
  stepDetail: 'Characters in a step\'s detail',
  ownedDatabases: 'Databases a login owns that the login preflight names',
  mappedUsers: 'Mapped database users Delete Login lists',
  scanDatabases: 'Databases the mapped-user scan reads',
  serviceNames: 'Service accounts the service lookup reads'
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
    `Each action names the servers that offer it (${serverEngines.map(code).join(', ')}: an on-premises SQL Server or a container, Azure SQL Managed Instance, Azure SQL Database);`,
    'the Servers column above says which, and on another server the menu hides the item. Menus read the server through',
    '`explorerServerEngine` and `explorerServerLinux`.',
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
    'Create Catalog, New Database and Attach Databases are the long runs so far; the others are reserved for the actions that will use them.',
    '',
    'A short state action (a rename; later a login\'s Disable and Enable) runs as a status-bar job instead: one per node,',
    'shown with Stop after `statusDelayMs`, naming its step when it has several ("Renaming Sales to Sales2: Closing',
    'connections…").',
    '',
    ...longActionDocs()
  ]
}

/** The long gate, STATS progress and the drain of a closing backend (D1 §3.3, §9.4, §9.5). */
function longActionDocs(): string[] {
  const long = objectActions.filter(action => objectActionSpecs[action].long)
  return [
    '### Long actions and progress',
    '',
    'An action marked long in the catalogue (a restore, a verify or a backup) takes the long gate instead of the execute gate:',
    `${actionLimits.longPerConnection} per Varia connection and ${actionLimits.longTotal} in all. Another waits up to \`gateWaitMs\`, then answers \`BUSY\``,
    '("Another restore or backup is running on this connection.", or "Restores or backups are already running on other',
    'connections." when long actions elsewhere hold every slot), so a long run never blocks a rename or a delete.',
    'Its steps run through a data reader, never `ExecuteNonQuery`, because SqlClient raises informational messages as they',
    'arrive only for a reader: SQL Server\'s message 3211 ("n percent processed.", from `STATS`) becomes a droppable',
    `\`action.progress\` EVENT \`{step, percent}\` at most every ${actionLimits.progressEventMs} ms, and is never one of the ${actionLimits.infoMessages} messages the reply keeps.`,
    'Each step\'s start goes out at once as percent 0, and a percent the interval held back goes out when the interval ends (or',
    'before the next step\'s start), so a step\'s last percent is not lost and a finished step never looks stuck while the next waits.',
    `Main checks each EVENT and pushes \`varia:actions-progress {requestId, step, percent}\` only to the window that sent the request, at most ${actionLimits.progressPerSecond} a`,
    'second: a new step at once, and the latest percent held inside the interval when it ends (`actionProgressRelay`); an',
    'invalid EVENT is dropped, never a reason to stop the run. The page keeps',
    'the latest percent per request (`ActionProgressService`) and draws it under the running step of its `StepList`; the',
    'reply\'s steps carry the last percent each step reached as `progress`.',
    '',
    'When the backend\'s generation is closed (a quit, a reload, Restart SQL Backend), it stops its long actions itself and',
    `runs their cleanup steps within their budgets; main lets that generation run \`stopGraceMs\` plus the action's cleanup budget plus ${actionLimits.drainMarginMs / 1000} s`,
    'before it kills it (`actionDrainMs`, methodPolicies\' `drainMs`).',
    '',
    long.length ? `Long actions: ${long.map(action => objectActionSpecs[action].title).join(', ')}.` : 'No action is long yet; the restore, verify and backup actions that will be are still to come.',
    ''
  ]
}

/** The actions object rows offer; a folder's (Attach) are listed under Folder actions. */
const rowActions = objectActions.filter(action => !objectActionSpecs[action].folder)
const folderActions = objectActions.filter(action => objectActionSpecs[action].folder)
/** One line per kind and run of subtypes that act alike. */
function kindRows(): string[][] {
  return nodeKinds.flatMap(kind => {
    if (!actionKindSpecs[kind]) return []
    const groups = new Map<string, string[]>()
    for (const subtype of [undefined, ...kindSpecs[kind].subtypes ?? []] as (NodeSubtype | undefined)[]) {
      const states = rowActions.map(action => mark(actionRow(kind, subtype)?.[action])).join('\n')
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
    'Object Explorer\'s actions on objects: Select Top 1000 Rows, Rename, Delete and Properties, and the Databases folder\'s Attach. Which kinds, subtypes and folders offer each is',
    'data in `src/shared/actions/catalog.ts`; the backend embeds the same data as `backend/Varia.Backend/Actions/actions-catalog.json`',
    'and re-derives the subtype in the action\'s own connection before any DDL runs.',
    '',
    '## Actions',
    '',
    table(['Action', 'Menu title', 'Command', 'Kind', 'Menu', 'Group', 'Mnemonic', 'Windows and Linux', 'macOS', 'Servers', 'Context key'], objectActions.map(action => {
      const spec: (typeof objectActionSpecs)[typeof action] & { readonly menuTitle?: string; readonly menu?: string } = objectActionSpecs[action]
      return [code(action), spec.menuTitle ?? spec.title, code(spec.command), spec.class + (spec.dialog ? ` (${code(spec.dialog)})` : ''), code(spec.menu ?? 'explorer.context'), `${code(spec.group)} ${spec.order}`, spec.mnemonic,
        keys(action, false), keys(action, true), spec.engines.map(engine => engineNames[engine]).join(', '), code(actionContextKey(action))]
    })),
    '',
    '"Servers" is each action\'s `engines`: SQL Server is the box editions, Managed Instance is EngineEdition 8, and Azure SQL',
    'Database stands for the cloud editions. The backend refuses an action elsewhere with `NOT_SUPPORTED` before it opens a',
    `connection. The table designer's \`createTable\` runs on ${designerEngines.map(engine => engineNames[engine]).join(' and ')}.`,
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
    table(['Kind', 'Subtypes', ...rowActions.map(action => objectActionSpecs[action].title)], kindRows()),
    '',
    '## Folder actions',
    '',
    'These are offered on an Object Explorer folder instead of object rows; their target is the folder\'s server (`{ kind: \'server\' }`),',
    'and the backend refuses any other target.',
    '',
    table(['Action', 'Folder', 'Servers'], folderActions.map(action => [objectActionSpecs[action].title, code(objectActionSpecs[action].folder ?? ''),
      objectActionSpecs[action].engines.map(engine => engineNames[engine]).join(', ')])),
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
    ...serverFilesDocs(),
    ...promptDocs(),
    ...longRunDocs(),
    ...databasePropertiesDocs(),
    ...newDatabaseDocs(),
    ...attachDocs(),
    ...restoreDocs(),
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
    '### Steps, compensation and cleanup',
    '',
    'Each statement is a step, and the reply lists them in order with a status (done, failed, cancelled or skipped), a title, SQL',
    'Server\'s message for a failed one, and for some a detail (a name) or progress. The first failure stops the rest, which are',
    'skipped. An action may also plan compensation steps, each undoing one earlier step once that step completed and a later one',
    'failed or was stopped (restoring a database\'s user access after a failed rename, for example), and cleanup steps that run',
    'after any failure or Stop (removing a partly restored database Varia created). They run on the same connection under a fresh',
    'budget (`cleanupMs`), are listed only when they ran, marked as compensating, and the error message says how they ended. A',
    'Stop\'s reply waits for SQL Server to end the statement and then for them, so it never reports an unknown outcome while',
    'Varia\'s own cleanup runs. An action can instead run its steps in one transaction (the table designer\'s Save): a failure or',
    'Stop rolls it back, and only the commit, which Stop no longer reaches, completes it.',
    '',
    'Before the first statement that needs a database to itself (setting single-user, renaming, dropping or detaching it), and',
    'before Database Properties applies its changes, the backend frees the database of its own sessions, on every connection',
    'to that server: for each connection whose own database it is (the Connect dialog\'s Database, or the login\'s default, read',
    'at connect), Object Explorer\'s, scripting\'s, SSIS\'s and the live views\' server-scope connections open in master from then',
    'on (unless the login is a contained database user, who cannot open master, or the connect could not read the server\'s',
    'profile), the idle pooled connections in the database are closed, and for up to a second the backend waits for SQL Server',
    'to end the sessions its pooled connections were given (with VIEW SERVER STATE; without it the action cannot see them).',
    'Activity Monitor and Object Explorer\'s status sample in master on SQL Server and Managed Instance, for the same reason,',
    'except for a contained database user or an unread profile. Query windows are the user\'s own and stay where they are.',
    '',
    'Deleting a database runs SSMS\'s statements in a safer order: Close existing connections (`SET SINGLE_USER WITH ROLLBACK',
    'IMMEDIATE`), then `DROP DATABASE`, and only after the DROP succeeds, the backup and restore history',
    '(`msdb.dbo.sp_delete_database_backuphistory`). SSMS deletes the history first, so a DROP that fails (for example, a',
    'query window still uses the database) would lose it; Script Action shows the order Varia runs.',
    '',
    `If the backend stops while an action runs: "${unknownOutcomeMessage}"`,
    '',
    '### Shared statements',
    '',
    'Later actions plan these statements. Each is built by SQL Server from constant text, linted, and checked against hostile',
    'names by a live dry run:',
    '',
    table(['Step', 'As Script Action writes it'], [
      ['Restore multi-user access', '`ALTER DATABASE [db] SET  MULTI_USER`'],
      ['Restore restricted user access', '`ALTER DATABASE [db] SET  RESTRICTED_USER`'],
      ['Detach the database', '`EXEC master.dbo.sp_detach_db @dbname = N\'db\', @skipchecks = \'false\'` (\'true\' when Update Statistics is cleared)'],
      ['Disable the login, Enable the login', '`ALTER LOGIN [login] DISABLE`, `ALTER LOGIN [login] ENABLE`'],
      ['Deny or Grant permission to connect', '`DENY CONNECT SQL TO [login]`, `GRANT CONNECT SQL TO [login]`'],
      ['Drop the database user', '`DROP USER [user]`, in its database']
    ]),
    '',
    ...loginDocs(),
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

const ruleMarks = { allowed: '✓', greyed: '○', hidden: '–' } as const
const verbDone = { disable: 'disabled', enable: 'enabled', unlock: 'unlocked', rename: 'renamed', delete: 'deleted' } as const
/** Logins: subtypes, the protected-principal rules and the login limits (src/shared/actions/logins.ts). */
function loginDocs(): string[] {
  const types = Object.entries(loginTypeSubtypes)
  return [
    '## Logins',
    '',
    `Object Explorer gives each login a subtype from \`sys.server_principals\`: \`sa\` by principal_id ${saPrincipalId} whatever its name, \`system\``,
    'for SQL Server\'s own logins (a name that starts and ends with `##`), else by type: ' + types.map(([type, subtype]) => `${code(type)} ${code(subtype)}`).join(', ') + '.',
    'The login actions arrive in later versions; their rules are data already, and the backend\'s login preflight reads the',
    'facts they need in the action\'s own connection from catalog views only: never `LOGINPROPERTY`, which waits on a login',
    'another session is changing, and never a password hash, which no Varia statement may name.',
    '',
    '✓ allowed, ○ shown greyed and refused, – not offered.',
    '',
    table(['Subtype', ...loginVerbs.map(verb => verb.charAt(0).toUpperCase() + verb.slice(1)), 'Why greyed'], loginSubtypes.map(subtype => [code(subtype), ...loginVerbs.map(verb => ruleMarks[loginRules[subtype][verb]]),
      [...new Set(loginVerbs.filter(verb => loginRules[subtype][verb] === 'greyed').map(verb => loginMessages[loginGreyedMessage(subtype, verb)]))].join(' ')])),
    '',
    `The login this connection uses, or a Windows group it gets in through, cannot be ${ownLoginRefuses.map(verb => verbDone[verb]).join(', ')}: "${loginMessages.own}"`,
    `Without ALTER ANY LOGIN: "${loginMessages.alterAnyLogin}" For a sysadmin member without CONTROL SERVER: "${loginMessages.controlServer}"`,
    '',
    '### Login limits',
    '',
    table(['Limit', 'Value', 'Meaning'], (Object.keys(loginLimitNotes) as (keyof typeof loginLimits)[]).map(key => [code(key), loginLimits[key].toLocaleString('en-US'), loginLimitNotes[key]])),
    ''
  ]
}

/** The server file picker (`actions.describe` with `serverFiles`), which New Database, Attach and Restore will open from a "…" button. */
function serverFilesDocs(): string[] {
  return [
    '## Server file picker',
    '',
    `\`actions.describe\` with ${code(serverFilesDescribeId)}, the server as its target and a \`files\` member (\`purpose\`, \`path\`,`,
    '`allFiles`, `exists`) lists one folder on the server, or with no path the server\'s drives (/ on Linux) and its default',
    'data, log and backup folders. With `exists` it checks one path instead, for a typed name the listing does not show (past',
    'its limit or outside the type filter): the answer\'s entries hold that path\'s own entry, or none when it does not exist.',
    'Paths are the server\'s, with its separator; SQL Server\'s service account must be able to read them.',
    '',
    table(['Purpose', 'Title', 'Files of type', 'Extensions'], serverFilePurposes.map(purpose => {
      const spec = serverFilePurposeSpecs[purpose]
      const types = serverFileTypesLabel(purpose)
      return [code(purpose), spec.title + ' - <server>', types ? types + ', ' + allFilesType : 'Folders only', spec.extensions.join(', ') || '—']
    })),
    '',
    'A listing reads one level: SQL Server 2017 and later through `sys.dm_os_enumerate_filesystem` (level 0, with sizes and',
    'times), `sys.dm_os_file_exists` and `sys.dm_os_enumerate_fixed_drives`; SQL Server 2016 through `xp_dirtree`,',
    '`xp_fileexist` and `xp_fixeddrives`, which list folders only to members of sysadmin and answer anyone else with',
    'nothing, so that listing (and a check) carries the `legacyEmpty` notice. The path is a parameter of constant',
    'statements, and the type filter runs in SQL before `TOP`, so a folder full of other files still lists its backups. A',
    'missing folder, a file, or a path that is not a full path on that server is `PATH_NOT_FOUND`. Azure SQL Database and',
    'Managed Instance are refused before connecting (`NOT_SUPPORTED`). Main\'s deadline for a listing is 15 s. Listings take',
    'a gate of their own, one per server, so one stuck on an unreachable share never delays a dialog\'s describe.',
    '',
    'The picker\'s titles, Files of type entries and field names (Select the file, Select the folder, Selected path, Files of',
    'type, File name, Folder name) are SSMS\'s as recalled, not yet checked against SSMS 22.',
    ''
  ]
}

/** Attach Databases (D1d): what Add reads, what OK runs, and how a later failure rolls back. */
function attachDocs(): string[] {
  return [
    '## Attach Databases',
    '',
    `Databases › Attach… opens ${dialogSpecs.attachDatabase.title}, a modal dialog, on SQL Server's box editions only (Managed Instance and Azure SQL`,
    'Database have no attach). It opens with the server\'s logins for Owner and its default data folder; Add… opens the server',
    `file picker (Locate Database Files, ${serverFileTypesLabel('database')}), then \`actions.describe\` with \`attachDatabase\` and \`attach: { mdf }\``,
    'reads the file with `DBCC CHECKPRIMARYFILE (@mdf, 0)`, `(@mdf, 2)` and `(@mdf, 3)`: whether it is a primary data file, its',
    'database\'s name and version, and the files it records (a log by status 0x40). The path is a bound parameter; nothing',
    'is built as text, and the result sets are read in the backend. Each recorded file on the server\'s own disks is checked as',
    'the picker checks a path (`sys.dm_os_file_exists`, or `xp_fileexist` on SQL Server 2016, which answers only sysadmin); a',
    'share or device path the file records is never probed, since SQL Server\'s service account would sign in to that host, so',
    'its existence is unknown until the user checks it or OK runs. The .mdf\'s own row takes the path that was added. A file',
    'that is in use (an attached database\'s) cannot be read, and the error says so. A database newer than the server (its',
    'version above master\'s, `DATABASEPROPERTYEX(N\'master\', \'Version\')`, the catalog lint\'s one exception) is refused with',
    '`NOT_SUPPORTED`: SQL Server\'s own refusal, 948, is severity 20 and ends the session. Add\'s read waits on the file system,',
    'so it takes the picker\'s gate, not the describe gates.',
    '',
    'Each database row has Attach As (its database name by default), Owner (`<default>`: the attaching login), Status and',
    'Message; its details list Original File Name, File Type, Current File Path (typed, or chosen with "…", and checked again',
    'on Enter or when the field is left) and Message ("Not found"). OK is disabled while a data file is not found or a typed',
    'one is not yet checked, and while Add… reads a file or a path is checked. Remove takes a log file out: with every log file',
    'removed, SQL Server rebuilds the log (`FOR ATTACH_REBUILD_LOG`), which breaks the log backup chain, needs the database to',
    'have been shut down cleanly, and needs every data file.',
    '',
    'OK first checks, in the action\'s connection, that no database has the name, that the owner\'s login exists, that the login',
    'may create databases, that master\'s compatibility level is 130 or more (OPENJSON), and that the primary file is not newer',
    'than the server (its version read again). Then, per database, "Attach the',
    'database" (`CREATE DATABASE [name] ON ( FILENAME = N\'…\' ), … FOR ATTACH`, or `FOR ATTACH_REBUILD_LOG`), and with an owner',
    '"Set the database owner" (`ALTER AUTHORIZATION ON DATABASE::[name] TO [login]` in the database, as Database Properties',
    'writes it; SSMS uses the deprecated `sp_changedbowner`). SQL Server builds the CREATE DATABASE from two parameters:',
    'the name, through `QUOTENAME`, and one JSON array of paths, each quoted on the server (`REPLACE` of `\'` in a binary collation), joined in order',
    'without `STRING_AGG` (SQL Server 2016), and the keyword chosen from two constant batches. When a later step fails or Stop',
    'ends one, "Detach the database again" (`sp_detach_db` with `@skipchecks = \'true\'`) undoes each attach this OK made',
    '(and one Stop reached after SQL Server finished it, found by its name and primary file),',
    'newest first, so its row reads Rolled Back, as SSMS\'s does. Script Action writes the same statements and runs nothing.',
    'An attach is a long run: while it runs, closing the window, disconnecting its server and Restart SQL Backend are refused.',
    '',
    'Its labels (Databases to attach, MDF File Location, Database Name, Attach As, Owner, Status, Message, Add…, Remove,',
    '"<name>" database details, Original File Name, File Type, Current File Path, Not found) are SSMS\'s as recalled, not yet',
    'checked against SSMS 22.',
    ''
  ]
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
/** Server actions: New Database. */
function newDatabaseDocs(): string[] {
  const places = (spec: typeof serverActionSpecs[typeof serverActions[number]]) =>
    [...spec.folders.map(folder => `the ${code(folder)} folder`), ...spec.kinds.map(kind => `a ${code(kind)} node`)].join(', ')
  return [
    '## New Database',
    '',
    'A server action makes something on the server rather than acting on an object row, so no row offers it and no',
    '`explorerAction*` key gates it: its item reads the node it is on, and its describe\'s target is the server.',
    '',
    table(['Action', 'Menu title', 'Command', 'Document', 'On', 'Group', 'Mnemonic', 'Servers', 'Long run'], serverActions.map(action => {
      const spec = serverActionSpecs[action], { nodePlace } = spec
      const group = `${code(spec.group)} ${spec.order}` + (nodePlace ? `; on a node, ${code(nodePlace.group)} ${nodePlace.order}, as the menu-only ${code(nodePlace.command)}` : '')
      return [code(action), spec.title, code(spec.command), code(spec.dialog), places(spec), group, spec.mnemonic,
        spec.engines.map(engine => engineNames[engine]).join(', '), code(spec.longRun)]
    })),
    '',
    'New Database opens as a document tab (`newDatabase`, never dirty and never in Save All; Cancel, Escape or closing it',
    'discards it, as SSMS\'s Cancel does, and Save (Ctrl+S), or Enter outside its grids, is OK). A second one open is titled',
    'New Database (2), and so on. Its describe reads model as Database Properties reads it (a new database starts as a copy of',
    'model), the instance\'s default data and log folders, the server\'s collation, whether the login may create a database,',
    'master\'s compatibility level and the platform. The document sends the files, filegroups, collation, containment and',
    'ledger, and only the options and scoped configurations that differ from model: Script writes those, never every option as',
    'SSMS does. A file\'s default name is its logical name with .mdf, .ndf or .ldf, made safe for the server\'s platform',
    '(critic A23); a FILESTREAM or memory-optimized container is a folder named after it and grows as it needs. SQL Server on',
    'Linux has no FILESTREAM, so its filegroups are not offered there.',
    '',
    'OK runs the steps "Create the database", then Database Properties\' own ALTER steps for the options (titled by option),',
    'the filegroup changes (Autogrow all files, Set the default filegroup, Make the filegroup read-only) and "Set the owner".',
    'A failure after CREATE leaves the database, as SSMS does, and the steps say what completed. OK registers the',
    '`newDatabase` long run while it runs, and Stop cancels the running statement. On success the document closes, Object',
    'Explorer reloads the Databases folder (the one above System Databases, when it was opened on a system database) and',
    'selects the new database, and the toolbar\'s database list refreshes.',
    '',
    'The builder has SQL Server compose CREATE DATABASE from one JSON parameter: names through `QUOTENAME`, file names and',
    'paths as N\'\' literals quoted on the server (`REPLACE` under `Latin1_General_BIN2`), sizes through `CONVERT` of typed',
    'numbers (in KB up to 2,097,151 MB, as SQL Server reads a size as an int, and in MB above), the collation only as',
    '`sys.fn_helpcollations()` names it, files joined without `STRING_AGG`, and one execution',
    'form, `EXEC @module @stmt` with `@module = QUOTENAME(@db) + N\'.sys.sp_executesql\'`. Before it, the preflight refuses a',
    'name in use, a login without CREATE ANY DATABASE, a missing owner or collation, a folder that does not exist or a file',
    'that does (from SQL Server 2017, through `sys.dm_os_file_exists`), FILESTREAM where it is off, ledger before SQL Server',
    '2022, and Partial containment without contained database authentication. `CreateDatabaseSql.Lint` checks the builder',
    'with the table designer\'s OPENJSON rules (`JsonBuilderLint`): every column a number or `nvarchar(max)`, text only inside',
    '`QUOTENAME` (or the quoted-literal form), and JSON columns only into the arrays it shreds again.',
    ''
  ]
}

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

const restoreLimitNotes: Readonly<Record<keyof typeof restoreLimits, string>> = {
  mediaReadMs: 'The backend\'s budget for one restore describe, in ms (LABELONLY and HEADERONLY on a large striped set or a slow share); then `TIMEOUT`',
  describeDeadlineMs: 'Main\'s deadline for a restore describe, in ms: the budget and time to answer',
  mediaReadsPerConnection: 'Restore describes one connection runs at once, under their own gate outside the object actions\' read gates',
  backupDevices: 'Backup files one describe or restore names (a media set\'s families)',
  historyDatabases: 'Databases msdb\'s history lists; more set `historyTruncated`',
  historySets: 'The newest backup sets one database\'s history, or the media, lists; more set `setsTruncated`',
  planSets: 'Backup sets one restore runs: as many as the history lists (each RESTORE is a statement of its own)',
  restoreMoves: 'Files one restore moves (64 devices and 2 × 1,000 MOVE parameters stay under SQL Server\'s 2,100)',
  destinations: 'Destination names and other databases\' files read for Restore As collisions; more set a truncation flag',
  serverFiles: 'Other databases\' files read for Restore As collisions',
  setName: 'Characters of a backup set\'s name and user name (nvarchar(128))',
  setId: 'Characters of a set id: a backup_set_uuid (history) or <media set>:<position> (devices)',
  lsnDigits: 'Digits of an LSN, numeric(25, 0) sent as decimal text',
  position: 'A backup set\'s position in its media set (RESTORE … WITH FILE)',
  stats: 'STATS = n in the script, as SSMS asks SMO for',
  scriptChars: 'Characters of a restore\'s script, checked as each statement is written (every RESTORE repeats the moves)'
}

/** Restore Database (D1e): the reads, the planner, the document and its script; the run comes with D1f. */
function restoreDocs(): string[] {
  return [
    '## Restore Database',
    '',
    'Restore Database is a document tab ("Restore Database - <database>") with SSMS\'s pages as sections',
    `(${restoreSections.map(section => section.title).join(', ')}), the Select backup devices and Backup Timeline sub-dialogs, and a Script`,
    'drawer. Its OK, Stop, progress and the Tasks › Restore › Database… menu item come in a later update (D1f): until OK',
    'restores, no menu item, command or palette entry opens it, only the smoke tests\' hook (`window.__variaRestore`, test',
    `mode only), and the document says "${restoreMessages.runUnavailable}"`,
    '',
    `Its reads are \`actions.describe\` with ${code(restoreDescribeId)}, the server as its target and a \`restore\` member, one of`,
    `${restoreSourceKinds.map(code).join(', ')}:`,
    '',
    table(['Source', 'Reads'], [
      ['`history`', 'msdb\'s history: the databases it has backups of, and with `database` that database\'s newest sets with their media (disk files only)'],
      ['`devices`', '`RESTORE LABELONLY` on each backup file, which groups them into media sets, then `RESTORE HEADERONLY` on each media set'],
      ['`historyFiles`', 'One history set\'s files from msdb\'s `backupfile`'],
      ['`mediaFiles`', '`RESTORE FILELISTONLY` on one media set at one position']
    ]),
    '',
    'Every answer also carries the server\'s facts: its path separator, default data, log and backup folders, whether the',
    'login may restore, the databases a restore could replace and the files other databases hold. SQL Server 2016 and 2017',
    'have no default backup folder (`InstanceDefaultBackupPath` came with 2019), so their backup folder is the default data',
    'folder; SSMS reads the registry\'s BackupDirectory instead, which Varia\'s constant reads cannot. Statements are constant',
    '(`Actions/RestoreSql.cs`), with every name, path and position a parameter. A restore describe takes a gate of its own,',
    `${restoreLimits.mediaReadsPerConnection} per connection and outside the object actions' read gates, because SQL Server ends a read of a file on an`,
    'unreachable share only when the file call returns (about 21 s per file): a media read past its budget then still holds',
    `its gate, and never one Database Properties or Delete Object waits for. Its budget is ${(restoreLimits.mediaReadMs / 1000).toLocaleString('en-US')} s, and main's deadline is ${(restoreLimits.describeDeadlineMs / 1000).toLocaleString('en-US')} s.`,
    'A device SQL Server cannot open is `PATH_NOT_FOUND` when its operating system error says the file or path is not',
    'there (2, 3, 53, 67, 123, 161), and `FILE_ACCESS` otherwise (access denied, a file another program holds); media a',
    'restore cannot use (another program\'s, a damaged or incomplete set) is `MEDIA`. Azure SQL Database and Managed Instance',
    'are refused before connecting (`NOT_SUPPORTED`).',
    '',
    '### Plan',
    '',
    `The planner (\`src/shared/actions/restore-plan.ts\`) chooses only ${plannedSetTypes.map(type => backupSetTypeSpecs[type].type.toLowerCase()).join(', ')} backups that are on disk and not damaged;`,
    'the grid still lists the other kinds it reads, unchecked, with checkboxes disabled and the reason as their description:',
    '',
    table(['Set type', 'Component', 'Type', 'Planned'], backupSetTypes.map(type => [code(type), backupSetTypeSpecs[type].component, backupSetTypeSpecs[type].type, yesNo((plannedSetTypes as readonly string[]).includes(type))])),
    '',
    'It builds each plan backwards from its end, as SMO does. For the last backup taken, it starts from the newest backup',
    'and goes back through the logs it continues to the latest differential (with its full) or full. For a point in time',
    '(STOPAT, the server\'s local time) it takes the latest full and differential that finished by the point when one ends',
    'there; otherwise the first log that finished at or after the point, back through sets that finished by it. A copy-only',
    'log never joins a chain. A log continues a set only on its recovery fork: after a restore to a point in time, the next',
    'log starts on the old fork and forks inside itself, so it continues only a set that ends by its fork point, and the',
    'abandoned branch\'s logs never join a plan (`tests/fixtures/restore/smo-fork.json`, which the live checks record and',
    'restore). Sets of another database (`family_guid`) never chain, and Source › Device lists one database the media hold',
    'at a time (Source › Device › Database, the first one by default). SMO\'s `DatabaseRestorePlanner`, which SSMS uses,',
    'chooses the same sets in every case but one: for a point between',
    'the last log before a differential and that differential, SMO restores the differential, which no STOPAT can undo, so',
    'the database comes back as at the differential. Varia restores the logs instead (`tests/fixtures/restore/smo-plans.json`',
    'records both plans; the live checks restore each).',
    '',
    'The grid\'s checkboxes take clicks only while Manual Selection is checked; unchecking a set also unchecks every set',
    `after it in the plan, as SSMS does, and unchecking Manual Selection brings the planner's plan back. Sets that do not chain say "${restoreMessages.invalidPlan}"`,
    'A set the planner never uses keeps its checkbox disabled, with the reason as its description and the row\'s tooltip:',
    `not on a disk file, "${restoreMessages.damaged}", "${restoreMessages.copyOnlyLog}" or "${restoreMessages.notPlanned}"`,
    `A point in time the checked sets cannot stop at says "${restoreMessages.notReached}"`,
    `Until the plan's full backup's files are read, Script waits: "${restoreMessages.filesNotRead}"`,
    '',
    `The Backup Timeline shows the backups over an interval (${timelineIntervals.map(interval => timelineIntervalSpecs[interval].label).join(', ')}; Day first) ending at the last`,
    'backup: a large triangle for a full backup, a small one for a differential, a tick for a log, and a band where log',
    'backups cover. Its point is a slider: the arrow keys move it a minute, Shift and an arrow or Page Up and Page Down an',
    'hour, Home and End to the interval\'s ends. A point outside the covered band (other than a full or differential',
    'backup\'s finish) leaves OK disabled. SSMS also allows a point after the last log backup, restoring the tail-log backup',
    'it takes first; that comes with the run (D1f), so here such a point is refused.',
    '',
    '### Options and script',
    '',
    `Recovery state is one of ${restoreRecoveryStates.map(state => restoreRecoveryLabels[state]).join(', ')}. Restoring over the database the`,
    'backups came from takes a tail-log backup first by default (BACKUP LOG … WITH NORECOVERY into the default backup folder,',
    '`<database>_LogBackup_<yyyy-MM-dd_HH-mm-ss>.bak`); a copy under another name moves its files to the default data and',
    'log folders under its own name, or to the folders Relocate all files to folder names. A Restore As path that another',
    'database holds, or that two files share, is marked on the Files section: the Files section compares paths as the',
    'server\'s platform does (exactly on Linux), while main and the backend refuse two files on one path ignoring case on',
    'every platform, so on Linux two files whose paths differ only in case cannot restore together (a known limit).',
    '',
    'Script (`actions.script` with the `restore` action) is written from the request and the catalogue, on no connection, and',
  `stops once it passes ${restoreLimits.scriptChars.toLocaleString('en-US')} characters ("The script is too large"). It writes what SMO's restore plan scripts for the same choices:`,
    '`USE [master]`, `ALTER DATABASE … SET SINGLE_USER WITH ROLLBACK IMMEDIATE` when Close existing connections is checked',
    'and the destination exists, the tail-log backup, one RESTORE per set (`FILE =`, `MOVE`, `REPLACE`, `KEEP_REPLICATION`, `RESTRICTED_USER`,',
    '`NORECOVERY` or `STANDBY`, `STOPAT`, `NOUNLOAD`, `STATS = 5`), `SET MULTI_USER` after it, and `GO`. Live checks compare',
    'the text with SMO\'s `Script()` for hostile names and paths; Varia writes two spaces after SET (`SET  SINGLE_USER`), as its',
    'other database options do, where SMO writes one.',
    '',
    `SQL Server's own databases (${restoreSystemDatabases.join(', ')}) are refused as destinations, in any case (MSDB too): "${restoreMessages.systemDatabase}"`,
    'Their backups can still be sources, restored under another name (msdb_copy), as SSMS allows.',
    `Prompt before restoring each backup and Verify Backup Media are greyed ("${restoreMessages.notYetAvailable}").`,
    '',
    'The labels (General, Files and Options; Source, Device, Destination, Restore to, Timeline…, Backup sets to restore and',
    'its columns, Manual Selection; Relocate all files to folder, Data file folder, Log file folder, Restore the database',
    'files as, Restore As; the restore options, Tail-Log',
    'backup, Server connections and Prompt; Select backup devices; Backup Timeline) are SSMS\'s as recalled, not yet checked',
    'against SSMS 22.',
    '',
    '### Restore limits',
    '',
    table(['Limit', 'Value', 'Meaning'], (Object.keys(restoreLimitNotes) as (keyof typeof restoreLimits)[]).map(key => [code(key), restoreLimits[key].toLocaleString('en-US'), restoreLimitNotes[key]])),
    ''
  ]
}
