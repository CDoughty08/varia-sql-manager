// Renders docs/scripting.md from the scripting catalogue and options; tests/scripting-catalog.test.ts keeps the file in sync.
import { kindSpecs, nodeKinds, type NodeKind, type NodeSubtype } from '../explorer/catalog.ts'
import {
  scriptAsTitles, scriptCommandId, scriptDestinations, scriptDestinationSpecs, scriptErrorCodes, scriptErrorRetryable, scriptKindSpecs, scriptLimits, scriptRow,
  scriptVerbs, scriptVerbSpecs, scriptVerbTitle, type ScriptRow
} from './catalog.ts'
import { scriptingOptionDefs, scriptingOptionGroupLabels, scriptingOptionGroups, type ScriptingOptionDef } from './options.ts'

// `<` outside code spans would start an HTML tag ("Script USE <database>").
const cell = (value: string) => value.replaceAll('|', '\\|').split('`').map((part, index) => index % 2 ? part : part.replaceAll('<', '&lt;')).join('`')
const row = (cells: readonly string[]) => '| ' + cells.map(cell).join(' | ') + ' |'
const table = (header: readonly string[], rows: readonly (readonly string[])[]) => [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n')
const code = (value: string) => '`' + value + '`'
const codes = (values: readonly string[]) => values.map(code).join(', ')
const yesNo = (value: boolean) => value ? 'Yes' : 'No'
const limitNotes: Readonly<Record<keyof typeof scriptLimits, string>> = {
  maxScriptChars: 'Characters in a script; a longer one fails with `TOO_LARGE`',
  maxDefinitionBytes: 'Bytes of a module definition, checked before SMO reads it',
  maxColumns: 'Columns a SELECT, INSERT or UPDATE template lists',
  maxParameters: 'Parameters an EXECUTE or function SELECT template lists',
  requestMs: 'Main\'s deadline for one request, in ms',
  budgetMs: 'The backend\'s budget for one request, in ms; then `TIMEOUT`',
  statementTimeoutS: 'Timeout of each SMO statement, in seconds',
  preflightTimeoutS: 'Timeout of the preflight query, in seconds',
  lockTimeoutMs: '`LOCK_TIMEOUT` of the scripting session, in ms; then `BLOCKED`',
  gatePerConnection: 'Requests scripting at once per server',
  gateTotal: 'Requests scripting at once in total',
  registered: 'Requests the backend tracks; more fail with `BUSY`',
  tombstones: 'Cancelled request ids remembered for requests that have not arrived yet',
  tombstoneMs: 'How long a cancelled request id is remembered, in ms',
  cancelIds: 'Request ids per cancellation',
  rendererJobs: 'Scripting operations a window runs at once',
  statusDelayMs: 'Delay before the status bar shows a running script, in ms',
  noticeMs: 'How long a notice stays in the status bar, in ms',
  warningNoticeMs: 'How long a warning notice stays, in ms',
  warnings: 'Warnings per result',
  warningChars: 'Characters in a warning',
  messageChars: 'Characters in an error message',
  prefsBytes: 'Bytes in `scripting-options.json`',
  fileNameChars: 'UTF-16 code units in a suggested file name'
}

const mark = (state: string | undefined) => state === 'enabled' ? '✓' : state === 'disabled' ? '○' : '–'
const rowCells = (scripted: ScriptRow) => [...scriptVerbs.map(verb => mark(scripted.verbs[verb])), scripted.modifiable ? '✓' : '–']
/** One line per kind and run of subtypes that script alike; deferred subtypes are listed after the table. */
function kindRows(kind: NodeKind): string[][] {
  const spec = scriptKindSpecs[kind]
  if (spec?.phase !== 'pr5') return []
  const groups = new Map<string, { subtypes: string[]; cells: string[] }>()
  for (const subtype of [undefined, ...kindSpecs[kind].subtypes ?? []] as (NodeSubtype | undefined)[]) {
    const scripted = scriptRow(kind, subtype, spec.parents?.[0])
    if (!scripted) continue
    const cells = [scriptAsTitles[scripted.title], ...rowCells(scripted), code(scripted.urn), code(scripted.preflight)]
    const key = cells.join('\n')
    const group = groups.get(key) ?? { subtypes: [], cells }
    group.subtypes.push(subtype ? code(subtype) : kindSpecs[kind].subtypes ? 'none' : '—')
    groups.set(key, group)
  }
  return [...groups.values()].map(group => [code(kind), group.subtypes.join(', '), group.cells[0], ...group.cells.slice(1)])
}
const deferred = () => nodeKinds.flatMap(kind => {
  const spec = scriptKindSpecs[kind]
  if (spec?.phase === 'later') return [code(kind)]
  if (spec?.phase !== 'pr5') return []
  return Object.entries(spec.subtypeVerbs ?? {}).filter(([, verbs]) => verbs === 'later').map(([subtype]) => `${code(kind)} (${code(subtype)})`)
})
const notScriptable = () => nodeKinds.filter(kind => !scriptKindSpecs[kind])
const parentNotes = () => nodeKinds.flatMap(kind => {
  const spec = scriptKindSpecs[kind]
  return spec?.phase === 'pr5' && spec.parents ? [`${code(kind)} below ${spec.parents.map(code).join(' or ')}`] : []
})
const moduleTypes = () => nodeKinds.flatMap(kind => {
  const spec = scriptKindSpecs[kind]
  return spec?.phase === 'pr5' && spec.objectTypes ? [`${code(kind)}: ${spec.objectTypes.join(', ')}`] : []
})

const defaultText = (def: ScriptingOptionDef) => def.type === 'boolean' ? (def.default ? 'True' : 'False') : def.values.find(item => item.value === def.default)!.label
function optionRows(group: string): string[][] {
  return (scriptingOptionDefs as readonly ScriptingOptionDef[]).flatMap((def, index) => {
    if (def.group !== group) return []
    const docs = def.type === 'boolean' && def.docsDefault !== undefined ? ` (docs page: ${def.docsDefault ? 'True' : 'False'})` : ''
    const values = def.type === 'enum' ? ' Values: ' + def.values.map(item => `${code(item.value)} ${item.label}`).join('; ') + '.' : ''
    return [[String(index + 1), def.label, code(def.key), defaultText(def) + docs, def.description + values, def.smo]]
  })
}

export function renderScriptingDocs(): string {
  return [
    '# Scripting catalogue',
    '',
    '<!-- Generated from src/shared/scripting/catalog.ts and options.ts. Regenerate with: npx vitest run tests/scripting-catalog.test.ts -u -->',
    '',
    'Script As, as SSMS offers it on Object Explorer nodes: a "Script … as" submenu with one submenu per verb and',
    'one item per destination. Which verbs each kind offers, the menu titles, the SMO URN types and the backend\'s preflight',
    'queries are data in `src/shared/scripting/catalog.ts`; the backend embeds the same data as',
    '`backend/Varia.Backend/Scripting/scripting-catalog.json`, and re-derives the subtype before it scripts anything.',
    '',
    '## Verbs',
    '',
    'DDL verbs run SMO\'s Scripter with the listed flag (every other verb flag is off); DML and EXECUTE verbs are SSMS\'s',
    'templates, built from one catalog query. A verb a kind does not support is shown greyed (○) or not offered (–).',
    '',
    table(['Verb', 'Submenu', 'Mnemonic', 'Group', 'Produced by'], scriptVerbs.map(verb => {
      const spec = scriptVerbSpecs[verb]
      const produced = spec.class === 'ddl' ? 'SMO' + (spec.smoFlag ? `, ${code(spec.smoFlag)}` : '') : 'Template'
      return [code(verb), scriptVerbTitle(verb), spec.mnemonic, `${code(spec.group)} ${spec.order}`, produced]
    })),
    '',
    '## Destinations',
    '',
    `Each verb submenu holds the three destinations. Their commands are ${code('explorer.script<Verb>To<Destination>')}, from`,
    `${code(scriptCommandId('create', 'newQuery'))} to ${code(scriptCommandId('execute', 'clipboard'))}; they stay out of the palette, where Script As… lists the enabled ones.`,
    '',
    table(['Destination', 'Menu title', 'Mnemonic', 'Icon', 'Waits for document tasks'], scriptDestinations.map(destination => {
      const spec = scriptDestinationSpecs[destination]
      return [code(destination), spec.title, spec.mnemonic, code(spec.icon), yesNo(spec.documentTask)]
    })),
    '',
    '## Object kinds',
    '',
    '✓ enabled, ○ shown greyed, – not offered. Columns: C = CREATE, A = ALTER, CoA = CREATE OR ALTER, D = DROP, DC = DROP And',
    'CREATE, S = SELECT, I = INSERT, U = UPDATE, Del = DELETE, E = EXECUTE, Mod = Modify (ALTER in a new query window).',
    '',
    table(['Kind', 'Subtypes', 'Title', 'C', 'A', 'CoA', 'D', 'DC', 'S', 'I', 'U', 'Del', 'E', 'Mod', 'SMO URN', 'Preflight'], nodeKinds.flatMap(kindRows)),
    '',
    `Children are scripted only below these parents: ${parentNotes().join('; ')}. A table type's keys, constraints and indexes are not.`,
    '',
    `Module preflights find the object by these ${code('sys.objects.type')} codes: ${moduleTypes().join('; ')}.`,
    '',
    `Deferred, with no Script submenu yet (key material, binaries or external integrations): ${deferred().join(', ')}.`,
    '',
    `Not scriptable: folders, and ${codes(notScriptable())}.`,
    '',
    '## Options',
    '',
    'Tools › Options › SQL Server Object Explorer › Scripting, with the docs page\'s labels and order. Defaults follow what',
    'SSMS\'s Script As produces; where the docs page states another default, it is shown in parentheses. Every request',
    'carries all of them.',
    '',
    'Main stores them in `scripting-options.json` in the user data folder, replacing the file atomically on OK. Options a',
    'newer version added are dropped and missing ones take their defaults; a file that is too large, not UTF-8, not JSON,',
    'or holds a value of the wrong type is renamed to `scripting-options.json.invalid-<uuid>.json`, and the defaults are',
    'used with a warning.',
    '',
    ...scriptingOptionGroups.flatMap(group => [`### ${scriptingOptionGroupLabels[group]}`, '', table(['#', 'Option', 'Key', 'Default', 'Description', 'SMO'], optionRows(group)), '']),
    '## Errors',
    '',
    'Failures come back as values in the result. Retryable ones can succeed when tried again.',
    '',
    table(['Code', 'Retryable'], scriptErrorCodes.map(error => [code(error), yesNo(scriptErrorRetryable[error])])),
    '',
    '## Limits',
    '',
    table(['Limit', 'Value', 'Meaning'], (Object.keys(limitNotes) as (keyof typeof scriptLimits)[]).map(key => [code(key), scriptLimits[key].toLocaleString('en-US'), limitNotes[key]])),
    ''
  ].join('\n')
}
