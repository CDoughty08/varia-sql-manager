// Renders docs/object-actions.md from the actions catalogue; tests/object-actions-catalog.test.ts keeps the file in sync.
import { kindSpecs, nodeKinds, type NodeSubtype } from '../explorer/catalog.ts'
import {
  actionCommandEntries, actionContextKey, actionErrorCodes, actionErrorRetryable, actionKindSpecs, actionLimits, actionRow, dialogIds, dialogSpecs, objectActions, objectActionSpecs,
  scriptActionTitles, unknownOutcomeMessage
} from './catalog.ts'
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
  statusDelayMs: 'How long a rename runs before the status bar shows it with Stop, in ms'
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
    table(['Action', 'Menu title', 'Command', 'Kind', 'Group', 'Mnemonic', 'Windows and Linux', 'macOS', 'Context key'], objectActions.map(action => {
      const spec = objectActionSpecs[action]
      return [code(action), spec.title, code(spec.command), spec.class + (spec.dialog ? ` (${code(spec.dialog)})` : ''), `${code(spec.group)} ${spec.order}`, spec.mnemonic, keys(action, false), keys(action, true), code(actionContextKey(action))]
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
    '## Dialogs',
    '',
    table(['Dialog', 'Title', 'Action', 'Pages'], dialogIds.map(dialog => {
      const spec = dialogSpecs[dialog]
      return [code(dialog), spec.title + (spec.titleFormat === 'withName' ? ' - <name>' : ''), code(spec.action), spec.pages.map(page => page.title).join(', ')]
    })),
    '',
    `The Script button scripts to a new query window; its arrow lists ${Object.values(scriptActionTitles).join(', ')}. Script never runs anything.`,
    'OK runs the action; Cancel reads Stop while it runs, and Stop cancels the statement in SQL Server.',
    '',
    'Delete Object for a database also offers "Delete backup and restore history information for databases" (checked,',
    'greyed for a snapshot) and "Close existing connections" (unchecked), as SSMS does. OK in the dialog is the only',
    'confirmation.',
    '',
    ...databasePropertiesDocs(),
    '## SQL',
    '',
    'DDL runs on its own unpooled connection (the program name plus " - Object Actions"), never Object Explorer\'s or',
    'scripting\'s pools, after a preflight in the same connection that finds the object again, re-derives its subtype and',
    'checks permissions and name collisions. Statements are built by SQL Server from constant text: names are nvarchar(128)',
    'parameters passed through `QUOTENAME`. DDL waits for locks without a timeout, as SSMS does, and Stop is always',
    'available: the dialog\'s Stop, or the status bar\'s Stop for a rename. A stopped action answers once SQL Server has',
    'ended the statement, with each step done, cancelled or skipped, so the dialog says what completed before Stop.',
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
    'Database Properties opens on General (read-only facts: backups, name, status, owner, date created, size, space available,',
    'number of users, memory-optimized memory and collation). Files and Filegroups list the database\'s files and',
    'filegroups read-only in this version; Owner on the Files page is editable. Options shows Collation, Recovery model,',
    'Compatibility level and Containment type above SSMS\'s property grid. OK and Script send only the values that changed,',
    `as SSMS does; Script with nothing changed says "${noScriptNotice}" A snapshot, a database that is not online or`,
    'not accessible, a database the login may not ALTER, and Azure SQL Managed Instance open read-only with a note.',
    'Compatibility level is greyed for a login outside sysadmin (SSMS ignores the change silently), and Containment type',
    `when the server's contained database authentication is off. The owner of ${ownerNotOn.join(', ')} cannot change.`,
    'On a read-only database only Database Read-Only and Restrict Access change, and the owner is greyed. Turning Database',
    'Read-Only on cannot share an OK with a change SQL Server applies after it and refuses on a read-only database (the',
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
    `When OK changes an exclusive option and the database has sessions (or they cannot be counted), Varia asks "${openConnectionsPrompt.message}"`,
    `(${openConnectionsPrompt.buttons.join(' or ')}; ${openConnectionsPrompt.buttons[openConnectionsPrompt.defaultId]} is the default, because Yes rolls back the other sessions' transactions, and Escape answers No).`,
    'No runs nothing. Yes writes the SET options WITH ROLLBACK IMMEDIATE. SSMS counts the connections when OK is pressed, so',
    'the backend counts them again before anything runs: when sessions have joined since the dialog opened with none, it',
    'answers `IN_USE` at once and the dialog asks. The backend first closes its own idle pooled connections in the database',
    'and, because SQL Server lists their sessions for a few milliseconds after that, counts again every 50 ms for up to a',
    'second while the count is above zero. Without the prompt, WITH NO_WAIT makes SQL Server refuse (`IN_USE`)',
    'rather than wait for the other sessions\' transactions; SQL Server gives up after about 20 seconds. That failure advises',
    'choosing Yes only after an exclusive change made without closing connections; otherwise (Broker Enabled or Containment',
    'type with other sessions, which SSMS does not close connections for) it advises closing them first. Script never',
    'asks: it always writes WITH NO_WAIT, as SSMS does.',
    ''
  ]
}
