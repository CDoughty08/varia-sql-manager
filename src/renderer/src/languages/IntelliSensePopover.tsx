import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { isBigQueryName } from '../../../shared/bigquery/names'
import { googleSqlDialect } from '../../../shared/googlesql/dialect'
import { scanGoogleSql } from '../../../shared/googlesql/lexer'
import { readGoogleSqlStatementSources } from '../../../shared/googlesql/scope'
import { languageLimits } from '../../../shared/language-service'
import type { LanguageLookupAnswer } from '../../../shared/language-lookup'
import type { StatusTone } from '../../../shared/theme/tones'
import { modalOpen } from '../core/modal'
import { SnapshotStore } from '../core/store'
import { useCommandEnabled, useKeybindingLabel } from '../core/useCommand'
import { watchModals } from '../core/windows'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import type { QueryTab } from '../documents'
import Icon from '../Icon'
import { memoryLevel, type MemoryUsage } from '../results/memory'
import { panelBytes } from '../results/memory-details'
import type { IndexEntry, ObjectSearchSnapshot } from '../search/ObjectSearchService'
import { isBigQueryConnection, isLiveConnection } from '../services/connection-availability'
import type { SqlStatusItem } from '../EditorStatus'

declare const CloseWatcher: (new () => EventTarget & { destroy(): void }) | undefined

const emptySearchStore = new SnapshotStore<ObjectSearchSnapshot>({ indexes: {}, documents: {}, paneFocus: 0 })
const emptyMemoryStore = new SnapshotStore<MemoryUsage>({ usedBytes: 0, globalBytes: 0 })
const emptyStarredStore = new SnapshotStore<{ readonly byPrincipal: Readonly<Record<string, readonly string[]>> }>({ byPrincipal: {} })
const sourceLimits = { statements: 32, sources: 16 } as const

export interface BigQueryQuerySource {
  readonly project: string
  readonly dataset: string
  readonly name: string
  readonly path: string
}

export type QuerySourceHealth = 'indexed' | 'namesOnly' | 'building' | 'notIndexed'

export interface BigQueryWaveSummary {
  readonly state: 'none' | 'building' | 'ready'
  readonly phase?: IndexEntry['phase']
  readonly done: number
  readonly total: number
  readonly totalProjects: number
  readonly datasets: number
  readonly indexedDatasets: number
  readonly objects: number
  readonly billing: { readonly project: string; readonly state: 'full' | 'namesOnly' | 'building' | 'none' }
  readonly starred: { readonly count: number; readonly full: number; readonly namesOnly: number }
  readonly discovered: { readonly count: number; readonly full: number; readonly namesOnly: number }
}

/** Extracts unique, validated BigQuery `FROM`/`JOIN` object references in `text` (bounded; never runs SQL). */
export function extractBigQueryQuerySources(text: string, billingProject: string, defaultDataset?: string): BigQueryQuerySource[] {
  if (!text || text.length > languageLimits.documentCharacters) return []
  const dialect = googleSqlDialect({ project: billingProject, dataset: defaultDataset })
  const offsets: number[] = []
  try {
    for (const token of scanGoogleSql(text)) {
      if (token.kind === 'punctuation' && text[token.start] === ';') {
        offsets.push(token.start)
        if (offsets.length >= sourceLimits.statements) break
      }
    }
  } catch { /* fall through to end offset */ }
  if (offsets.length < sourceLimits.statements) offsets.push(text.length)
  const sources: BigQueryQuerySource[] = []
  const seen = new Set<string>()
  for (const offset of offsets) {
    if (sources.length >= sourceLimits.sources) break
    let found: ReturnType<typeof readGoogleSqlStatementSources>
    try { found = readGoogleSqlStatementSources(text, offset) } catch { continue }
    for (const source of found) {
      if (sources.length >= sourceLimits.sources) break
      if (source.kind !== 'object') continue
      const path = dialect.objectPath(source.parts)
      if (!path || path.length !== 3) continue
      const [project, dataset, name] = path
      if (!isBigQueryName('project', project) || !isBigQueryName('dataset', dataset) || !name || dataset.toUpperCase() === 'INFORMATION_SCHEMA') continue
      const key = `${project.toLowerCase()}\u0000${dataset.toLowerCase()}\u0000${name.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      sources.push({ project, dataset, name, path: `${project}.${dataset}.${name}` })
    }
  }
  return sources
}

/** Computes PR #738's 3-wave tier summary (Wave 1 billing, Wave 3a ★ starred, Wave 3b discovered + memory-capped). */
export function summarizeBigQueryWaves(
  billingProject: string,
  entry: IndexEntry | undefined,
  starredProjects: readonly string[]
): BigQueryWaveSummary {
  const status = entry?.status
  const building = !!entry?.requestId || status?.state === 'building'
  const state: 'none' | 'building' | 'ready' = building ? 'building' : status?.state === 'ready' ? 'ready' : 'none'
  const namesOnlySet = new Set(status?.namesOnly ?? [])
  const distinctStarred = [...new Set(starredProjects.filter(project => project && project !== billingProject))]
  const starredNamesOnly = distinctStarred.filter(project => namesOnlySet.has(project)).length
  const totalProjects = status?.projects ?? (state === 'none' ? 0 : 1 + distinctStarred.length)
  const billingNamesOnly = namesOnlySet.has(billingProject)
  const discoveredNamesOnly = [...namesOnlySet].filter(project => project !== billingProject && !distinctStarred.includes(project)).length
  const discoveredCount = Math.max(0, totalProjects - (totalProjects > 0 ? 1 : 0) - distinctStarred.length)
  return {
    state,
    phase: entry?.phase ?? status?.phase,
    done: entry?.done ?? status?.indexed ?? 0,
    total: entry?.total ?? status?.databases ?? 0,
    totalProjects,
    datasets: status?.databases ?? 0,
    indexedDatasets: status?.indexed ?? 0,
    objects: status?.objects ?? 0,
    billing: {
      project: billingProject,
      state: state === 'none' ? 'none' : billingNamesOnly ? 'namesOnly' : building && (entry?.phase === 'projects' || entry?.phase === 'names') ? 'building' : 'full'
    },
    starred: {
      count: distinctStarred.length,
      full: Math.max(0, distinctStarred.length - starredNamesOnly),
      namesOnly: starredNamesOnly
    },
    discovered: {
      count: discoveredCount,
      full: Math.max(0, discoveredCount - discoveredNamesOnly),
      namesOnly: discoveredNamesOnly
    }
  }
}

export function classifyQuerySourceHealth(answer: LanguageLookupAnswer | undefined, projectNamesOnly: boolean): QuerySourceHealth {
  if (!answer) return 'notIndexed'
  if (answer.state === 'building') return 'building'
  if (answer.object) return answer.object.detailed && !projectNamesOnly ? 'indexed' : 'namesOnly'
  if (answer.state === 'partial' && projectNamesOnly) return 'namesOnly'
  return 'notIndexed'
}

const phaseLabels: Readonly<Record<NonNullable<IndexEntry['phase']>, string>> = {
  estimate: 'Estimating bulk index',
  projects: 'Discovering projects',
  names: 'Wave 2 · Listing names',
  details: 'Wave 3 · Reading schemas'
}

function StatusBadge({ tone, children }: { readonly tone: StatusTone; readonly children: string }) {
  return <span className="intellisense-popover-pill" data-tone={tone}>{children}</span>
}

function IndexMemoryBar({ usage }: { readonly usage: MemoryUsage }) {
  const level = memoryLevel(usage, 'index')
  const available = level !== 'unavailable' && usage.globalBytes > 0
  const percent = available ? Math.min(100, Math.max(0, Math.round((usage.usedBytes / usage.globalBytes) * 100))) : 0
  const format = panelBytes(available ? usage.globalBytes : 512 * 1024 * 1024)
  const reading = available ? `${format(usage.usedBytes)} / ${format(usage.globalBytes)}` : 'Unavailable'
  return <div className="intellisense-popover-memory">
    <div className="intellisense-popover-memory-head">
      <span>Shared index budget</span>
      <span className="intellisense-popover-memory-value">{reading}</span>
    </div>
    <div className="intellisense-popover-bar" role="progressbar" aria-label="Shared index memory usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} data-level={level}>
      <span style={{ '--intellisense-fill': `${percent}%` } as CSSProperties} />
    </div>
  </div>
}

export interface IntelliSensePopoverProps {
  readonly open: boolean
  readonly popoverId: string
  readonly triggerRef: RefObject<HTMLButtonElement | null>
  readonly active: QueryTab
  readonly isBigQuery: boolean
  readonly language?: SqlStatusItem
  readonly issues?: SqlStatusItem
  readonly sqlSetting: 'textEditor.googleSql.dryRunDiagnostics' | 'textEditor.sql.errorChecking'
  readonly onClose: (restoreFocus?: boolean) => void
}

/**
 * Unified Calm Pro Status Bar IntelliSense Popover for both BigQuery (PR #738 3-wave summary, shared 512 MiB memory bar,
 * active query source health) and SQL Server (STS provider status, IndexLookup DB coverage, shared memory bar).
 */
export default function IntelliSensePopover({ open, popoverId, triggerRef, active, isBigQuery, language, issues, sqlSetting, onClose }: IntelliSensePopoverProps) {
  const { commands, connections, documents, indexCompletion, objectSearch, indexMemory, bigQueryStarred, menus } = useWorkbench()
  const searchSnap = useServiceSnapshot(objectSearch ?? emptySearchStore)
  const memoryUsage = useServiceSnapshot(indexMemory ?? emptyMemoryStore)
  const starredSnap = useServiceSnapshot(bigQueryStarred ?? emptyStarredStore)
  const liveConnections = useServiceSnapshot(connections)
  const canRefresh = useCommandEnabled('edit.refreshIntelliSense', { tabId: active.id })
  const canNextIssue = useCommandEnabled('edit.nextSqlIssue')
  const refreshKey = useKeybindingLabel('edit.refreshIntelliSense')
  const nextIssueKey = useKeybindingLabel('edit.nextSqlIssue')
  const headingId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const [sourceHealth, setSourceHealth] = useState<ReadonlyMap<string, QuerySourceHealth>>(() => new Map())
  const [starring, setStarring] = useState<ReadonlySet<string>>(() => new Set())

  const connection = active.connectionId ? liveConnections.find(entry => entry.id === active.connectionId) : undefined
  const connected = !!connection && isLiveConnection(connection)
  const indexEntry = connection ? searchSnap.indexes[connection.id] : undefined
  const principal = connection?.authentication?.principal.provider === 'bigquery' ? connection.authentication.principal.principal : connection?.principalId
  const starredProjects = useMemo(() => {
    if (!isBigQuery || !principal) return []
    return starredSnap.byPrincipal[principal] ?? []
  }, [isBigQuery, principal, starredSnap])

  const defaultDataset = /^\w{1,1024}$/.test(active.database ?? '') ? active.database : undefined
  const querySources = useMemo(() => {
    if (!open || !isBigQuery || !connection || !isBigQueryConnection(connection)) return []
    const text = documents.getModel(active.id)?.getValue() ?? ''
    return extractBigQueryQuerySources(text, connection.server, defaultDataset)
  }, [open, isBigQuery, connection, documents, active.id, defaultDataset])

  useEffect(() => {
    if (!open || !isBigQuery || !connected || !querySources.length || typeof indexCompletion.lookupDocument !== 'function') {
      setSourceHealth(new Map())
      return
    }
    let cancelled = false
    const namesOnly = new Set(indexEntry?.status?.namesOnly ?? [])
    void indexCompletion.lookupDocument(active.id, querySources.map(source => ({ path: [source.project, source.dataset, source.name], limit: 1 })))
      .then(answers => {
        if (cancelled) return
        const next = new Map<string, QuerySourceHealth>()
        querySources.forEach((source, index) => {
          next.set(source.path, classifyQuerySourceHealth(answers?.[index], namesOnly.has(source.project)))
        })
        setSourceHealth(next)
      })
      .catch(() => { if (!cancelled) setSourceHealth(new Map()) })
    return () => { cancelled = true }
  }, [open, isBigQuery, connected, querySources, indexCompletion, active.id, indexEntry?.status?.builtAt, indexEntry?.status?.objects, indexEntry?.status?.namesOnly])

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current, trigger = triggerRef.current
    if (!panel) return
    const doc = panel.ownerDocument
    const dismiss = () => onClose(false)
    const escape = () => onClose(true)
    if (modalOpen() || menus?.ownsKeyboard()) { dismiss(); return }
    const onPointerDown = (event: PointerEvent) => {
      const path = event.composedPath()
      if ((trigger && path.includes(trigger)) || path.includes(panel)) return
      dismiss()
    }
    doc.addEventListener('pointerdown', onPointerDown, true)
    const watcher = typeof CloseWatcher === 'function' ? new CloseWatcher() : undefined
    watcher?.addEventListener('close', escape)
    const modalWatcher = watchModals(doc, dismiss)
    const stopMenus = menus?.controller.subscribe(() => { if (menus.ownsKeyboard()) dismiss() })
    return () => {
      doc.removeEventListener('pointerdown', onPointerDown, true)
      watcher?.destroy()
      modalWatcher.dispose()
      stopMenus?.()
    }
  }, [open, triggerRef, menus, onClose])

  if (!open) return null

  const waves = isBigQuery && connection ? summarizeBigQueryWaves(connection.server, indexEntry, starredProjects) : undefined
  const headerTone: StatusTone = issues && /\berrors?\b/i.test(issues.label) ? 'critical'
    : (language?.label === 'IntelliSense unavailable' || issues?.label === 'SQL analysis unavailable' || issues?.label === 'Dry run unavailable' || (issues && /\bwarnings?\b/i.test(issues.label))) ? 'warning'
      : (language?.label === 'IntelliSense refreshing' || language?.label === 'IntelliSense loading' || language?.label === 'IntelliSense indexing' || language?.label === 'IntelliSense starting') ? 'running'
        : (!connected || language?.label === 'IntelliSense off' || language?.label === 'IntelliSense paused' || language?.label === 'IntelliSense disconnected') ? 'neutral'
          : 'success'

  const headerStatusText = !connected
    ? 'Disconnected'
    : isBigQuery && waves
      ? waves.state === 'building'
        ? `Indexing · ${waves.done.toLocaleString('en-US')}/${waves.total.toLocaleString('en-US')}`
        : waves.state === 'ready'
          ? `Ready · ${waves.totalProjects.toLocaleString('en-US')} ${waves.totalProjects === 1 ? 'project' : 'projects'}`
          : 'Index not built'
      : language?.label === 'IntelliSense'
        ? 'STS + Index Ready'
        : (language?.label ?? 'Ready')

  const handleRefresh = () => {
    onClose(true)
    void commands.execute('edit.refreshIntelliSense', { tabId: active.id }, 'toolbar')
  }
  const handleSettings = () => {
    onClose(false)
    void commands.execute('preferences.options', { setting: sqlSetting }, 'toolbar')
  }
  const handleBuildIndex = () => {
    if (!connection || !objectSearch) return
    objectSearch.ensureIndex(connection.id)
  }
  const handleStarProject = (project: string) => {
    if (!connection || !principal || !bigQueryStarred || starring.has(project)) return
    setStarring(prev => new Set(prev).add(project))
    void bigQueryStarred.setStarred(connection.id, principal, project, true)
      .finally(() => {
        setStarring(prev => {
          const next = new Set(prev)
          next.delete(project)
          return next
        })
      })
  }

  const sqlStatus = indexEntry?.status
  const sqlIndexBuilding = !!indexEntry?.requestId || sqlStatus?.state === 'building'
  const sqlIndexReady = !sqlIndexBuilding && sqlStatus?.state === 'ready'
  const sqlProviderTone: StatusTone = !connected ? 'neutral'
    : language?.label === 'IntelliSense unavailable' ? 'warning'
      : language?.label === 'IntelliSense off' || language?.label === 'IntelliSense paused' ? 'neutral'
        : language?.label === 'IntelliSense refreshing' || language?.label === 'IntelliSense loading' || language?.label === 'IntelliSense starting' ? 'running'
          : 'success'
  const sqlProviderText = !connected ? 'Disconnected'
    : language?.label === 'IntelliSense' ? 'SQL Tools Service'
      : (language?.label ?? 'SQL Tools Service')

  const portalTarget = triggerRef.current?.ownerDocument.body ?? (typeof document !== 'undefined' ? document.body : undefined)
  if (!portalTarget) return null

  return createPortal(
    <section ref={panelRef} id={popoverId} className="intellisense-popover" role="dialog" aria-modal="false" aria-labelledby={headingId}>
      <header className="intellisense-popover-header">
        <div className="intellisense-popover-title-row">
          <h2 id={headingId}>{isBigQuery ? 'BigQuery IntelliSense' : 'SQL Server IntelliSense'}</h2>
          <StatusBadge tone={headerTone}>{headerStatusText}</StatusBadge>
        </div>
        <button type="button" className="intellisense-popover-close" aria-label="Close IntelliSense status" onClick={() => onClose(true)}>
          <Icon name="close" />
        </button>
      </header>

      {isBigQuery ? (
        <>
          <div className="intellisense-popover-section">
            <div className="intellisense-popover-section-head">
              <span>Search Objects Index (3 Waves)</span>
              {waves?.phase && waves.state === 'building' && <span className="intellisense-popover-meta">{phaseLabels[waves.phase]}</span>}
              {waves && waves.state === 'ready' && <span className="intellisense-popover-meta">{waves.objects.toLocaleString('en-US')} objects</span>}
            </div>
            {connected && waves ? (
              <div className="intellisense-popover-rows" role="list" aria-label="BigQuery index tiers">
                <div className="intellisense-popover-row" role="listitem">
                  <span className="intellisense-popover-name">
                    <span className="intellisense-popover-mono">{waves.billing.project}</span>
                    <span className="intellisense-popover-muted">Wave 1 · billing</span>
                  </span>
                  <StatusBadge tone={waves.billing.state === 'full' ? 'success' : waves.billing.state === 'building' ? 'running' : waves.billing.state === 'namesOnly' ? 'warning' : 'neutral'}>
                    {waves.billing.state === 'full' ? 'Full' : waves.billing.state === 'building' ? 'Indexing' : waves.billing.state === 'namesOnly' ? 'Names only' : 'Not built'}
                  </StatusBadge>
                </div>
                <div className="intellisense-popover-row" role="listitem">
                  <span className="intellisense-popover-name">
                    <Icon name="star-full" />
                    <span>{waves.starred.count.toLocaleString('en-US')} starred {waves.starred.count === 1 ? 'project' : 'projects'}</span>
                    <span className="intellisense-popover-muted">Wave 3a</span>
                  </span>
                  <StatusBadge tone={waves.starred.count === 0 ? 'neutral' : waves.starred.namesOnly > 0 ? 'warning' : 'success'}>
                    {waves.starred.count === 0 ? 'None' : waves.starred.namesOnly > 0 ? `${waves.starred.full} full · ${waves.starred.namesOnly} cap` : 'Full'}
                  </StatusBadge>
                </div>
                <div className="intellisense-popover-row" role="listitem">
                  <span className="intellisense-popover-name">
                    <span>{waves.discovered.count.toLocaleString('en-US')} discovered</span>
                    <span className="intellisense-popover-muted">Wave 3b</span>
                  </span>
                  <StatusBadge tone={waves.discovered.count === 0 ? 'neutral' : waves.discovered.namesOnly > 0 ? 'warning' : 'success'}>
                    {waves.discovered.count === 0 ? 'None' : waves.discovered.namesOnly > 0 ? `${waves.discovered.full} full · ${waves.discovered.namesOnly} cap` : `${waves.discovered.full} full`}
                  </StatusBadge>
                </div>
              </div>
            ) : (
              <p className="intellisense-popover-note">Connect this query to BigQuery to inspect index coverage and refresh schema caches.</p>
            )}
            <IndexMemoryBar usage={memoryUsage} />
          </div>

          <div className="intellisense-popover-section">
            <div className="intellisense-popover-section-head">
              <span>Active Query Sources ({querySources.length})</span>
              <span className="intellisense-popover-meta">Local RAM index</span>
            </div>
            {querySources.length ? (
              <div className="intellisense-popover-sources" role="listbox" aria-label="Active query sources">
                {querySources.map(source => {
                  const health = sourceHealth.get(source.path) ?? 'notIndexed'
                  const canStar = connected && !!principal && !!bigQueryStarred && source.project !== connection?.server && !starredProjects.includes(source.project) && health !== 'indexed'
                  const healthLabel = health === 'indexed' ? 'Indexed' : health === 'namesOnly' ? 'Names only' : health === 'building' ? 'Indexing' : 'Not indexed'
                  const healthTone: StatusTone = health === 'indexed' ? 'success' : health === 'building' ? 'running' : health === 'namesOnly' ? 'warning' : 'neutral'
                  return <div key={source.path} className="intellisense-popover-row" role="option" aria-selected={false}>
                    <span className="intellisense-popover-mono intellisense-popover-source-path" title={source.path}>{source.path}</span>
                    <span className="intellisense-popover-source-actions">
                      {canStar && <button type="button" className="intellisense-popover-inline-action" disabled={starring.has(source.project)}
                        onClick={() => handleStarProject(source.project)}><Icon name="star-empty" /><span>Star</span></button>}
                      <StatusBadge tone={healthTone}>{healthLabel}</StatusBadge>
                    </span>
                  </div>
                })}
              </div>
            ) : (
              <p className="intellisense-popover-note">No BigQuery tables referenced in the active query yet.</p>
            )}
          </div>
        </>
      ) : (
        <div className="intellisense-popover-section">
          <div className="intellisense-popover-section-head">
            <span>Providers &amp; Index</span>
            {sqlStatus && sqlStatus.objects > 0 && <span className="intellisense-popover-meta">{sqlStatus.objects.toLocaleString('en-US')} objects</span>}
          </div>
          <div className="intellisense-popover-rows" role="listbox" aria-label="SQL Server IntelliSense providers">
            <div className="intellisense-popover-row" role="option" aria-selected={false}>
              <span>Language provider</span>
              <StatusBadge tone={sqlProviderTone}>{sqlProviderText}</StatusBadge>
            </div>
            <div className="intellisense-popover-row" role="option" aria-selected={false}>
              <span>Schema preview drawer</span>
              <StatusBadge tone={!connected ? 'neutral' : sqlIndexBuilding ? 'running' : sqlIndexReady ? 'success' : 'neutral'}>
                {!connected ? 'Disconnected' : sqlIndexBuilding ? 'Indexing' : sqlIndexReady ? 'IndexLookup (RAM)' : 'Not built'}
              </StatusBadge>
            </div>
            <div className="intellisense-popover-row" role="option" aria-selected={false}>
              <span>Indexed databases</span>
              <span className="intellisense-popover-source-actions">
                {connected && !sqlIndexReady && !sqlIndexBuilding && objectSearch && (
                  <button type="button" className="intellisense-popover-inline-action" onClick={handleBuildIndex}>Build index</button>
                )}
                <span className="intellisense-popover-meta">
                  {!connected ? 'Not connected'
                    : sqlIndexBuilding ? `${(indexEntry?.done ?? 0).toLocaleString('en-US')} / ${(indexEntry?.total ?? 0).toLocaleString('en-US')} building`
                      : sqlStatus && sqlStatus.state === 'ready'
                        ? `${sqlStatus.indexed.toLocaleString('en-US')} / ${sqlStatus.databases.toLocaleString('en-US')} ready${sqlStatus.skipped.length ? ` · ${sqlStatus.skipped.length} skipped` : ''}`
                        : 'Not built'}
                </span>
              </span>
            </div>
          </div>
          {language?.detail && (language.label === 'IntelliSense unavailable' || language.label === 'IntelliSense off' || language.label === 'IntelliSense paused') && (
            <p className="intellisense-popover-note">{language.detail}</p>
          )}
          <IndexMemoryBar usage={memoryUsage} />
        </div>
      )}

      {issues && (/\berrors?\b|\bwarnings?\b/i.test(issues.label) || issues.label === 'SQL analysis incomplete' || issues.label === 'SQL analysis unavailable' || issues.label === 'Dry run unavailable') && (
        <div className="intellisense-popover-section intellisense-popover-issues">
          <div className="intellisense-popover-row">
            <span>{issues.label}</span>
            {canNextIssue && !isBigQuery && (
              <button type="button" className="intellisense-popover-inline-action" onClick={() => { onClose(false); void commands.execute('edit.nextSqlIssue', undefined, 'toolbar') }}>
                Next issue{nextIssueKey ? ` (${nextIssueKey.text})` : ''}
              </button>
            )}
          </div>
          {issues.detail && <p className="intellisense-popover-note">{issues.detail}</p>}
        </div>
      )}

      <footer className="intellisense-popover-footer">
        <button type="button" className="intellisense-popover-primary" disabled={!canRefresh} onClick={handleRefresh}>
          <Icon name="refresh" />
          <span>{isBigQuery ? 'Refresh Cache' : 'Refresh Local Cache'}</span>
          {refreshKey && <kbd className="intellisense-popover-kbd">{refreshKey.text}</kbd>}
        </button>
        <button type="button" className="intellisense-popover-secondary" onClick={handleSettings}>
          <Icon name="settings-gear" />
          <span>Settings</span>
        </button>
      </footer>
    </section>,
    portalTarget
  )
}
