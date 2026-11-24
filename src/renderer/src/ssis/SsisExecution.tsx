import { useMemo } from 'react'
import { displayText } from '../../../shared/explorer/refs.ts'
import type { LocalTableData } from '../../../shared/results/local-table.ts'
import { catalogDatabase, messageGroups, type MessageGroup } from '../../../shared/ssis/catalog.ts'
import {
  durationText, executionRunning, executionSeconds, executionSubtitle, executionText, executionTitle, groupChipLabel, groupCounts, messageColumns, statusLabel, statusTone, totalMessages
} from '../../../shared/ssis/execution.ts'
import type { SsisExecutionMessage, SsisExecutionModel, SsisExecutionOverview } from '../../../shared/ssis/schema.ts'
import type { StatusTone } from '../../../shared/theme/tones'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { LocalGrid } from '../grid/LocalGrid'
import { Chip, ChipGroup } from '../kit/Chip'
import DocumentFrame, { type Crumb, type Fact, type Verb } from '../kit/DocumentFrame'
import EmptyState from '../kit/EmptyState'
import InlineError, { type ErrorAction } from '../kit/InlineError'
import { StaleBadge } from '../kit/LivePill'
import Skeleton from '../kit/Skeleton'
import StatusPill from '../kit/StatusPill'
import { ssisTime } from './properties-view'
import type { SsisExecutionState } from './SsisExecutionService'

/** A message's text as a cell shows and copies it: line breaks and tabs kept (a package's error spans lines), other control
 *  characters named, as every local table names them. */
export const messageCell = (text: string): string => text.split(/(\r\n|\r|\n|\t)/).map((part, index) => index % 2 ? part : displayText(part)).join('')

/** The messages as the list shows them, newest first (the read's order); Copy and Save write this text. */
export function messagesTable(messages: readonly SsisExecutionMessage[]): LocalTableData {
  return {
    columns: messageColumns.map(column => ({ name: column.title, ...column.title === 'Message code' ? { kind: 'number' as const } : {} })),
    rows: messages.map(message => messageColumns.map(column => messageCell(column.value(message))))
  }
}
const tables = new WeakMap<SsisExecutionModel, LocalTableData>()
const tableOf = (model: SsisExecutionModel): LocalTableData => {
  let table = tables.get(model)
  if (!table) tables.set(model, table = messagesTable(model.messages))
  return table
}

/** The execution's General rows: what SSMS's Overview report lists about it. */
export function overviewRows(overview: SsisExecutionOverview): readonly (readonly [string, string])[] {
  const environment = overview.environment ? `${overview.environmentFolder ? `${overview.environmentFolder}\\` : '.\\'}${overview.environment}` : ''
  return [
    ['Execution', String(overview.id)], ['Status', statusLabel(overview.status)], ['Folder', overview.folder], ['Project', overview.project], ['Package', overview.package],
    ['Environment', environment], ['Created', ssisTime(overview.created)], ['Started', ssisTime(overview.started)], ['Ended', ssisTime(overview.ended)],
    ['Duration', durationText(executionSeconds(overview))], ['Executed as', overview.executedAs], ['Caller', overview.caller], ['Stopped by', overview.stoppedBy ?? ''],
    ['32-bit runtime', overview.use32bit ? 'Yes' : 'No'], ['Server', overview.server ?? ''], ['Machine', overview.machine ?? '']
  ]
}
const pillTone = (status: number): StatusTone => executionRunning(status) ? 'running' : statusTone(status) === 'error' ? 'critical' : statusTone(status) === 'warning' ? 'warning' : statusTone(status) === 'muted' ? 'neutral' : 'success'
/** The header's facts: what says most about a run. */
export function executionFacts(model: SsisExecutionModel | undefined): Fact[] {
  if (!model) return []
  const { overview } = model, counts = groupCounts(model)
  return [
    { label: 'Package', value: displayText(overview.package), title: `${overview.folder}\\${overview.project}\\${overview.package}` },
    { label: 'Duration', value: durationText(executionSeconds(overview)) || '—' },
    { label: 'Errors', value: counts.error.toLocaleString('en-US') }, { label: 'Warnings', value: counts.warning.toLocaleString('en-US') }
  ]
}

/** The header's state: reading, gone, failed, disconnected, or the execution's own status. */
function headerState(state: SsisExecutionState) {
  if (state.loading) return <StatusPill tone="running" label={state.model ? 'Refreshing' : 'Loading'} />
  if (state.gone) return <StatusPill tone="critical" label={state.error?.code === 'CATALOG_MISSING' ? 'Catalog missing' : state.error?.code === 'NOT_SUPPORTED' ? 'Not supported' : 'Not found'} title={state.error?.message} />
  if (state.disconnected) return <StatusPill tone="warning" label="Disconnected" title={`${state.serverLabel} is not connected.`} />
  if (state.error && state.model && state.loadedAt !== undefined) return <StaleBadge updatedAt={state.loadedAt} stale={{ since: state.loadedAt }} />
  if (state.error) return <StatusPill tone="critical" label="Failed" title={state.error.message} />
  return state.model ? <StatusPill tone={pillTone(state.model.overview.status)} label={statusLabel(state.model.overview.status)} /> : undefined
}

/**
 * One SSIS execution's overview and messages as a document: the path to it, its status and Refresh, its General facts, the type
 * chips (each with the execution's count) and the newest messages of the chosen types in the results grid, with its Copy, Copy
 * with Headers, sort and Save Results As. Read-only; the model stays while Refresh reads, and after a failure.
 */
export default function SsisExecution({ documentId }: { readonly documentId: string }) {
  const { ssisExecutions: service, commands } = useWorkbench()
  const { documents } = useServiceSnapshot(service)
  const state = documents[documentId]
  const table = useMemo(() => state?.model ? tableOf(state.model) : undefined, [state?.model])
  if (!state) return <EmptyState className="workspace-empty" icon="output" title="Execution messages" detail="This document has closed." />
  const { model } = state
  const crumbs: Crumb[] = [{ label: displayText(state.serverLabel), title: state.serverLabel }, { label: 'Integration Services Catalogs' }, { label: catalogDatabase },
    ...model ? [{ label: displayText(model.overview.folder), title: model.overview.folder }, { label: displayText(model.overview.project), title: model.overview.project }] : []]
  const verbs: Verb[] = [{ command: 'ssis.refreshExecution', args: { tabId: documentId }, label: 'Refresh' }]
  const close: ErrorAction = { label: 'Close', run: () => void commands.execute('file.close', { tabId: documentId }, 'toolbar') }
  const actions: ErrorAction[] = state.gone ? [close] : state.error?.retryable && !state.disconnected ? [{ label: 'Retry', run: () => service.refresh(documentId), disabled: state.loading }] : []
  const notice = <>
    {state.error && <InlineError message={state.error.code === 'CATALOG_MISSING' ? executionText.noCatalog : state.error.message} code={state.error.code} details={state.error.details}
      context={`Reading execution ${state.executionId} on ${state.serverLabel}`} actions={actions} />}
    {state.disconnected && !state.gone && <p className="ssis-properties-note" role="status">{executionText.disconnected(state.serverLabel)}</p>}
  </>
  const counts = model ? groupCounts(model) : undefined
  const total = model ? totalMessages(model) : 0
  const body = <div className="ssis-execution" data-ssis-execution-body="">
    {(state.error || state.disconnected) && notice}
    {!model ? !state.gone && <Skeleton rows={6} label={`Reading execution ${state.executionId}`} /> : <>
      <dl className="ssis-properties ssis-execution-overview" aria-label="Overview">
        {overviewRows(model.overview).map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value}><bdi>{value === '' ? <span className="ssis-properties-none"><span aria-hidden="true">—</span><span className="visually-hidden">None</span></span> : displayText(value)}</bdi></dd></div>)}
      </dl>
      {executionRunning(model.overview.status) && <p className="ssis-properties-note">{executionText.running}</p>}
      <div className="ssis-filter-row">
        <span className="ssis-filter-label" aria-hidden="true">Types</span>
        <ChipGroup label="Message types">
          {messageGroups.map((group: MessageGroup) => <Chip key={group} label={groupChipLabel(group, counts?.[group])} pressed={state.groups.includes(group)} disabled={state.disconnected || state.gone}
            onToggle={() => service.toggleGroup(documentId, group)} />)}
        </ChipGroup>
      </div>
      {model.truncated && <p className="ssis-properties-note" role="status">{executionText.truncated(model.messages.length)}</p>}
      <div className="ssis-execution-grid">
        <LocalGrid table={table!} label="Messages" preset="page" empty={total === 0 ? executionText.noMessages : executionText.noMatch}
          suggestedName={`Execution ${state.executionId}-Messages`} state={state.grid} />
      </div>
      <p className="ssis-properties-note">{executionText.cut}</p>
    </>}
  </div>
  return <DocumentFrame id={`ssis-execution-${documentId}`} title={executionTitle(state.executionId)} subtitle={executionSubtitle} crumbs={crumbs} state={headerState(state)} verbs={verbs}
    facts={executionFacts(model)} body={body} attributes={{ 'data-ssis-execution': documentId }} />
}
