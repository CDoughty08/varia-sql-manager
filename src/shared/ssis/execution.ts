// The Integration Services document's run page: one execution's facts, the package's recent runs, its task timeline, its messages
// by SSIS event and its parameters, SSMS's Overview, All Messages and Execution Performance reports on one page, read with
// ssis.execution; and the package page's runs (ssis.packageRuns). Their words, the commands that reach them and the pure helpers
// the services and views share. Erasable TypeScript.
import { messageSourceTypes, messageTypeOf, messageTypeOrder, messageTypes, operationStatuses, problemMessageTypes, ssisLimits, succeededStatus } from './catalog.ts'
import type { SsisExecutionMessage, SsisExecutionModel, SsisExecutionOverview } from './schema.ts'

/** The document's title and subtitle; its tab is named for the execution ("Execution 48213"). */
export const executionTitle = (id: number): string => `Execution ${id}`
export const executionSubtitle = 'Execution messages'
/** catalog.operations.operation_type of an execution: what Open drills down to from Integration Services Operations. */
export const executionOperationType = 200

/** A positive integer id that crosses JSON exactly. */
export const isExecutionId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0

export const executionText = {
  noCatalog: 'This server has no SSIS Catalog. Create it on the Integration Services Catalogs node, or connect to a server that has one.',
  notExecution: (id: number) => `Operation ${id} is not an execution: only an execution has messages to view here.`,
  disconnected: (server: string) => `${server} is not connected. Connect to it again to refresh this execution.`,
  truncated: (shown: number) => `Showing the newest ${shown.toLocaleString('en-US')} messages of the types chosen; older ones are left out. Choose fewer types to see further back.`,
  cut: `A message longer than ${ssisLimits.executionMessageChars.toLocaleString('en-US')} characters ends in "…".`,
  noMessages: 'The catalog has no messages for this execution. Its logging level may be None, or it has not logged anything yet.',
  noMatch: 'No messages of the types chosen. Choose more types above.',
  running: 'This execution is still running: Refresh reads its newest messages.'
} as const

export const statusLabel = (code: number): string => operationStatuses.find(status => status.code === code)?.label ?? `Status ${code}`
export const statusTone = (code: number): 'error' | 'warning' | 'muted' | undefined => operationStatuses.find(status => status.code === code)?.tone
export const messageTypeLabel = (code: number): string => messageTypes.find(type => type.code === code)?.label ?? `Type ${code}`
export const sourceTypeLabel = (code: number | null | undefined): string => code == null ? '' : messageSourceTypes.find(type => type.code === code)?.label ?? `Type ${code}`
/** Statuses an execution can still leave, so its duration runs on to the server's clock and Refresh finds more. */
export const executionRunning = (status: number): boolean => status === 1 || status === 2 || status === 5 || status === 8

/** The SSIS event a message type is logged by ("PreValidate"); a type the catalogue does not name is Unknown's. */
export const messageEventName = (code: number): string => messageTypes.find(type => type.code === messageTypeOf(code))?.event ?? 'Unknown'
/** Every message of the execution by type in chip order, with the types the catalogue does not name under -1 (Unknown); types
 *  without messages are left out, so the chips show only what the run logged. */
export function typeCounts(model: Pick<SsisExecutionModel, 'counts'>): readonly { readonly type: number; readonly count: number }[] {
  const counts = new Map<number, number>()
  for (const { type, count } of model.counts) counts.set(messageTypeOf(type), (counts.get(messageTypeOf(type)) ?? 0) + count)
  return messageTypeOrder.filter(type => (counts.get(type) ?? 0) > 0).map(type => ({ type, count: counts.get(type)! }))
}
export const totalMessages = (model: Pick<SsisExecutionModel, 'counts'>): number => model.counts.reduce((sum, item) => sum + item.count, 0)
export const problemCount = (model: Pick<SsisExecutionModel, 'counts'>): number =>
  model.counts.filter(item => problemMessageTypes.includes(item.type)).reduce((sum, item) => sum + item.count, 0)

/**
 * The event chips' selection after one is clicked; undefined is every type (All). From All, a click shows only that type; after
 * that a click adds or removes one, and removing the last returns to All. The result is in chip order.
 */
export function toggleType(types: readonly number[] | undefined, type: number): readonly number[] | undefined {
  if (types === undefined) return [type]
  const next = types.includes(type) ? types.filter(item => item !== type) : [...types, type]
  return next.length === 0 ? undefined : messageTypeOrder.filter(item => next.includes(item))
}
/** Whether a selection is the Problems preset. */
export const isProblems = (types: readonly number[] | undefined): boolean =>
  types !== undefined && types.length === problemMessageTypes.length && problemMessageTypes.every(type => types.includes(type))
export const problemTypes: readonly number[] = messageTypeOrder.filter(type => problemMessageTypes.includes(type))
/** An event chip's words: "Error 3". */
export const typeChipLabel = (type: number, count: number): string => `${messageEventName(type)} ${count.toLocaleString('en-US')}`

/** The earliest error the read holds (messages come newest first): the run page pins it above the list. */
export const firstError = (messages: readonly SsisExecutionMessage[]): SsisExecutionMessage | undefined => messages.findLast(message => message.type === 120)

/** The median of the package's earlier succeeded runs in the run strip (this run left out), in seconds: the usual duration. */
export function usualSeconds(runs: readonly { readonly id: number; readonly status: number; readonly started?: string; readonly ended?: string }[], except?: number): number | undefined {
  const seconds = runs.filter(run => run.id !== except && run.status === succeededStatus).map(run => secondsBetween(run.started, run.ended)).filter((value): value is number => value !== undefined).sort((a, b) => a - b)
  return seconds.length === 0 ? undefined : seconds[Math.floor((seconds.length - 1) / 2)]
}

const instant = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : undefined
}
/** Seconds between two catalog times (their offsets kept), or undefined. */
export const secondsBetween = (from: string | undefined, to: string | undefined): number | undefined => {
  const start = instant(from), end = instant(to)
  return start === undefined || end === undefined || end < start ? undefined : Math.floor((end - start) / 1000)
}
/** How long the execution ran: start to end, or start to the server's clock when it was read while still running. */
export const executionSeconds = (overview: SsisExecutionOverview): number | undefined =>
  secondsBetween(overview.started, overview.ended ?? (executionRunning(overview.status) ? overview.now : undefined))
/** A duration as SSMS's reports write it: "00:01:05", with days in front past 24 hours ("2.03:00:00"). */
export function durationText(seconds: number | undefined): string {
  if (seconds === undefined) return ''
  const days = Math.floor(seconds / 86_400), rest = seconds % 86_400
  const clock = [Math.floor(rest / 3600), Math.floor(rest / 60) % 60, rest % 60].map(part => String(part).padStart(2, '0')).join(':')
  return days > 0 ? `${days}.${clock}` : clock
}

/** The tone a message's row takes in the list: its type's. */
export const messageTone = (type: number): 'error' | 'warning' | 'info' | 'muted' => messageTypes.find(item => item.code === type)?.tone ?? 'info'

/** The list's columns, in order, and each message's text in them (the view adds nothing the copy would not have). */
export const messageColumns: readonly { readonly title: string; readonly value: (message: SsisExecutionMessage) => string }[] = [
  { title: 'Time', value: message => messageTime(message.time) },
  { title: 'Event', value: message => messageEventName(message.type) },
  { title: 'Source', value: message => message.source ?? '' },
  { title: 'Message', value: message => message.message },
  { title: 'Execution path', value: message => message.path ?? '' },
  { title: 'Source type', value: message => sourceTypeLabel(message.sourceType) },
  { title: 'Package', value: message => message.package ?? '' }
]

export type ExecutionCommandId = 'ssis.openExecution' | 'ssis.goBack' | 'ssis.goForward' | 'ssis.packageExecutions' | 'ssis.lastRun'
/** A command catalogue entry, in the shape of `CommandDescriptor`. */
export interface ExecutionCommandEntry {
  readonly title: string
  readonly category: 'Integration Services'
  readonly icon: 'output' | 'arrow-left' | 'arrow-right' | 'history' | 'go-to-file'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly keybindings?: readonly { readonly key?: string; readonly win?: string; readonly linux?: string; readonly mac?: string; readonly when: string }[]
  readonly menus?: readonly { readonly menu: 'ssis.operation.context' | 'explorer.context'; readonly group: string; readonly order: number; readonly title?: string; readonly mnemonic?: string; readonly when?: string }[]
}
// Back and Forward act in the Integration Services document but leave a text box's Alt+Left and Alt+Right; macOS takes Cmd+[ and
// Cmd+], as its browsers do, since its word moves are on Alt.
const inDocument = 'activeDocumentIsSsisOperations && !textInputFocus'
const packageNode = "explorerNode == 'ssisPackage' && !explorerServerLost"
/**
 * Open on an execution's row in the Integration Services document's list (its menu, a double-click, Enter), which drills to the
 * run's page in place; Back and Forward walk the places the document has shown (also the mouse's back and forward buttons,
 * src/shared/commands/gestures.ts); a package's Executions and Last Execution on its Object Explorer menu open the document at the
 * package's runs or its newest run. A job's History opens a run's page from its SSIS step's link.
 */
export function executionCommandEntries(): { readonly [K in ExecutionCommandId]: ExecutionCommandEntry } {
  return {
    'ssis.openExecution': {
      title: 'Open Execution', category: 'Integration Services', icon: 'output', keywords: ['ssis', 'execution', 'messages', 'errors', 'log', 'report', 'overview', 'tasks', 'parameters'],
      precondition: 'backendReady && activeDocumentIsSsisOperations', unavailableHint: 'Select an execution in Integration Services.',
      menus: [{ menu: 'ssis.operation.context', group: '1_operation', order: 1, title: 'Open', mnemonic: 'o' }]
    },
    'ssis.goBack': {
      title: 'Go Back', category: 'Integration Services', icon: 'arrow-left', keywords: ['ssis', 'back', 'previous', 'history', 'navigate'],
      precondition: 'activeDocumentIsSsisOperations && ssisCanGoBack', unavailableHint: 'Open a package or an execution in Integration Services first.',
      keybindings: [{ win: 'alt+left', linux: 'alt+left', mac: 'mod+[', when: inDocument }]
    },
    'ssis.goForward': {
      title: 'Go Forward', category: 'Integration Services', icon: 'arrow-right', keywords: ['ssis', 'forward', 'next', 'history', 'navigate'],
      precondition: 'activeDocumentIsSsisOperations && ssisCanGoForward', unavailableHint: 'Go back in Integration Services first.',
      keybindings: [{ win: 'alt+right', linux: 'alt+right', mac: 'mod+]', when: inDocument }]
    },
    'ssis.packageExecutions': {
      title: 'Package Executions', category: 'Integration Services', icon: 'history', keywords: ['ssis', 'package', 'executions', 'runs', 'history', 'report'],
      precondition: "backendReady && ssisVerbPackageProperties == 'enabled'", unavailableHint: 'Select an SSIS Catalog package in Object Explorer.',
      menus: [{ menu: 'explorer.context', group: '1_operations', order: 1, title: 'Executions', mnemonic: 'x', when: packageNode }]
    },
    'ssis.lastRun': {
      title: 'Package Last Execution', category: 'Integration Services', icon: 'go-to-file', keywords: ['ssis', 'package', 'last', 'latest', 'execution', 'messages'],
      precondition: "backendReady && ssisVerbPackageProperties == 'enabled'", unavailableHint: 'Select an SSIS Catalog package in Object Explorer.',
      menus: [{ menu: 'explorer.context', group: '1_operations', order: 2, title: 'Last Execution', mnemonic: 'u', when: packageNode }]
    }
  }
}

/** A message time as the catalog stores it, in its own offset, to the millisecond ("2026-10-21 14:05:06.123 +02:00"), so messages
 *  in one second keep their order when sorted by it; anything else shows as sent. */
export function messageTime(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(iso)
  return match ? `${match[1]} ${match[2]}.${(match[3] ?? '').padEnd(3, '0').slice(0, 3)} ${match[4] === 'Z' ? '+00:00' : match[4]}` : iso
}
