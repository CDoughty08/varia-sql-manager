// Create several (AG-6f, docs/agent-ui-rethink.md › Create several, mocks rx-create-several and rx-create-several-review): Create Job Like
// This turned into a table, one row per new job. The copy as Changes from source left it is the template: an empty cell uses the template's
// value (shown grey) and a typed one overrides that field for that row only. Columns offers every field a row can change: the job's own
// fields, each template step's fields and each source schedule's Share, Copy or Leave out. A row opened in the full editor comes back as
// that editor's whole draft (`edited`), so a row can differ in anything, not only in columns. Fill adds, duplicates and pastes rows and fills
// names from a pattern; the checks flag what would fail before anything is sent; each row is then created on its own by New Job's one-
// transaction save (agentJobSave), with its own result. Pure; the document (JobDocumentService) sends and draws it.
import { agentJobFieldLabels, agentJobFields, changedAgentJobFields, agentJobProblems, type AgentJobDocumentModel, type AgentJobDraft, type AgentJobField, type AgentNotifyLevel } from '../actions/agent-job.ts'
import { jobScheduleText } from '../actions/agent-schedule.ts'
import { agentLimits, notifyLevels } from './catalog.ts'
import { canShareSchedule, copyScheduleChoice, createFromProblems, createFromText, withCopyScheduleChoice, type CopyScheduleChoice, type JobCopySource } from './create-from.ts'
import { buildSsisCommand, parseSsisCommand, ssisPackagePath, withSsisPackage } from './ssis-step.ts'
import { stepOutputSubsystems, stepTypeShort, stepsChangesText, type AgentStepDraft } from './steps.ts'

export const createSeveralLimits = {
  /** Rows one table holds: each is its own request, sent one after another. */
  rows: 100,
  /** A Fill names pattern's length. */
  patternChars: 400,
  /** Characters Paste rows reads at once (100 rows of a few long cells). */
  pasteChars: 200_000
} as const

export const createSeveralText = {
  start: 'Create several…',
  startHint: 'The same fields as a table, one row per new job, for the “same job, different package” pattern.',
  tab: 'Create several jobs',
  banner: (name: string) => `Each row is a new job like ${name}. Grey cells use the value from Changes from source; anything you type overrides it for that job only.`,
  addRow: 'Add row',
  duplicateRow: 'Duplicate row',
  removeRow: 'Remove row',
  pasteRows: 'Paste rows…',
  pasteTitle: 'Paste rows',
  pasteHint: (columns: readonly string[]) => `Paste rows copied from a spreadsheet: one line per job, one tab-separated column per visible column (${columns.join(', ')}). An empty cell keeps the grey value.`,
  pasteAdd: (count: number) => count === 1 ? 'Add 1 row' : `Add ${count} rows`,
  pasted: (count: number, cut: number) => `Added ${count} ${count === 1 ? 'row' : 'rows'}.${cut ? ` ${cut} more did not fit: a table holds at most ${createSeveralLimits.rows} rows.` : ''}`,
  fillNames: 'Fill names…',
  fillTitle: 'Fill names',
  fillHint: 'A pattern for every row that is not created yet. {n} is the row number, {package} the first SSIS step\'s package, {database} the first T-SQL step\'s database, {source} the source job\'s name.',
  fillApply: 'Fill',
  columns: (shown: number, total: number) => `Columns · ${shown} of ${total}`,
  columnsTitle: 'Columns',
  columnsHint: 'Add any field of the job as a column, for a change every row needs. A one-off change in one row needs no column: Open full editor.',
  addRowHint: 'Add a row, or paste rows copied from a spreadsheet (one column per visible column).',
  otherChanges: 'Other changes',
  check: 'Check',
  none: 'none',
  fields: (count: number) => `+${count} ${count === 1 ? 'field' : 'fields'}`,
  attention: (count: number) => `${count} ${count === 1 ? 'row needs' : 'rows need'} attention`,
  review: (count: number) => `Review and create ${count} ${count === 1 ? 'job' : 'jobs'}`,
  rowTitle: (at: number, name: string) => `Row ${at} · ${name}`,
  differs: (count: number) => count === 0 ? 'the same as Changes from source' : `differs in ${count} ${count === 1 ? 'field' : 'fields'}`,
  openEditor: 'Open full editor',
  inColumn: 'in a column',
  reset: 'Reset',
  detailsHint: 'Any field can differ per job. For a field every row changes, add it as a column (Columns). For a one-off, Open full editor: the row opens as an unsaved job tab with every section, and what you change there comes back here as Other changes.',
  // The full editor's tab
  editorBanner: (at: number) => `Row ${at} of Create several jobs. What you change here goes back to the row; the table creates the job.`,
  backToTable: 'Back to the table',
  editorOrphan: 'The table this row belonged to was closed or its row is gone, so changes here go nowhere.',
  editorTab: (at: number, name: string) => `Row ${at} · ${name}`.slice(0, 160),
  // Checks
  duplicateName: 'Another row has this name.',
  existingName: 'A job with this name exists.',
  tooMany: `A table holds at most ${createSeveralLimits.rows} rows.`,
  ok: 'Ready',
  // Review and results
  reviewTitle: (count: number, skipped: number) => `${count} ${count === 1 ? 'job' : 'jobs'} will be created, each in its own transaction, disabled unless its row says Enabled.${skipped ? ` ${skipped} ${skipped === 1 ? 'row is' : 'rows are'} skipped.` : ''}`,
  create: (count: number) => `Create ${count} ${count === 1 ? 'job' : 'jobs'}`,
  creating: (at: number, count: number) => `Creating job ${at} of ${count}…`,
  skipped: (reason: string) => `Skipped: ${reason}`,
  notSent: 'Not sent',
  waiting: 'Waiting…',
  created: 'Created',
  createdEnabled: 'Created, enabled',
  failed: (message: string) => `Failed: ${message} Rolled back.`,
  unknown: (message: string) => `Not known: ${message}`,
  open: 'Open',
  done: (created: number, failed: number, skipped: number, disabled: number) => {
    const parts = [`${created} ${created === 1 ? 'job' : 'jobs'} created${created && disabled === created ? ' (disabled)' : disabled ? ` (${disabled} disabled)` : ''}`]
    if (failed) parts.push(`${failed} failed and rolled back`)
    if (skipped) parts.push(`${skipped} skipped`)
    return `Done: ${parts.join(', ')}. Each row was its own transaction.`
  },
  close: 'Close',
  enable: (count: number) => count === 1 ? 'Enable the created job' : `Enable the ${count} created jobs`,
  enabling: 'Enabling the created jobs…',
  enabled: (count: number) => `Enabled ${count} ${count === 1 ? 'job' : 'jobs'}.`,
  enableFailed: (message: string) => `Not enabled: ${message}`,
  backHint: 'Back to the table keeps the rows that were not created so you can fix and retry them; created rows are locked.',
  lost: 'The connection closed while the job was being created, so whether it was created is unknown. Reconnect, then check Jobs before retrying.',
  stopped: 'Not sent: an earlier row lost the connection.',
  busy: 'The jobs are being created. Wait for it to finish.'
} as const

// --- Columns ---------------------------------------------------------------------------------------------------------------

export type SeveralColumnKind = 'text' | 'command' | 'number' | 'check' | 'select'
export interface SeveralOption { readonly value: string; readonly label: string }
export interface SeveralColumn {
  readonly id: string
  readonly label: string
  /** Columns' heading it sits under: Job, Notifications, Step n 'name', Schedules. */
  readonly group: string
  readonly kind: SeveralColumnKind
  readonly options?: readonly SeveralOption[]
  /** The field's value in a draft as a cell types it; undefined where the draft has no such field (a step the full editor removed). */
  readonly get: (draft: AgentJobDraft) => string | undefined
  /** The draft with the field set from a typed value, or why the value cannot be used. */
  readonly set: (draft: AgentJobDraft, value: string) => AgentJobDraft | string
  /** A value in words (an option's label). */
  readonly text: (value: string) => string
}

/** What a table is built from: the copy's source, the template (the copy as Changes from source left it) and New Job's describe. */
export interface SeveralContext {
  readonly source: JobCopySource
  readonly template: AgentJobDraft
  readonly model: AgentJobDocumentModel
  readonly columns: readonly SeveralColumn[]
}

const max = (limit: number) => (value: string) => value.length > limit ? `At most ${limit} characters.` : undefined
const noNul = (value: string) => value.includes('\u0000') ? 'Text cannot contain U+0000.' : undefined
const levelOptions: readonly SeveralOption[] = notifyLevels.map(level => ({ value: String(level.code), label: level.label }))
const asLevel = (value: string): AgentNotifyLevel | undefined => ['0', '1', '2', '3'].includes(value) ? Number(value) as AgentNotifyLevel : undefined
const byLabel = (options: readonly SeveralOption[]) => (value: string) => options.find(option => option.value === value)?.label ?? value
/** A typed select value: an option's value, or its label typed or pasted (case ignored). */
const optionOf = (options: readonly SeveralOption[], value: string) => options.find(option => option.value === value) ?? options.find(option => option.label.toLowerCase() === value.trim().toLowerCase())

function textColumn(id: string, label: string, group: string, get: (draft: AgentJobDraft) => string | undefined, put: (draft: AgentJobDraft, value: string) => AgentJobDraft | string, limit: number, kind: 'text' | 'command' = 'text'): SeveralColumn {
  return { id, label, group, kind, get, set: (draft, value) => noNul(value) ?? max(limit)(value) ?? put(draft, value), text: value => value }
}
function selectColumn(id: string, label: string, group: string, options: readonly SeveralOption[], get: (draft: AgentJobDraft) => string | undefined, put: (draft: AgentJobDraft, value: string) => AgentJobDraft | string): SeveralColumn {
  return {
    id, label, group, kind: 'select', options, get, text: byLabel(options),
    set: (draft, value) => { const option = optionOf(options, value); return option ? put(draft, option.value) : `Choose one of: ${options.map(item => item.label || '(none)').join(', ')}.` }
  }
}
function numberColumn(id: string, label: string, group: string, limit: number, get: (draft: AgentJobDraft) => string | undefined, put: (draft: AgentJobDraft, value: number) => AgentJobDraft | string): SeveralColumn {
  return {
    id, label, group, kind: 'number', get, text: value => value,
    set: (draft, value) => /^[0-9]{1,5}$/.test(value.trim()) && Number(value) <= limit ? put(draft, Number(value)) : `A whole number from 0 to ${limit}.`
  }
}

/** The draft with one step changed; a message when the draft has no such step (the full editor removed it). */
function withStep(draft: AgentJobDraft, key: string, change: (step: AgentStepDraft) => AgentStepDraft | string): AgentJobDraft | string {
  const step = draft.steps.steps.find(item => item.key === key)
  if (!step) return 'This row has no such step.'
  const next = change(step)
  if (typeof next === 'string') return next
  return { ...draft, steps: { ...draft.steps, steps: draft.steps.steps.map(item => item.key === key ? next : item) } }
}
const stepOf = (draft: AgentJobDraft, key: string) => draft.steps.steps.find(step => step.key === key)

/** `\SSISDB\folder\project\package.dtsx` (the leading backslash optional) as its parts. */
const packagePattern = /^\\?SSISDB\\([^\\]+)\\([^\\]+)\\([^\\]+\.dtsx)$/i

function stepColumns(step: AgentStepDraft, at: number, model: AgentJobDocumentModel): SeveralColumn[] {
  const key = step.key, group = `Step ${at + 1} '${step.name}'`, label = (field: string) => `Step ${at + 1} · ${field}`, id = (field: string) => `step:${key}:${field}`
  const columns: SeveralColumn[] = [
    textColumn(id('name'), label('name'), group, draft => stepOf(draft, key)?.name, (draft, value) => value.trim() ? withStep(draft, key, item => ({ ...item, name: value })) : 'A step needs a name.', agentLimits.nameChars)
  ]
  if (step.subsystem === 'TSQL') {
    const databases = [...new Set([step.databaseName, ...model.databases ?? []].filter(Boolean))]
    columns.push(selectColumn(id('database'), label('database'), group, databases.map(name => ({ value: name, label: name })), draft => stepOf(draft, key)?.databaseName,
      (draft, value) => withStep(draft, key, item => ({ ...item, databaseName: value }))))
  }
  const parsed = step.subsystem === 'SSIS' ? parseSsisCommand(step.command) : undefined
  if (parsed) {
    columns.push({
      id: id('package'), label: label('package'), group, kind: 'text', text: value => value,
      get: draft => { const item = stepOf(draft, key), command = item && parseSsisCommand(item.command); return command ? ssisPackagePath(command) : item ? '' : undefined },
      set: (draft, value) => {
        const match = packagePattern.exec(value.trim())
        if (!match) return 'A package path such as \\SSISDB\\Folder\\Project\\Package.dtsx.'
        return withStep(draft, key, item => {
          const command = parseSsisCommand(item.command)
          return command ? { ...item, command: buildSsisCommand(withSsisPackage(command, match[1]!, match[2]!, match[3]!)) } : 'This step\'s command is not a package Varia can read.'
        })
      }
    })
    columns.push({
      id: id('environment'), label: label('environment'), group, kind: 'text', text: value => value === '' ? 'None' : `Reference ${value}`,
      get: draft => { const item = stepOf(draft, key), command = item && parseSsisCommand(item.command); return command ? command.environmentReference === undefined ? '' : String(command.environmentReference) : undefined },
      set: (draft, value) => {
        const none = /^none$/i.test(value.trim())
        if (!none && !/^[0-9]{1,18}$/.test(value.trim())) return 'An environment reference id (a whole number), or None.'
        return withStep(draft, key, item => {
          const command = parseSsisCommand(item.command)
          if (!command) return 'This step\'s command is not a package Varia can read.'
          const { environmentReference: _old, ...rest } = command
          return { ...item, command: buildSsisCommand(none ? rest : { ...rest, environmentReference: Number(value.trim()) }) }
        })
      }
    })
  }
  columns.push(textColumn(id('command'), label('command'), group, draft => stepOf(draft, key)?.command, (draft, value) => withStep(draft, key, item => ({ ...item, command: value })), agentLimits.stepCommandChars, 'command'))
  columns.push(numberColumn(id('retries'), label('retries'), group, agentLimits.stepRetries, draft => { const item = stepOf(draft, key); return item ? String(item.retryAttempts) : undefined },
    (draft, value) => withStep(draft, key, item => ({ ...item, retryAttempts: value }))))
  columns.push(numberColumn(id('interval'), label('retry minutes'), group, agentLimits.stepRetryMinutes, draft => { const item = stepOf(draft, key); return item ? String(item.retryInterval) : undefined },
    (draft, value) => withStep(draft, key, item => ({ ...item, retryInterval: value }))))
  if (stepOutputSubsystems.has(step.subsystem)) {
    columns.push(textColumn(id('output'), label('output file'), group, draft => stepOf(draft, key)?.outputFileName, (draft, value) => withStep(draft, key, item => ({ ...item, outputFileName: value })), agentLimits.stepOutputChars))
  }
  if (step.subsystem !== 'TSQL' && model.proxies) {
    const proxies = model.proxies.filter(proxy => proxy.subsystems.some(name => name.toLowerCase() === step.subsystem.toLowerCase()) || proxy.id === step.proxyId)
    const options = [{ value: '0', label: 'SQL Server Agent Service Account' }, ...proxies.map(proxy => ({ value: String(proxy.id), label: proxy.name }))]
    columns.push(selectColumn(id('runAs'), label('run as'), group, options, draft => { const item = stepOf(draft, key); return item ? String(item.proxyId) : undefined },
      (draft, value) => withStep(draft, key, item => ({ ...item, proxyId: Number(value) }))))
  }
  return columns
}

/**
 * Every column a table offers for `template`: the job's fields (Owner for sysadmin only, since msdb lets only sysadmin give a job to another
 * login), its notifications, each template step's fields and each source schedule's Share, Copy or Leave out. Ids are stable for one table.
 */
export function severalColumns(source: JobCopySource, template: AgentJobDraft, model: AgentJobDocumentModel): SeveralColumn[] {
  const job = 'Job', notify = 'Notifications'
  const columns: SeveralColumn[] = [
    textColumn('name', 'Name', job, draft => draft.name, (draft, value) => ({ ...draft, name: value }), agentLimits.nameChars)
  ]
  if (model.sysadmin) columns.push(textColumn('owner', 'Owner', job, draft => draft.owner, (draft, value) => value.trim() ? { ...draft, owner: value } : 'The job needs an owner.', agentLimits.nameChars))
  const categories = [...new Set([template.category, ...model.categories])]
  columns.push(selectColumn('category', 'Category', job, categories.map(name => ({ value: name, label: name })), draft => draft.category, (draft, value) => ({ ...draft, category: value })))
  columns.push(textColumn('description', 'Description', job, draft => draft.description, (draft, value) => ({ ...draft, description: value }), agentLimits.descriptionChars))
  columns.push({ id: 'enabled', label: 'Enabled', group: job, kind: 'check', get: draft => String(draft.enabled), text: value => value === 'true' ? 'Enabled' : 'Disabled',
    set: (draft, value) => /^(true|yes|1|x|enabled)$/i.test(value.trim()) ? { ...draft, enabled: true } : /^(false|no|0|disabled)$/i.test(value.trim()) ? { ...draft, enabled: false } : 'Yes or no.' })
  const operators = (model.operators ?? []).map(operator => ({ value: operator.name, label: operator.name }))
  for (const [field, levelKey, operatorKey] of [['email', 'emailLevel', 'emailOperator'], ['page', 'pageLevel', 'pageOperator']] as const) {
    const name = agentJobFieldLabels[field]
    const used = template[operatorKey] ? [{ value: template[operatorKey], label: template[operatorKey] }] : []
    const choices = [{ value: '', label: '(none)' }, ...[...used, ...operators].filter((option, at, all) => all.findIndex(item => item.value === option.value) === at)]
    columns.push(model.operators
      ? selectColumn(`${field}Operator`, `${name} · operator`, notify, choices, draft => draft[operatorKey], (draft, value) => ({ ...draft, [operatorKey]: value }))
      : textColumn(`${field}Operator`, `${name} · operator`, notify, draft => draft[operatorKey], (draft, value) => ({ ...draft, [operatorKey]: value }), agentLimits.nameChars))
    columns.push(selectColumn(`${field}Level`, `${name} · when`, notify, levelOptions, draft => String(draft[levelKey]), (draft, value) => ({ ...draft, [levelKey]: asLevel(value)! })))
  }
  columns.push(selectColumn('eventLogLevel', `${agentJobFieldLabels.eventLog} · when`, notify, levelOptions, draft => String(draft.eventLogLevel), (draft, value) => ({ ...draft, eventLogLevel: asLevel(value)! })))
  columns.push(selectColumn('deleteLevel', `${agentJobFieldLabels.delete} · when`, notify, levelOptions, draft => String(draft.deleteLevel), (draft, value) => ({ ...draft, deleteLevel: asLevel(value)! })))
  template.steps.steps.forEach((step, at) => columns.push(...stepColumns(step, at, model)))
  const records = source.model.schedules ?? []
  for (const record of records) {
    const options = [...canShareSchedule(record) ? [{ value: 'share', label: createFromText.share }] : [], { value: 'copy', label: createFromText.copy }, { value: 'leave', label: createFromText.leave }]
    columns.push(selectColumn(`schedule:${record.id}`, `Schedule · ${record.name}`, createFromText.schedulesTitle, options, draft => copyScheduleChoice(draft.schedules, record),
      (draft, value) => ({ ...draft, schedules: withCopyScheduleChoice(draft.schedules, records, record, value as CopyScheduleChoice) })))
  }
  return columns
}
/** The columns a table opens with: Name, each step's key fields but its command (a cell shows one line), each schedule, and Enabled. */
export function defaultSeveralColumns(columns: readonly SeveralColumn[]): string[] {
  return columns.filter(column => column.id === 'name' || column.id === 'enabled' || column.id.startsWith('schedule:') || /^step:[^:]+:(database|package|environment)$/.test(column.id)).map(column => column.id)
}
export const severalContext = (source: JobCopySource, template: AgentJobDraft, model: AgentJobDocumentModel): SeveralContext =>
  ({ source, template, model, columns: severalColumns(source, template, model) })

// --- The table ------------------------------------------------------------------------------------------------------------

/** A row's result once Create sent it: created (its name as msdb keeps it, and whether it is enabled), failed and rolled back, or not
 *  known (the connection closed while it was sent). Skipped rows have none: they were not sent and stay in the table. */
export type SeveralResult =
  | { readonly state: 'created'; readonly name: string; readonly enabled: boolean; readonly enableError?: string }
  | { readonly state: 'failed'; readonly message: string }
  | { readonly state: 'unknown'; readonly message: string }
export interface SeveralRow {
  readonly key: string
  /** Typed overrides by column id; an absent cell uses the row's base (its full editor's draft, else the template). */
  readonly cells: Readonly<Record<string, string>>
  /** The full editor's whole draft, once the row was opened there. */
  readonly edited?: AgentJobDraft
  readonly result?: SeveralResult
}
export interface SeveralTable {
  readonly template: AgentJobDraft
  /** Visible column ids, in order (Name always first). */
  readonly columns: readonly string[]
  readonly rows: readonly SeveralRow[]
  /** The next row key's number. */
  readonly next: number
}

export const startSeveral = (context: Pick<SeveralContext, 'template' | 'columns'>): SeveralTable =>
  ({ template: context.template, columns: defaultSeveralColumns(context.columns), rows: [{ key: 'r1', cells: {} }], next: 2 })

export const severalLocked = (row: SeveralRow) => row.result?.state === 'created'
const columnOf = (context: SeveralContext, id: string) => context.columns.find(column => column.id === id)

export interface SeveralRowDraft {
  readonly draft: AgentJobDraft
  /** Typed cells whose value could not be used, by column id. */
  readonly cellErrors: Readonly<Record<string, string>>
}
/**
 * A row's job: its base (the full editor's draft, else the template) with its typed cells over it. A schedule the row copies under the
 * template's name is named after the row's job, so the new jobs do not get one schedule name each.
 */
export function severalRowDraft(context: SeveralContext, row: SeveralRow): SeveralRowDraft {
  const { draft, cellErrors } = severalEditorDraft(context, row)
  const name = draft.name.trim()
  const schedules = draft.schedules.map(entry => {
    const id = /^n:copy:([0-9]+)$/.exec(entry.key)?.[1]
    const record = id ? (context.source.model.schedules ?? []).find(item => String(item.id) === id) : undefined
    // The name the copy gave it (Changes from source's, or Copy's default when the row chose Copy): typed names stay.
    const given = context.template.schedules.find(item => item.key === entry.key)?.fields.name ?? (record ? jobScheduleText.copyName(record.name) : undefined)
    if (!record || !name || entry.fields.name !== given) return entry
    return { ...entry, fields: { ...entry.fields, name: `${name} – ${record.name}`.slice(0, agentLimits.nameChars) } }
  })
  return { draft: schedules.some((entry, at) => entry !== draft.schedules[at]) ? { ...draft, schedules } : draft, cellErrors }
}
/** The row's base with its typed cells over it, before a copied schedule takes the row's name: what the full editor opens with (so the rename
 *  still follows a name typed later) and what the differences compare. */
export function severalEditorDraft(context: SeveralContext, row: SeveralRow): SeveralRowDraft {
  let draft = row.edited ?? context.template
  const cellErrors: Record<string, string> = {}
  for (const column of context.columns) {
    const value = row.cells[column.id]
    if (value === undefined) continue
    const next = column.set(draft, value)
    if (typeof next === 'string') cellErrors[column.id] = next
    else draft = next
  }
  return { draft, cellErrors }
}
/** What a cell shows: its typed value, else (grey) the base's. `inherited` is true when nothing was typed. */
export function severalCell(context: SeveralContext, row: SeveralRow, column: SeveralColumn): { readonly value: string; readonly inherited: boolean; readonly changed: boolean } {
  const typed = row.cells[column.id]
  const base = column.get(row.edited ?? context.template) ?? ''
  const value = typed ?? base
  return { value, inherited: typed === undefined, changed: value !== (column.get(context.template) ?? '') }
}

function putRow(table: SeveralTable, key: string, change: (row: SeveralRow) => SeveralRow): SeveralTable {
  const rows = table.rows.map(row => row.key === key && !severalLocked(row) ? change(row) : row)
  return rows.some((row, at) => row !== table.rows[at]) ? { ...table, rows } : table
}

/**
 * A typed cell. An empty one goes back to the template's value: its typed value goes, and a full editor's value for the field is reset too,
 * so the grey value shown is the template's.
 */
export function withSeveralCell(context: SeveralContext, table: SeveralTable, key: string, columnId: string, value: string): SeveralTable {
  const column = columnOf(context, columnId)
  if (!column) return table
  return putRow(table, key, row => {
    const { [columnId]: _gone, ...cells } = row.cells
    if (value !== '' && value !== (column.get(row.edited ?? context.template) ?? '')) return { ...row, cells: { ...cells, [columnId]: value } }
    if (value !== '' || !row.edited) return { ...row, cells }
    const reset = column.set(row.edited, column.get(context.template) ?? '')
    return { ...row, cells, ...typeof reset === 'string' ? {} : { edited: reset } }
  })
}
export function addSeveralRow(table: SeveralTable, cells: Readonly<Record<string, string>> = {}): SeveralTable {
  if (table.rows.length >= createSeveralLimits.rows) return table
  return { ...table, rows: [...table.rows, { key: `r${table.next}`, cells }], next: table.next + 1 }
}
/** A copy of a row after it: its typed cells and full-editor changes, not its result. */
export function duplicateSeveralRow(table: SeveralTable, key: string): SeveralTable {
  const at = table.rows.findIndex(row => row.key === key)
  if (at < 0 || table.rows.length >= createSeveralLimits.rows) return table
  const { result: _result, ...row } = table.rows[at]!
  const copy: SeveralRow = { ...row, key: `r${table.next}` }
  return { ...table, rows: [...table.rows.slice(0, at + 1), copy, ...table.rows.slice(at + 1)], next: table.next + 1 }
}
export const removeSeveralRow = (table: SeveralTable, key: string): SeveralTable =>
  ({ ...table, rows: table.rows.filter(row => row.key !== key || severalLocked(row)) })
/** The full editor's draft back on its row: it holds every change, typed cells included, so the cells go. */
export const withSeveralEdited = (table: SeveralTable, key: string, draft: AgentJobDraft): SeveralTable => putRow(table, key, row => ({ ...row, cells: {}, edited: draft }))
/** Columns: shows or hides one; Name always shows, first. Hiding keeps the rows' typed values (they then list as Other changes). */
export function withSeveralColumn(context: SeveralContext, table: SeveralTable, columnId: string, shown: boolean): SeveralTable {
  if (columnId === 'name' || !columnOf(context, columnId) || table.columns.includes(columnId) === shown) return table
  const order = context.columns.map(column => column.id)
  const columns = shown ? [...table.columns, columnId].sort((a, b) => order.indexOf(a) - order.indexOf(b)) : table.columns.filter(id => id !== columnId)
  return { ...table, columns }
}

/** Paste rows: one line per row, tab-separated cells in the visible columns' order (a spreadsheet's copy). An empty cell keeps the grey
 *  value; cells past the last column are ignored. Rows past the table's limit are not added (`cut` says how many). */
export function pasteSeveralRows(table: SeveralTable, text: string): { readonly table: SeveralTable; readonly added: number; readonly cut: number } {
  const lines = text.slice(0, createSeveralLimits.pasteChars).split(/\r?\n/)
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  let next = table, added = 0, cut = 0
  for (const line of lines) {
    if (!line.trim()) continue
    if (next.rows.length >= createSeveralLimits.rows) { cut++; continue }
    const cells: Record<string, string> = {}
    line.split('\t').forEach((cell, at) => { const id = table.columns[at]; const value = cell.replace(/^"(.*)"$/s, '$1').trim(); if (id && value) cells[id] = value })
    next = addSeveralRow(next, cells)
    added++
  }
  return { table: next, added, cut }
}

/** The tokens Fill names replaces, out of a row's job (before its name is filled). */
function nameTokens(context: SeveralContext, draft: AgentJobDraft, at: number): Readonly<Record<string, string>> {
  const ssis = draft.steps.steps.map(step => step.subsystem === 'SSIS' ? parseSsisCommand(step.command) : undefined).find(command => !!command)
  const database = draft.steps.steps.find(step => step.subsystem === 'TSQL' && step.databaseName)?.databaseName ?? ''
  return { n: String(at + 1), package: ssis ? ssis.package.replace(/\.dtsx$/i, '') : '', database, source: context.source.base.name }
}
/** A pattern's name for one row: {n}, {package}, {database} and {source} replaced; any other braces stay as typed. */
export function severalPatternName(context: SeveralContext, draft: AgentJobDraft, at: number, pattern: string): string {
  const tokens = nameTokens(context, draft, at)
  return pattern.slice(0, createSeveralLimits.patternChars).replace(/\{(n|package|database|source)\}/gi, (_whole, token: string) => tokens[token.toLowerCase()] ?? '').slice(0, agentLimits.nameChars)
}
/** Fill names: every row that is not created gets the pattern's name in its Name cell. */
export function fillSeveralNames(context: SeveralContext, table: SeveralTable, pattern: string): SeveralTable {
  if (!pattern.trim()) return table
  return {
    ...table, rows: table.rows.map((row, at) => {
      if (severalLocked(row)) return row
      const { name: _name, ...cells } = row.cells
      const name = severalPatternName(context, severalRowDraft(context, { ...row, cells }).draft, at, pattern)
      return name ? { ...row, cells: { ...cells, name } } : row
    })
  }
}

// --- What a row changes ------------------------------------------------------------------------------------------------------

export interface SeveralDifference {
  /** A column id, or `field:<job field>` for a change no column holds (steps added or removed, a schedule's own fields). */
  readonly id: string
  readonly label: string
  readonly template: string
  readonly value: string
  /** Shown in a visible column (no Reset here: clearing the cell resets it). */
  readonly inColumn: boolean
}
/** Which draft properties a job field is made of, so Reset can put the template's back. */
const draftKeys: { readonly [F in AgentJobField]: readonly (keyof AgentJobDraft)[] } = {
  name: ['name'], owner: ['owner'], category: ['category'], description: ['description'], enabled: ['enabled'], email: ['emailLevel', 'emailOperator'], page: ['pageLevel', 'pageOperator'],
  netSend: ['netSendLevel', 'netSendOperator'], eventLog: ['eventLogLevel'], delete: ['deleteLevel'], alerts: ['removeAlerts'], steps: ['steps'], schedules: ['schedules']
}
/** The template with every column's value of `draft` put on it: what is left between it and `draft` is what no column holds. */
function throughColumns(context: SeveralContext, draft: AgentJobDraft): AgentJobDraft {
  return context.columns.reduce((value, column) => {
    const wanted = column.get(draft)
    if (wanted === undefined || wanted === column.get(value)) return value
    const next = column.set(value, wanted)
    return typeof next === 'string' ? value : next
  }, context.template)
}
const shortText = (text: string) => { const line = text.split(/\r?\n/, 1)[0] ?? ''; return line.length > 100 || text.includes('\n') ? `${line.slice(0, 100)}…` : line || '(none)' }
/** Every field a row's job differs in from the template, as the details pane lists them: column fields first, then what no column holds. */
export function severalDifferences(context: SeveralContext, table: SeveralTable, row: SeveralRow): SeveralDifference[] {
  // Before a copied schedule takes the row's name: that rename is no change the row made.
  const { draft } = severalEditorDraft(context, row)
  const found: SeveralDifference[] = []
  for (const column of context.columns) {
    const before = column.get(context.template) ?? '', after = column.get(draft)
    if (after === undefined || before === after) continue
    found.push({ id: column.id, label: column.label, template: shortText(column.text(before)), value: shortText(column.text(after)), inColumn: table.columns.includes(column.id) })
  }
  const through = throughColumns(context, draft)
  for (const field of changedAgentJobFields(through, draft)) {
    const value = field === 'steps' ? stepsChangesText(through.steps, draft.steps, 'identity')
      : field === 'schedules' ? draft.schedules.filter(entry => !entry.remove).map(entry => entry.fields.name).join(', ') || '(none)' : 'changed'
    const before = field === 'steps' ? `${through.steps.steps.length} ${through.steps.steps.length === 1 ? 'step' : 'steps'}` : field === 'schedules' ? through.schedules.map(entry => entry.fields.name).join(', ') || '(none)' : ''
    found.push({ id: `field:${field}`, label: field === 'steps' ? 'Steps (other changes)' : field === 'schedules' ? 'Schedules (other changes)' : agentJobFieldLabels[field], template: before, value, inColumn: false })
  }
  return found
}
/** Other changes: the differences no visible column shows. */
export const severalOtherCount = (context: SeveralContext, table: SeveralTable, row: SeveralRow) => severalDifferences(context, table, row).filter(item => !item.inColumn).length

/** Reset one difference: a column field goes back to the template's value (typed cell and full-editor value both); a change no column holds
 *  takes the template's steps or schedules with the row's column values kept on them. */
export function resetSeveralDifference(context: SeveralContext, table: SeveralTable, key: string, id: string): SeveralTable {
  const field = /^field:(.+)$/.exec(id)?.[1] as AgentJobField | undefined
  if (!field) return withSeveralCell(context, table, key, id, '')
  if (!agentJobFields.includes(field)) return table
  return putRow(table, key, row => {
    if (!row.edited) return row
    const through = throughColumns(context, row.edited)
    const patch = Object.fromEntries(draftKeys[field].map(name => [name, through[name]])) as Partial<AgentJobDraft>
    return { ...row, edited: { ...row.edited, ...patch } }
  })
}

// --- Checks -----------------------------------------------------------------------------------------------------------------

export interface SeveralCheck {
  /** What stops the row from being sent: a cell that cannot be used, a name in use, or a problem that stops New Job's save. */
  readonly blocking: readonly string[]
  /** What would make the job fail later (a required SSIS parameter without a value, an operator that is not notified); sent anyway. */
  readonly warnings: readonly string[]
  readonly cellErrors: Readonly<Record<string, string>>
}
/** msdb compares job names as its collation does; case-insensitive and trimmed is the safe reading for a duplicate. */
const nameKey = (name: string) => name.trim().toLowerCase()
/**
 * Each row's checks, by row key (created rows have none). `ssis` gives a row's SSIS problems by step key, for the packages read so far.
 * Duplicate names among the rows, a name msdb already has, and every error New Job's save would refuse block a row; warnings do not.
 */
export function severalChecks(context: SeveralContext, table: SeveralTable, ssis?: (draft: AgentJobDraft) => ReadonlyMap<string, readonly string[]> | undefined): ReadonlyMap<string, SeveralCheck> {
  const drafts = new Map(table.rows.map(row => [row.key, severalRowDraft(context, row)]))
  const counts = new Map<string, number>()
  for (const row of table.rows) {
    if (severalLocked(row)) continue
    const name = nameKey(drafts.get(row.key)!.draft.name)
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const existing = new Set((context.model.jobs ?? []).map(nameKey))
  const created = new Set(table.rows.flatMap(row => row.result?.state === 'created' ? [nameKey(row.result.name)] : []))
  const truncated = createFromProblems(context.source).map(problem => problem.message)
  const checks = new Map<string, SeveralCheck>()
  for (const row of table.rows) {
    if (severalLocked(row)) continue
    const { draft, cellErrors } = drafts.get(row.key)!
    const blocking: string[] = [...truncated], warnings: string[] = []
    for (const [id, message] of Object.entries(cellErrors)) blocking.push(`${columnOf(context, id)?.label ?? id}: ${message}`)
    const name = nameKey(draft.name)
    if (name && (existing.has(name) || created.has(name))) blocking.push(createSeveralText.existingName)
    else if (name && (counts.get(name) ?? 0) > 1) blocking.push(createSeveralText.duplicateName)
    for (const problem of agentJobProblems(context.model, draft, ssis?.(draft))) (problem.severity === 'error' ? blocking : warnings).push(problem.message)
    checks.set(row.key, { blocking: [...new Set(blocking)], warnings: [...new Set(warnings)], cellErrors })
  }
  return checks
}

// --- Review and results ------------------------------------------------------------------------------------------------------

/** What a row sends, in one line: "Job, 3 steps, shares Nightly 02:30, new schedule ETL – Load HR – Nightly 02:30, 6 fields differ". */
export function severalSummary(context: SeveralContext, table: SeveralTable, row: SeveralRow): string {
  const { draft } = severalRowDraft(context, row)
  const steps = draft.steps.steps.length
  const parts = [`Job, ${steps} ${steps === 1 ? 'step' : 'steps'}${steps ? ` (${[...new Set(draft.steps.steps.map(step => stepTypeShort(step.subsystem)))].join(', ')})` : ''}`]
  for (const entry of draft.schedules) {
    if (entry.remove) continue
    parts.push(entry.attached ? `shares ${entry.fields.name}` : `new schedule ${entry.fields.name}`)
  }
  const differs = severalDifferences(context, table, row).filter(item => item.id !== 'name').length
  if (differs) parts.push(`${differs} ${differs === 1 ? 'field differs' : 'fields differ'}`)
  parts.push(draft.enabled ? 'enabled' : 'disabled')
  return parts.join(', ')
}
/** The results banner's counts. `skipped`: rows the review left out. */
export function severalDoneText(table: SeveralTable, skipped: number): string {
  const created = table.rows.filter(row => row.result?.state === 'created')
  const failed = table.rows.filter(row => row.result && row.result.state !== 'created').length
  return createSeveralText.done(created.length, failed, skipped, created.filter(row => row.result?.state === 'created' && !row.result.enabled).length)
}
/** The created jobs saved disabled: what Enable the created jobs enables. */
export const severalDisabled = (table: SeveralTable) => table.rows.filter(row => row.result?.state === 'created' && !row.result.enabled)
