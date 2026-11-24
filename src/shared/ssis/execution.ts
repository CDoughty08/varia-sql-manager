// The SSIS execution messages view (AG-13): one execution's overview and its messages, SSMS's Overview and All Messages reports in
// one document, read with ssis.execution. What opens it (an execution's row in Integration Services Operations, an SSIS step's
// execution in a job's History), its words, its commands and the pure helpers its service and view share. Erasable TypeScript.
import { messageGroupOf, messageGroups, messageGroupSpecs, messageSourceTypes, messageTypes, operationStatuses, ssisLimits, type MessageGroup } from './catalog.ts'
import type { SsisExecutionMessage, SsisExecutionModel, SsisExecutionOverview } from './schema.ts'

/** The document's title and subtitle; its tab is named for the execution ("Execution 48213"). */
export const executionTitle = (id: number): string => `Execution ${id}`
export const executionSubtitle = 'Execution messages'
/** catalog.operations.operation_type of an execution: what View Messages opens from Integration Services Operations. */
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

/** Every message of the execution by group, from the counts by type (whatever groups the read kept). */
export function groupCounts(model: Pick<SsisExecutionModel, 'counts'>): Readonly<Record<MessageGroup, number>> {
  const counts = Object.fromEntries(messageGroups.map(group => [group, 0])) as Record<MessageGroup, number>
  for (const { type, count } of model.counts) counts[messageGroupOf(type)] += count
  return counts
}
export const totalMessages = (model: Pick<SsisExecutionModel, 'counts'>): number => model.counts.reduce((sum, item) => sum + item.count, 0)

/** The groups with one turned on or off; never none (turning the last one off turns every group on again). */
export function toggleGroup(groups: readonly MessageGroup[], group: MessageGroup): readonly MessageGroup[] {
  const next = groups.includes(group) ? groups.filter(item => item !== group) : [...groups, group]
  return next.length === 0 ? messageGroups : messageGroups.filter(item => next.includes(item))
}
/** The groups a read sends: none when every group is on (the backend's default). */
export const requestGroups = (groups: readonly MessageGroup[]): MessageGroup[] | undefined =>
  groups.length === messageGroups.length ? undefined : messageGroups.filter(group => groups.includes(group))

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
  { title: 'Type', value: message => messageTypeLabel(message.type) },
  { title: 'Source', value: message => message.source ?? '' },
  { title: 'Message', value: message => message.message },
  { title: 'Package', value: message => message.package ?? '' },
  { title: 'Event', value: message => message.event ?? '' },
  { title: 'Source type', value: message => sourceTypeLabel(message.sourceType) },
  { title: 'Execution path', value: message => message.path ?? '' },
  { title: 'Message code', value: message => message.code == null ? '' : String(message.code) }
]
/** The group chips' words with their counts: "Errors (3)". */
export const groupChipLabel = (group: MessageGroup, count: number | undefined): string =>
  count === undefined ? messageGroupSpecs[group].label : `${messageGroupSpecs[group].label} (${count.toLocaleString('en-US')})`

export type ExecutionCommandId = 'ssis.viewExecutionMessages' | 'ssis.refreshExecution'
/** A command catalogue entry, in the shape of `CommandDescriptor`. */
export interface ExecutionCommandEntry {
  readonly title: string
  readonly category: 'Integration Services'
  readonly icon: 'output' | 'refresh'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly keybindings?: readonly { readonly key: string; readonly when: string }[]
  readonly menus?: readonly { readonly menu: 'ssis.operation.context'; readonly group: string; readonly order: number; readonly title?: string; readonly mnemonic?: string }[]
}
/**
 * View Messages on an execution's row in Integration Services Operations (its menu, its header, a double-click), and the
 * execution document's Refresh (F5 there, as in Object Explorer). A job's History opens the document from its SSIS step's link.
 */
export function executionCommandEntries(): { readonly [K in ExecutionCommandId]: ExecutionCommandEntry } {
  return {
    'ssis.viewExecutionMessages': {
      title: 'View Execution Messages', category: 'Integration Services', icon: 'output', keywords: ['ssis', 'execution', 'messages', 'errors', 'log', 'report', 'overview'],
      precondition: 'backendReady && activeDocumentIsSsisOperations', unavailableHint: 'Select an execution in Integration Services Operations.',
      menus: [{ menu: 'ssis.operation.context', group: '1_operation', order: 2, title: 'View Messages', mnemonic: 'm' }]
    },
    // The conflict check reads each state key on its own, so the clause says what holds anyway: the execution document is
    // neither an SSIS properties document, Operations, nor BigQuery's Job History.
    'ssis.refreshExecution': {
      title: 'Refresh Execution', category: 'Integration Services', icon: 'refresh', keywords: ['ssis', 'reload', 'execution', 'messages'],
      precondition: 'backendReady && activeDocumentIsSsisExecution', unavailableHint: 'Open an SSIS execution\'s messages first.',
      keybindings: [{ key: 'f5', when: "activeDocumentIsSsisExecution && !activeDocumentIsSsis && !activeDocumentIsJobActivity && !activeDocumentIsJobHistory && activePanel != 'explorer' && !editorFocus && !queryBarFocus && !activityMonitorFocus && !peekFocus && !peekTabFocus" }]
    }
  }
}

/** A message time as the catalog stores it, in its own offset, to the millisecond ("2026-10-21 14:05:06.123 +02:00"), so messages
 *  in one second keep their order when sorted by it; anything else shows as sent. */
export function messageTime(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(iso)
  return match ? `${match[1]} ${match[2]}.${(match[3] ?? '').padEnd(3, '0').slice(0, 3)} ${match[4] === 'Z' ? '+00:00' : match[4]}` : iso
}
