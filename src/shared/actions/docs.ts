// Renders docs/object-actions.md from the actions catalogue; tests/object-actions-catalog.test.ts keeps the file in sync.
import { kindSpecs, nodeKinds, type NodeSubtype } from '../explorer/catalog.ts'
import {
  actionCommandEntries, actionContextKey, actionErrorCodes, actionErrorRetryable, actionKindSpecs, actionLimits, actionRow, dialogIds, dialogSpecs, objectActions, objectActionSpecs,
  scriptActionTitles, unknownOutcomeMessage
} from './catalog.ts'

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
  scriptChars: 'Characters in a script',
  newName: 'UTF-16 code units in a new name (used verbatim, never trimmed)',
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
  const names: Readonly<Record<string, string>> = { f2: 'F2', delete: 'Delete', 'mod+backspace': '⌘⌫' }
  const keys = (action: typeof objectActions[number], mac: boolean) => {
    const bindings = commands[objectActionSpecs[action].command].keybindings ?? []
    return bindings.flatMap(binding => { const spec = mac ? binding.mac ?? binding.key : binding.win ?? binding.key; return spec ? [names[spec] ?? spec] : [] }).join(', ') || '—'
  }
  return [
    '# Object actions',
    '',
    '<!-- Generated from src/shared/actions/catalog.ts. Regenerate with: npx vitest run tests/object-actions-catalog.test.ts -u -->',
    '',
    'Object Explorer\'s actions on objects: Select Top 1000 Rows, Rename and Delete. Which kinds and subtypes offer each is',
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
    '',
    '## Object kinds',
    '',
    '✓ enabled, ○ shown greyed, – not offered.',
    '',
    table(['Kind', 'Subtypes', ...objectActions.map(action => objectActionSpecs[action].title)], kindRows()),
    '',
    '## Dialogs',
    '',
    table(['Dialog', 'Title', 'Pages'], dialogIds.map(dialog => [code(dialog), dialogSpecs[dialog].title, dialogSpecs[dialog].pages.map(page => page.title).join(', ')])),
    '',
    `The Script button scripts to a new query window; its arrow lists ${Object.values(scriptActionTitles).join(', ')}. Script never runs anything.`,
    'OK runs the action; Cancel reads Stop while it runs, and Stop cancels the statement in SQL Server.',
    '',
    'Delete Object for a database also offers "Delete backup and restore history information for databases" (checked,',
    'greyed for a snapshot) and "Close existing connections" (unchecked), as SSMS does. OK in the dialog is the only',
    'confirmation.',
    '',
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
