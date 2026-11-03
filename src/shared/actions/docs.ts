// Renders docs/object-actions.md from the actions catalogue; tests/object-actions-catalog.test.ts keeps the file in sync.
import { kindSpecs, nodeKinds, serverEngines, type NodeSubtype } from '../explorer/catalog.ts'
import { longRunKinds, longRunLimits, longRunSubjects } from '../long-runs.ts'
import {
  actionCommandEntries, actionContextKey, actionErrorCodes, actionErrorRetryable, actionKindSpecs, actionLimits, actionMenus, actionRow, actionStatuses, databaseActionRules, databaseStateIds,
  createActionSpecs, createActions, dialogIds, dialogSpecs, kindDialogActionSpecs, objectActions, objectActionSpecs, scriptActionTitles, unknownOutcomeMessage
} from './catalog.ts'
import { actionPromptBox, actionPrompts, promptLimits, type ActionPromptRequest } from './prompts.ts'
import { compatibilityLabel, compatibilityLevels, databaseOptionDefs, noScriptNotice, openConnectionsPrompt, ownerNotOn, scopedConfigurationDefs, type DatabaseOptionDef } from './database.ts'
import {
  loginDatabaseRolesDescribe, loginDeleteText, loginGreyedMessage, loginLimits, loginLockProperties, loginMessages, loginPropertiesMessages, loginRules, loginSubtypes, loginTypeSubtypes, loginVerbs,
  newLoginMessages, ownLoginRefuses, passwordScriptHeader, saPrincipalId, tooManyStatementsMessage, unlockChoiceText, unlockHandOffLabel
} from './logins.ts'
import { designerEngines } from '../designer/catalog.ts'

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
  statusDelayMs: 'How long a state action (a rename, a login\'s Disable or Enable) runs before the status bar shows it with Stop, in ms',
  cleanupMs: 'How long an action\'s compensation and cleanup steps may run after a failure or Stop, in ms, unless the action sets its own; a Stop\'s reply waits `stopGraceMs` plus this',
  blockers: 'Sessions in a database that Delete Object lists (never Varia\'s own pooled sessions); more set `blockersTruncated`',
  blockerChars: 'Characters of each listed session\'s program and host names'
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
  scanMs: 'How long the mapped-user scan reads databases before it counts the rest as not checked, in ms',
  serviceNames: 'Service accounts the service lookup reads',
  serviceName: 'Characters of the service name the login facts carry'
}

// As src/shared/commands/menus.ts titles them (that module needs a bundler; this one loads in plain Node).
const submenuTitles = { 'explorer.tasks': 'Tasks', 'explorer.tasks.restore': 'Tasks › Restore' } as const
/** Menus, statuses, database states and servers: what narrows an action beyond its kind and subtype. */
function narrowingDocs(): string[] {
  // A kind's overlay, then each subtype's own (a login's Enable depends on its subtype), runs of alike subtypes in one row.
  const overlays = nodeKinds.flatMap(kind => actionStatuses(kind).flatMap(status => {
    const spec = actionKindSpecs[kind]
    const changes = (overlay: Partial<Record<string, string>>) => objectActions.filter(action => action in overlay).map(action => `${objectActionSpecs[action].title}: ${mark(overlay[action] || undefined)}`).join(', ')
    const rows = spec?.statuses?.[status] ? [[code(kind), 'any', code(status), changes(spec.statuses[status])]] : []
    const groups = new Map<string, string[]>()
    for (const [subtype, overlays] of Object.entries(spec?.subtypeStatuses ?? {})) {
      const overlay = overlays?.[status]
      if (overlay) groups.set(changes(overlay), [...groups.get(changes(overlay)) ?? [], code(subtype)])
    }
    return [...rows, ...[...groups].map(([text, subtypes]) => [code(kind), subtypes.join(', '), code(status), text])]
  }))
  return [
    '## Menus, statuses, database states and servers',
    '',
    `An action's item goes in ${actionMenus.map(menu => code(menu)).join(', ')}: Object Explorer's menu, or its Tasks submenus. ` +
      actionMenus.filter(menu => menu !== 'explorer.context').map(menu => `${submenuTitles[menu as Exclude<typeof menu, 'explorer.context'>]} (${code(menu)})`).join(' and ') +
      ' stay hidden while nothing is placed in them, so they appear with their first action.',
    '',
    'A node\'s status badge (`explorerNodeStatus`) can overlay its row: a disabled login offers Enable in place of Disable.',
    '',
    overlays.length ? table(['Kind', 'Subtypes', 'Status', 'Changes'], overlays) : 'No kind changes its actions by status yet.',
    '',
    'Only `disabled` changes a login\'s actions: a login denied permission to connect can still be disabled, as in SSMS.',
    '',
    `A database row carries its runtime state as listed (state, user access, read-only, standby); a newer live status sample wins.`,
    `Rules narrow a database's actions by it, each with the reason a greyed item shows. The states: ${Object.values(databaseStateIds).map(code).join(', ')}, \`other\`.`,
    databaseActionRules.length
      ? table(['Action', 'States', 'Access', 'Read-only', 'Effect', 'Reason'], databaseActionRules.map(rule => [objectActionSpecs[rule.action].title, rule.states?.join(', ') ?? 'Any', rule.access?.join(', ') ?? 'Any',
        rule.readOnly === undefined ? 'Any' : yesNo(rule.readOnly), rule.hide ? 'Hidden' : 'Greyed', rule.reason]))
      : 'No rule narrows a database\'s actions yet.',
    '',
    `Each action names the servers it runs on (${serverEngines.map(code).join(', ')}: an on-premises SQL Server or a container, Azure SQL Managed Instance, Azure SQL Database);`,
    'the Runs on column above says which, and the menu hides it elsewhere. Menus read the server through `explorerServerEngine` and `explorerServerLinux`.',
    ''
  ]
}

const promptSamples: { readonly [P in ActionPromptRequest['prompt']]: Extract<ActionPromptRequest, { prompt: P }>['facts'] } = {
  renameDatabase: { database: 'Sales', sessions: 3, transactions: 1, tabs: 2, tabsWithTransactions: ['Query 1.sql'], canClose: true },
  disableLogin: { login: 'app_user', sessions: 2, service: 'SQL Server Agent (MSSQLSERVER)', sysadmin: false, connections: ['Reporting (sql01)'] }
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
    'A short state action (a rename, a login\'s Disable and Enable) runs as a status-bar job instead: one per node, shown',
    'with Stop after `statusDelayMs` ("Disabling app_user…", Stop disable), naming its step when it has several ("Renaming',
    'Sales to Sales2: Closing connections…").',
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
    table(['Action', 'Menu title', 'Command', 'Kind', 'Menu', 'Group', 'Mnemonic', 'Windows and Linux', 'macOS', 'Context key', 'Runs on'], objectActions.map(action => {
      const spec: (typeof objectActionSpecs)[typeof action] & { readonly menuTitle?: string; readonly menu?: string } = objectActionSpecs[action]
      return [code(action), spec.menuTitle ?? spec.title, code(spec.command), spec.class + (spec.dialog ? ` (${code(spec.dialog)})` : ''), code(spec.menu ?? 'explorer.context'), `${code(spec.group)} ${spec.order}`, spec.mnemonic,
        keys(action, false), keys(action, true), code(actionContextKey(action)), spec.engines.map(engine => engineNames[engine]).join(', ')]
    })),
    '',
    '"Servers" is each action\'s `engines`: SQL Server is the box editions, Managed Instance is EngineEdition 8, and Azure SQL',
    'Database stands for the cloud editions. The backend refuses an action elsewhere with `NOT_SUPPORTED` before it opens a',
    `connection. The table designer's \`createTable\` runs on ${designerEngines.map(engine => engineNames[engine]).join(' and ')}.`,
    '',
    'Actions that make an object open their dialog on a folder and name its owner as their target; no tree row offers them, so',
    'they have their own commands and no context key:',
    '',
    table(['Action', 'Title', 'Dialog', 'Servers'], createActions.map(action => [code(action), createActionSpecs[action].title, code(createActionSpecs[action].dialog), createActionSpecs[action].engines.map(engine => engineNames[engine]).join(', ')])),
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
    '(`kit/StepList.tsx`, Create Catalog\'s too), each pending, running, done, failed, cancelled, skipped or rolled back, with an optional',
    'progress bar under a running step.',
    '',
    `In a modal dialog, the Script button scripts to a new query window; its arrow lists ${Object.values(scriptActionTitles).join(', ')}. Script never runs anything.`,
    'OK runs the action; Cancel reads Stop while it runs, and Stop cancels the statement in SQL Server.',
    '',
    'Delete Object for a database also offers "Delete backup and restore history information for databases" (checked,',
    'greyed for a snapshot) and "Close existing connections" (unchecked), as SSMS does. OK in the dialog is the only',
    'confirmation.',
    '',
    'For a database, the dialog also says what the DROP meets. Its warnings say when the database is offline ("This database',
    'is offline. Deleting it removes it from the server but leaves its files on disk."; SQL Server drops an offline database',
    'without deleting its files) and when database snapshots of it exist (the DROP fails until they are deleted). With VIEW',
    'SERVER STATE it lists the sessions using the database in a "Sessions using <database>" disclosure (session, program,',
    `host, and whether each has an open transaction; at most ${actionLimits.blockers} of them, never Varia's own pooled sessions). A session`,
    'uses the database when it is in it or has a transaction there from another database: SET SINGLE_USER WITH ROLLBACK',
    'IMMEDIATE rolls back both. Under Close existing connections the dialog counts the sessions with an open transaction,',
    'which closing rolls back, and names Varia\'s own query windows whose session holds one (by session, whatever database',
    'the window is in). On Azure SQL Managed Instance, which cannot set SINGLE_USER, Close existing connections is greyed',
    'with that reason, and a request that asks for it is refused before anything runs; where the option is greyed, the dialog',
    'only counts the open transactions. An offline database has no sessions to close: the option is greyed ("An offline',
    'database has no connections to close.") and its Delete runs no SINGLE_USER. Without VIEW SERVER STATE (or with VIEW',
    'SERVER PERFORMANCE STATE denied on SQL Server 2022 and later) the dialog counts and lists no sessions, since SQL Server',
    'shows such a login only its own, and the database\'s owner still describes, scripts and deletes it: the transaction DMVs',
    'that find sessions using the database from elsewhere are read only with the permission.',
    '',
    'Once a database is deleted (or its DROP completed before a later step failed), each Database Properties document on it',
    'turns orphan: what it showed stays, read-only, under "This database no longer exists on <server>." with Close and no',
    'Refresh, and a toast counts the query windows that were using it ("3 query windows were using SalesDb."), which stay open.',
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
    '### Steps, compensation and cleanup',
    '',
    'Each statement is a step, and the reply lists them in order with a status (done, failed, cancelled, skipped or rolledBack), a title, SQL',
    'Server\'s message for a failed one, and for some a detail (a name) or progress. The first failure stops the rest, which are',
    'skipped. An action may also plan compensation steps, each undoing one earlier step once that step completed and a later one',
    'failed or was stopped (restoring a database\'s user access after a failed rename, for example), and cleanup steps that run',
    'after any failure or Stop (removing a partly restored database Varia created). They run on the same connection under a fresh',
    'budget (`cleanupMs`), are listed only when they ran, marked as compensating, and the error message says how they ended. A',
    'Stop\'s reply waits for SQL Server to end the statement and then for them, so it never reports an unknown outcome while',
    'Varia\'s own cleanup runs. An action can instead run its steps in one transaction (the table designer\'s Save): a failure or',
    'Stop rolls it back, and only the commit, which Stop no longer reaches, completes it. The steps that had completed are then',
    'listed as rolledBack, never done, and the message names none as completed; a step that checks the server again before it',
    'changes anything (Unlock\'s recheck) can refuse with the action\'s own message, and then nothing is said to be rolled back.',
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
    'query window still uses the database) would lose it; Script Action shows the order Varia runs. When the DROP fails or is',
    'stopped after Close existing connections set single-user mode, a compensation step restores the access the database had',
    '(Restore multi-user access, or Restore restricted user access), so a failed delete never leaves it single-user.',
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
      ['Deny or Grant permission to connect', '`DENY CONNECT SQL TO [login]`, `GRANT CONNECT SQL TO [login]`'],
      ['Drop the database user', '`DROP USER [user]`, in its database'],
      ['Add to a server role (New Login)', '`ALTER SERVER ROLE [role] ADD MEMBER [login]`'],
      ['Create a user (User Mapping)', '`CREATE USER [user] FOR LOGIN [login]`, in its database'],
      ['Set the default schema (User Mapping)', '`ALTER USER [user] WITH DEFAULT_SCHEMA=[schema]`, in its database'],
      ['Create a schema (User Mapping)', '`CREATE SCHEMA [schema] AUTHORIZATION [user]`, in its database, in a batch of its own'],
      ['Add to a database role (User Mapping)', '`ALTER ROLE [role] ADD MEMBER [user]`, in its database']
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
    'The backend\'s login preflight reads the facts an action needs in the action\'s own connection from catalog views only:',
    'never a password hash, which no Varia statement may name, and `LOGINPROPERTY`, which waits on a login another session',
    'is changing whatever the isolation level, only in the lock-out read of Unlock and Login Properties below.',
    '',
    '### Disable, Enable and Rename',
    '',
    'Disable and Enable are inline actions in a login\'s menu after Copy Name, one of them at a time: a disabled login offers',
    'Enable. Each runs at once as a status-bar job with Stop, from the server\'s master database, and then Object Explorer',
    'reselects the login with its new state. Both first read the login\'s facts (`actions.describe` with `loginFacts`, in the',
    'action\'s own connection, under READ UNCOMMITTED so that another session\'s open change to the login cannot hold it back;',
    'meanwhile the status bar says "Disabling app_user: Reading the login…" with Stop, and a second request for the login',
    'says why it waits). Disable then asks (A13 `disableLogin`): the prompt counts the sessions connected as the login, which',
    'stay connected, warns when it is a member of sysadmin, names the service that runs as it (from',
    '`sys.dm_server_services`, or an `NT SERVICE\\` name), and names Varia\'s other connections that sign in as it. Enable',
    'asks nothing; its notice says when permission to connect is still denied. The statement itself waits behind such a',
    'change, as SSMS\'s does, until Stop. The facts only advise, since they read past other sessions\' open changes, but the',
    'request names the login they describe (its SID and creation time): when another login has taken the name since,',
    'the backend refuses before any statement ("Refresh Object Explorer and try again"). Before Disable, Enable and Rename',
    'run, the preflight reads only the login\'s own rows, never what it owns, so another session\'s open change to other',
    'logins (a New Login in its transaction) holds back neither it nor Script Action.',
    '',
    'Rename uses Object Explorer\'s inline box, as for a table. A SQL Server login\'s name cannot hold a backslash: "' + loginMessages.sqlBackslash + '"',
    'SQL Server would refuse it (15021). No login may take a name in SQL Server\'s own form: "' + loginMessages.systemName + '"',
    'SQL Server would accept it, and Varia would then take the login for one of SQL Server\'s own. The box stays open with',
    'either message, which leaves the banner when the box closes. The backend refuses a name another login or server role',
    'uses (`NAME_IN_USE`). A notice says database users mapped to the login keep their names, and a warning names Varia\'s',
    'other connections that sign in under the old name.',
    '',
    table(['Action', 'Step', 'As Script Action writes it'], [
      ['Disable', 'Disable the login', '`ALTER LOGIN [login] DISABLE`'],
      ['Enable', 'Enable the login', '`ALTER LOGIN [login] ENABLE`'],
      ['Rename', 'Rename', '`ALTER LOGIN [login] WITH NAME=[new]`']
    ]),
    '',
    '### Delete',
    '',
    'Delete opens Delete Object, as for a table, with the login\'s row (Object Type Login). Its describe reads the login\'s',
    'facts past other sessions\' open changes (READ UNCOMMITTED: they only advise), then the database users mapped to its SID:',
    'one read per online database (no snapshots) the connection can enter and see the users of (VIEW DEFINITION), each under',
    `the lock timeout, at most ${loginLimits.scanDatabases.toLocaleString('en-US')} databases within ${(loginLimits.scanMs / 1000).toLocaleString('en-US')} s. A database it does not reach (offline, restoring,`,
    'not accessible or readable, a failed read, or past the bound or budget) counts as not checked, and the page says how',
    'many; the server\'s total is read on its own, so a connection that may read no database is told it checked none, never',
    `that no user is mapped. The page lists at most ${loginLimits.mappedUsers.toLocaleString('en-US')} users, each as "database: user" ("…and n more" after them), and`,
    'marks the ones a Delete keeps with why: those whose DROP USER would fail (a schema, role or other securable it owns, a',
    'permission it granted, 15138, 15421, 15183 and 15284), in a read-only database, or where the connection may not drop users',
    '(ALTER ANY USER).',
    '',
    `SSMS deletes the login and says afterwards that its users are left orphaned; Varia says it first: "${loginDeleteText.orphanNote}"`,
    `It offers "${loginDeleteText.dropOption}" (unchecked), greyed with its reason when no user is mapped, every`,
    'listed user is kept, more are mapped than it lists, or the connection cannot count the login\'s sessions (without VIEW',
    'SERVER STATE a session would fail the login\'s DROP after its users were gone). SSMS\'s note shows only where a user may be',
    'left orphaned. With the option, Delete drops each user it may in its database, then the login in master; the steps name',
    'each user ("user in database"). The statements are not one transaction (DROP USER in several databases would hold all of',
    'them until the end), and every partial outcome is coherent: a user dropped and the login kept. After a user was dropped,',
    'the loaded Users folders of those databases reload, and after a failure or Stop the page reads the login again, so it lists',
    'only the users still mapped.',
    '',
    'The warnings name what SQL Server refuses the DROP for, with the warning icon: the sessions connected as the login (15434;',
    'Activity Monitor can end them), the databases it owns (15174), its SQL Server Agent jobs (15170), the server roles,',
    'endpoints and availability groups it owns (15141) and the server permissions it granted to others (15173); the service',
    'that runs as a Windows login is a note, with the info icon. OK still runs, and the backend refuses any of these before a',
    'statement runs. A Windows group\'s members sign in under their own SIDs, so a group counts no sessions. The',
    'protected-principal rules grey OK with their reason, drawn as an error (sa, the login this connection uses, SQL Server\'s',
    'own logins, the permissions); Script Action still works and runs nothing. Varia\'s other connections that sign in as the',
    'login are named as warnings: their pools\' sessions fail the DROP until they are disconnected, and Activity Monitor neither',
    'shows nor ends Varia\'s own sessions. The execute needs the login it read (its SID and creation time) and reads the login',
    'again under READ COMMITTED: a login that took the name since is refused. With its users, it also refuses, before any',
    'DDL, a login whose sessions it cannot count (`NOT_SUPPORTED`) and a database its own scan could not read again (`BLOCKED`,',
    'retryable), whose users would stay orphaned. Each DROP checks, in its own batch, the principal it was planned for: a user',
    'by its name and the login\'s SID, the login by its SID, principal id and creation time, again after the DROP in one',
    'transaction, so a user renamed or remapped in an open transaction while the scan read past it, or a login dropped and',
    'created again while an earlier step waited, is never dropped in their stead (`NOT_FOUND`). When a session the preflight',
    'could not count (without VIEW SERVER STATE) fails the DROP, `IN_USE` says to end it first.',
    '',
    table(['Action', 'Step', 'As Script Action writes it'], [
      ['Delete, with the users', 'Drop the database user (one per user; its detail "user in database")', '`DROP USER [user]`, in its database'],
      ['Delete', 'Drop the login', '`DROP LOGIN [login]`, in master']
    ]),
    '',
    'SQL Server\'s errors for logins map to the codes below; without ALTER ANY LOGIN, `PERMISSION_DENIED` also says what',
    'changing a login needs. SQL Server\'s own logins (`##…##`, trailing spaces ignored as SQL Server ignores them) are',
    'refused by the backend as system objects, whatever the page asks: the preflight judges the principal the server',
    'collation finds by the name the catalog holds, and the statement names exactly that principal, so no other spelling',
    '(a trailing space, a fullwidth `＃`) reaches one of them. A greyed verb\'s reason (a Windows group\'s Disable, SQL',
    'Server\'s own logins) is its hint in the command palette.',
    '',
    '### Unlock',
    '',
    'SSMS unlocks a SQL Server login only on Login Properties › Status, and only with a new password. Varia adds Unlock… to a',
    'SQL Server login\'s menu (after Disable or Enable, access key U), a modal with two choices (owner decision 9).',
    `"${unlockChoiceText.setPassword}", SSMS's way, is the default: OK, named "${unlockHandOffLabel}", closes the dialog and opens`,
    'Login Properties on the same login with Login is locked out cleared, where a new password unlocks it (`UNLOCK`). It sends',
    `nothing itself, so its Script says "${noScriptNotice}" It also unlocks a login that must change its password.`,
    `"${unlockChoiceText.keepPassword}" keeps the current password, as Microsoft documents: it turns the password policy off, which`,
    'unlocks the login, and back on, with password expiration when the login had it, in one transaction, so a failure or Stop rolls',
    'both back. This clears the login\'s password history, which the dialog says; only the user chooses it.',
    '',
    'Only `LOGINPROPERTY` knows whether a login is locked out, so the listing offers Unlock… on every SQL Server login and the',
    'dialog says. Its describe (`unlockLogin`) and its preflight read the login\'s facts and then its lock-out state with',
    '`ActionSql.LoginLock`, the only Varia statement that may call `LOGINPROPERTY`: of the login the preflight found, and only',
    'for ' + loginLockProperties.map(code).join(', ') + ', which its own lint checks. Behind another session\'s open',
    'change to the login the describe gives up after the read lock timeout (`BLOCKED`); the preflight waits, as the statements',
    'after it would, until Stop. OK is greyed, with the reason on the page, for a login that does not enforce the password',
    `policy ("${loginMessages.unlockNoPolicy}"), one that must change its password at its next sign-in, whose policy SQL Server`,
    `will not turn off (15128: "${loginMessages.unlockMustChange}"), and one that is not locked out ("${loginMessages.notLocked}"),`,
    'which the preflight checks again before any statement. Script Action still writes the transaction for a login that is',
    'not locked out now. Catalog views and `LOGINPROPERTY` hold no lock on the login (a read in an open transaction, even',
    'SERIALIZABLE, does not block another session\'s `ALTER LOGIN`), so the first step reads the login\'s facts and lock-out',
    'state again inside the transaction, after any wait, and changes nothing when the login is gone, replaced, refused or no',
    'longer locked out, or when another session changed its policy or expiration since the plan was made',
    `("${loginMessages.unlockChanged}"); only a change in the moment between that read and the first statement goes unseen.`,
    'On success Object Explorer reloads the Logins folder and a notice says "Unlocked the login app_user.',
    'Its password history was cleared."',
    '',
    table(['Step', 'As Script Action writes it'], [
      ['Turn off the password policy', '`ALTER LOGIN [login] WITH CHECK_POLICY = OFF;`'],
      ['Turn the password policy back on', '`ALTER LOGIN [login] WITH CHECK_POLICY = ON;`'],
      ['Turn the password policy and expiration back on', '`ALTER LOGIN [login] WITH CHECK_POLICY = ON, CHECK_EXPIRATION = ON;` (when expiration was on)'],
      ['Commit', 'the batch is `SET XACT_ABORT ON; BEGIN TRANSACTION;`, both statements, then `COMMIT TRANSACTION;`']
    ]),
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
    '',
    ...newLoginDocs(),
    ...loginPropertiesDocs()
  ]
}

/** New Login (D2a, D2b): where it opens, its pages, the password path, User Mapping, its Script and how it runs. */
function newLoginDocs(): string[] {
  const spec = dialogSpecs.newLogin
  return [
    '### New Login',
    '',
    `Security › New › Login…, and New Login… on the Logins folder and on a login, open "${spec.title}", a modal dialog with the pages`,
    `${spec.pages.map(page => page.title).join(', ')} (Securables follows once its OK works). Its action is \`createLogin\`, on`,
    `${createActionSpecs.createLogin.engines.map(engine => engineNames[engine]).join(', ')} (Managed Instance follows); its target is the server.`,
    '',
    '- **General**: Login name; Windows authentication (DOMAIN\\name) or SQL Server authentication (the default when the server',
    '  runs on Linux) with Password, Confirm password, Specify old password (greyed: Login Properties only), Enforce password',
    '  policy, Enforce password expiration and User must change password at next login, each greyed unless the one before it',
    '  is checked (SQL Server refuses MUST_CHANGE without CHECK_EXPIRATION, 15099, and CHECK_EXPIRATION without CHECK_POLICY,',
    '  15122); Default database and Default language (`<default>`: no DEFAULT_LANGUAGE clause). A note says when the server',
    `  takes Windows authentication only, and when this login may lack ALTER ANY LOGIN. A blank password needs the password policy on.`,
    '- **Server Roles**: every server role, public checked and greyed (every login is a member).',
    '- **User Mapping**: the grid "Users mapped to this login:" (Map, Database, User, Default Schema), one row per database New Login',
    '  listed, virtualized; a database that is not online, not open to this login, or read-only (set READ_ONLY, a log-shipping',
    '  standby or a database snapshot, where CREATE USER would fail after CREATE LOGIN had run) shows its state chip (or NO ACCESS,',
    '  READ-ONLY) and cannot be mapped. Map fills User with the login name; a User or Default Schema that equals the login name',
    '  follows a rename, on unmapped rows too, but a blank one stays blank: a blank User shows and sends the login name, and a blank',
    '  Default Schema leaves the clause out (typing the name after checking Map never sets one). The … button (and Alt+Down) opens Select Schema, the database\'s schemas. Below it,',
    '  "Guest account enabled for:" the selected database (read-only, as in SSMS) and "Database role membership for:" it: public',
    '  checked and greyed, the others enabled once its row is mapped. The keys are the grid\'s: arrows, Home/End, Page Up/Down,',
    '  Space toggles Map, F2 or Enter or typing edits User or Default Schema, Enter or Tab commits, Escape ends the edit only.',
    `  Selecting a database reads its roles, schemas and guest state once (\`actions.describe\` with dialog \`${loginDatabaseRolesDescribe}\`,`,
    '  on the action\'s read connection, inside the database through sp_executesql; a newer selection cancels a read still',
    `  running); at most ${loginLimits.roles} roles and ${loginLimits.schemas.toLocaleString('en-US')} schemas are listed, and ${loginLimits.mappings} databases mapped.`,
    '- **Status**: Permission to connect to database engine (Grant, Deny) and Login (Enabled, Disabled).',
    '',
    'The password fields are masked, never reach the dialog\'s snapshot, React state that is saved, AutoRecover, a toast or a log, and',
    'are cleared when the dialog closes, the server disconnects or OK succeeds. The password travels only in `actions.execute`, which is',
    'sensitive as a whole (its frames are zeroed on both sides once used); `actions.script` refuses one in main and in the backend.',
    `In SQL it is one nvarchar(${loginLimits.password}) parameter, read once inside a constant batch:`,
    '`N\' WITH PASSWORD=N\'\'\' + REPLACE(@password COLLATE Latin1_General_BIN2, N\'\'\'\', N\'\'\'\'\'\') + N\'\'\'\'`; the binary collation keeps',
    'U+FF07 from being doubled too. A lint pins that form. The fields take one character more than the limit, so a longer pasted',
    `password is refused ("${newLoginMessages.tooLong}") rather than cut short. The backend replaces the password (and an old`,
    'one) with `<password>` in SQL Server\'s own error and message text: where SQL Server quotes it (in single or double quotes, as',
    'typed or with its quotes doubled), and, from 8 characters, anywhere. A shorter password could be part of SQL Server\'s words, and',
    'Varia\'s own sentences never hold it.',
    '',
    'Script Action never carries or writes the password: a SQL Server login\'s script is one batch in one `SET XACT_ABORT ON` transaction',
    `under the comment "${passwordScriptHeader}", with \`PASSWORD=<password>\` unquoted, so an unedited script fails to parse and runs`,
    'nothing (no later statement can give a role to an existing login of that name). A Windows login\'s script is SSMS\'s, one statement',
    'per batch. Each mapped database\'s statements run there through `EXEC [database].sys.sp_executesql N\'…\'` inside that transaction',
    '(a Windows login\'s script uses `USE [database]` and `GO` as SSMS does); Script reads the server only when a Default Schema is',
    'chosen, to learn whether the database has it (SSMS\'s CREATE SCHEMA), and never refuses a name.',
    '',
    'OK runs SSMS\'s statements in SSMS\'s order, one by one: `CREATE LOGIN`, `DENY CONNECT SQL` (Deny), `ALTER LOGIN … DISABLE`',
    '(Disabled), then `ALTER SERVER ROLE … ADD MEMBER` per role by name, then per mapped database by name, in it: `CREATE USER … FOR',
    'LOGIN`, `ALTER USER … WITH DEFAULT_SCHEMA=` when one is chosen, `CREATE SCHEMA … AUTHORIZATION` the user when the database',
    `lacks it, and \`ALTER ROLE … ADD MEMBER\` per role by name (at most ${actionLimits.statements} statements in all, or OK and Script refuse:`,
    `"${tooManyStatementsMessage(actionLimits.statements)}"). They do not share a transaction (critic A24, owner decision`,
    '6): on SQL Server 2025 an open transaction holding `CREATE LOGIN` keeps out every SQL Server login whose security token is not',
    'cached (one that has not signed in since the server started) until it ends, and one holding a server role membership change',
    'keeps out every SQL Server login, so one statement waiting for a lock would lock users out. A live check signs in four such',
    'logins while New Login waits before each later statement, and shows both blocks with transactions it rolls back.',
    'A failure or Stop after `CREATE LOGIN` leaves what completed, and the message starts with the login\'s real state: "The login was',
    'created, but the steps after it did not all complete.", then "It can connect: permission to connect was not denied." when Deny',
    `did not apply, "It is enabled." when Disabled did not, "Not every server role was added." when a role is missing, and "Not every database was mapped as chosen." when a mapping step is, so the clip`,
    'at the message limit cuts the list of completed steps, never that. When Stop reaches SQL Server as `CREATE LOGIN` completes, the',
    'backend looks for the login within the cleanup budget; if it exists, that step is done and the message says so. Either way the',
    'dialog reloads Logins and selects the login, as after OK, and stays open with the error.',
    'Before anything runs, the preflight refuses a name a login or server role already has (`NAME_IN_USE`) and a',
    'login without ALTER ANY LOGIN (`PERMISSION_DENIED`); then, per mapped database, one that is gone (`NOT_FOUND`), not online,',
    'not open to this login or read-only (`DATABASE_UNAVAILABLE`), a user name a user or role there already has (`NAME_IN_USE`) and a',
    'role it lacks (`NOT_FOUND`). Two cases are not caught before `CREATE LOGIN` runs, so they end as a partial run: an availability',
    'group\'s readable secondary (its role is only in a DMV that needs VIEW SERVER STATE), which fails `CREATE USER` as read-only, and a',
    'Windows login whose SID already has a user under another name in the database (an orphan, often after a restore from another',
    'server in the domain), which fails it with 15063; resolving a Windows SID before the login exists would mean asking the domain',
    'from the preflight. The server\'s password policy answers `PASSWORD_POLICY` (15114 to 15118),',
    'which keeps the dialog open with its password; 15025 and 15023 are `NAME_IN_USE`, 15010, 15033 and 15401 `NOT_FOUND`, and 15099,',
    '15122, 15006, 15407 and 37525 `NOT_SUPPORTED`. After OK the server\'s Logins folder, once Object Explorer has listed it, reloads and selects the new login,',
    'and each mapped database\'s Users folder that Object Explorer has listed reloads (after a partial run too).',
    '',
    'Whether a server-side trace or Extended Events session can read the password from the RPC (critic A16) is checked by an opt-in live',
    'check (`VARIA_TEST_SQL_XE=1`, set only for CI\'s disposable SQL Server container; it first checks, read-only, that every event,',
    'field, action and predicate it uses exists on the server): it records `rpc_starting`, `rpc_completed`,',
    '`sql_batch_starting`, `sql_batch_completed` and the statement-level events (statements, batch text, data streams and output',
    'parameters) in a scratch session while New Login creates a login, Create Catalog\'s master key batch runs and Login Properties',
    'changes a scratch login\'s password with Specify old password (`@password` and `@old_password`), and fails if any of their',
    'passwords appears in any field, as text, doubled quotes, XML-escaped or UTF-16 bytes. Each run counts only once the session has',
    'recorded that run\'s own RPC (its constant batch text, or SQL Server\'s notice that it hid the statement), polled for on the',
    'ring buffer rather than awaited for a fixed time. Developers\' servers never run it (owner decision 14). It has not run yet:',
    'D2a does not merge until it has run once on a disposable server and its result is recorded here (critic A16).',
    ''
  ]
}

/** Login Properties (D2c): its describe, pages, password path, Script and how it runs. */
function loginPropertiesDocs(): string[] {
  const spec = dialogSpecs.loginProperties
  return [
    '### Login Properties',
    '',
    `Properties on any login (SQL Server's own and sa included, as in SSMS) opens "${spec.title} - <name>", a modal dialog with New Login's pages`,
    `${spec.pages.map(page => page.title).join(', ')} on the existing login. Its action is \`loginProperties\` (a kind action of logins), on`,
    `${kindDialogActionSpecs.loginProperties.engines.map(engine => engineNames[engine]).join(', ')} (its ALTER LOGIN on Managed Instance is unverified). SQL Server's own logins open but OK`,
    `is greyed: "${loginMessages.system}"`,
    '',
    'Its describe (`actions.describe` with dialog `loginProperties`) reads, in master on the describe\'s connection: the login\'s facts',
    '(as Disable reads them), its default database and language and the server roles it is a member of, a SQL Server login\'s',
    'lock-out state through `ActionSql.LoginLock` (as Unlock reads it), New Login\'s lists, and the users mapped to its SID through',
    `Delete's per-database scan (at most ${loginLimits.scanDatabases.toLocaleString('en-US')} databases within ${(loginLimits.scanMs / 1000).toLocaleString('en-US')} s). A database the scan did not read shows "${loginPropertiesMessages.notRead}" in`,
    `User and cannot be mapped until it is selected ("${loginPropertiesMessages.notReadHint}"): selecting a database reads it with the`,
    `login (\`${loginDatabaseRolesDescribe}\` with \`login\`), answering the user mapped to it there and that user's database roles.`,
    'A database not read yet is muted in the grid, and its cell says why through `aria-describedby`. SQL Server\'s own logins say on',
    'every page why they never change, and every page\'s controls are greyed.',
    '',
    `- **General**: Login name and its authentication read-only; Password and Confirm password blank ("${loginPropertiesMessages.keepPassword}"`,
    '  SSMS fills them with a fake value); Specify old password and Old password (checked already when the login is this connection\'s',
    '  and the connection cannot alter any login, since SQL Server then asks for it, unless the login is locked out, where SQL Server',
    `  refuses the old password: "${loginPropertiesMessages.lockedOldPassword}"); the policy options; User must change password`,
    '  at next login only once a new password is typed, and never for the login this connection uses, whose new sessions SQL Server',
    `  would then refuse ("${loginMessages.ownMustChange}"); Default database and Default language (no \`<default>\`: SMO's ALTER for it`,
    '  is unverified). Login name reads as text in a frame; the kind of login shows under the authentication only when the two',
    '  choices do not say it (a group, a certificate, a key, Microsoft Entra).',
    '- **Server Roles**: the login\'s memberships checked; public checked and greyed.',
    '- **User Mapping**: New Login\'s grid with the mapped users filled in. Unchecking Map unmaps (DROP USER; Script and the steps',
    `  warn "${loginPropertiesMessages.dropsUser('user', 'database')}"), a new user name renames, and the database owner's dbo cannot change`,
    `  ("${loginPropertiesMessages.owner}").`,
    `- **Status**: Permission to connect to database engine, Login (Enabled, Disabled) and "${loginPropertiesMessages.locked}", checked while the`,
    `  login is locked out and enabled then to clear it, which needs a new password ("${loginPropertiesMessages.unlockNeedsPassword}"), or to`,
    '  check it again. Deny and Disabled are greyed for the login this connection uses, and Disabled for a Windows group, with the',
    '  reason beside them. Opened from Unlock\'s hand-off (Login is locked out cleared), the dialog puts focus in Password, whose',
    '  first note then says a new password unlocks the login.',
    '',
    'Disabled or Deny asks first, with the Disable verb\'s message box (owner decisions 4 and 7; its button reads Deny for Deny), when',
    'someone would be locked out: sessions connected as the login, a service that runs as it, or Varia\'s other connections that sign',
    'in as it. With none of those it asks nothing, as SSMS. Cancel sends nothing.',
    '',
    'OK and Script send only what differs from the describe, bound to the login it read (its SID and creation time; a login',
    'recreated since is `NOT_FOUND`). Each statement OK runs is bound too: in a transaction of its own, a check that the login (by',
    'name, SID, principal_id and create_date) or the user (by name and the login\'s SID, in its database) is still the one the',
    'preflight read, the statement, then the check again (`ActionSql.LoginBinding`, `UserBindingCall`); a principal replaced meanwhile',
    'fails that step with `NOT_FOUND` and changes nothing. The passwords join only OK\'s request, as in New Login (masked, never in the snapshot, cleared',
    'with the dialog): the new one as `@password`, the old one as `@old_password` when Specify old password is checked, each one',
    'nvarchar parameter read once and quoted by a binary-collation REPLACE, which the lint pins. T-SQL takes either `OLD_PASSWORD`',
    'or `UNLOCK` and `MUST_CHANGE`, never both. Script never carries a password: with a password change it is one `SET XACT_ABORT ON`',
    `batch under "${passwordScriptHeader}", \`PASSWORD=<password>\` (and \`OLD_PASSWORD=<old password>\`) unquoted, so it`,
    'runs nothing unedited; without one it is SSMS\'s form, a `GO` after each statement.',
    '',
    'OK runs SSMS\'s statements in SSMS\'s order, one by one and without a transaction, as New Login does (critic A24): the options\'',
    '`ALTER LOGIN` (only the changed clauses), the password\'s `ALTER LOGIN`, `GRANT` or `DENY CONNECT SQL`, `ENABLE` or `DISABLE`, each',
    'server role by name, then per changed database by name: `DROP USER` (in a batch that checks the user is still the one mapped to',
    'the login\'s SID), or `CREATE USER … FOR LOGIN` or `ALTER USER … WITH NAME`, then its default schema (and `CREATE SCHEMA` when the',
    'database lacks it) and each database role. Before any of them the preflight refuses a changed database that is gone, offline,',
    'closed or read-only, a user that is no longer the one mapped, a name in use and a missing role. A failure or Stop after a step',
    'leaves what completed; the message starts "The login was changed only in part: its steps run one by one, as in SSMS, and list',
    'what completed.", and the dialog reads the login again, then User Mapping\'s databases one at a time; until each is read again,',
    `OK refuses its changed row ("${loginPropertiesMessages.readAgain('<database>')}"). When the password step completed before the`,
    `failure, the password fields are emptied, so a retry never sends it again ("${loginPropertiesMessages.passwordApplied}").`,
    'SQL Server answers a wrong old password, and a missing permission,',
    `with 15151 (\`PERMISSION_DENIED\`): the message adds "${loginPropertiesMessages.oldPasswordAdvice}" when the password step failed with an old`,
    'password, else what changing a login needs. Permissions are left to SQL Server, since a login may change its own password',
    '(with the old one) and defaults. SQL Server refuses DROP USER for a user that owns a schema (15138), as in SSMS.',
    '',
    'A password change of a login that Varia\'s connections sign in as (this one or others, by SQL Server authentication) gives them',
    'the new password in the backend\'s memory, so their next sessions sign in; a password Varia remembers for them is not changed,',
    `and a notice says so: "${loginPropertiesMessages.connectionsPassword('<login>')}"`,
    '',
    `Refused before anything runs: the login this connection uses denied, disabled or made to change its password at its next sign-in`,
    `("${loginMessages.ownStatus}"; "${loginMessages.ownMustChange}"), a`,
    `Windows group disabled ("${loginMessages.windowsGroupDisable}"), and a password or policy change on a login that is not a SQL`,
    `Server login ("${loginMessages.propertiesNotSql}"). After OK the Logins folder and each changed database's Users folder reload.`,
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
