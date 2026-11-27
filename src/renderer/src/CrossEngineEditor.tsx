import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { editor } from 'monaco-editor'
import { checkCrossEngineReadOnly, parseCrossEngineSql, type ReadOnlyViolation } from '../../shared/multi-query'
import type { ProviderId } from '../../shared/providers'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import { createQueryEditor, type QueryEditorInstance } from './editor/create-editor'
import { AreaContext } from './editor-groups/EditorArea'
import Icon from './Icon'
import { requestMultiTargetPopover, resolveMultiTargets } from './MultiTargetPopover'

/** Dedicated Monaco marker owner for the live Cross-Engine read-only guard. */
export const crossEngineGuardOwner = 'varia-cross-engine-guard'
/** Debounce delay (ms) before re-evaluating live read-only diagnostics on typing. */
export const crossEngineGuardDebounceMs = 150
/** Container width (px) at or below which Dual-Dialect Split auto-stacks Transact-SQL above GoogleSQL. */
export const crossEngineStackBreakpointPx = 680

export interface CrossEngineViolation extends ReadOnlyViolation {
  readonly dialect: ProviderId
}

export interface CrossEngineGuardState {
  readonly sqlViolations: readonly CrossEngineViolation[]
  readonly bqViolations: readonly CrossEngineViolation[]
  readonly parseError?: string
}

const offsetViolation = (violation: ReadOnlyViolation, startLine: number, dialect: ProviderId): CrossEngineViolation => ({
  ...violation,
  line: violation.line + startLine - 1,
  endLine: violation.endLine + startLine - 1,
  dialect
})

/** Evaluates read-only guard violations for a Cross-Engine tab in either Split or canonical `-- #Dialect` File mode. */
export function evaluateCrossEngineGuard(input: {
  readonly crossView: 'split' | 'file'
  readonly primaryText: string
  readonly secondaryText?: string
}): CrossEngineGuardState {
  if (input.crossView === 'file') {
    const parsed = parseCrossEngineSql(input.primaryText)
    if (!parsed.ok) return { sqlViolations: [], bqViolations: [], parseError: parsed.reason }
    const sqlViolations = checkCrossEngineReadOnly(parsed.sqlserver, 'sqlserver')
      .map(violation => offsetViolation(violation, parsed.sqlServerStartLine, 'sqlserver'))
    const bqViolations = checkCrossEngineReadOnly(parsed.bigquery, 'bigquery')
      .map(violation => offsetViolation(violation, parsed.bigQueryStartLine, 'bigquery'))
    return { sqlViolations, bqViolations }
  }
  const sqlViolations = checkCrossEngineReadOnly(input.primaryText, 'sqlserver')
    .map(violation => ({ ...violation, dialect: 'sqlserver' as const }))
  const bqViolations = checkCrossEngineReadOnly(input.secondaryText ?? '', 'bigquery')
    .map(violation => ({ ...violation, dialect: 'bigquery' as const }))
  return { sqlViolations, bqViolations }
}

/** Converts read-only guard violations to Monaco marker data under `crossEngineGuardOwner`. */
export function toGuardMarkers(violations: readonly ReadOnlyViolation[], severity = 8): editor.IMarkerData[] {
  return violations.map(violation => ({
    severity,
    message: violation.message,
    startLineNumber: violation.line,
    startColumn: violation.column,
    endLineNumber: violation.endLine,
    endColumn: violation.endLine === violation.line
      ? Math.max(violation.endColumn, violation.column + 1)
      : Math.max(violation.endColumn, 1),
    source: 'Cross-Engine Read-Only Guard',
    code: 'READ_ONLY_VIOLATION'
  }))
}

/** Collapses one or more violations in a pane into one calm summary sentence. */
export function formatGuardSummary(violations: readonly ReadOnlyViolation[]): string {
  if (!violations.length) return ''
  const first = violations[0]!
  const count = violations.length
  return `Read-only guard (${count} blocked, first on Line ${first.line}): ${first.message}`
}

export interface CrossEngineEditorProps {
  readonly tabId: string
  readonly visible: boolean
  /** Slot ref owned by EditorArea's DocumentPanel for mounting the group's primary Monaco editor. */
  readonly primarySlotRef: RefObject<HTMLDivElement | null>
  /** Called when focus enters either pane so inactive split groups activate cleanly. */
  readonly onActivate?: () => void
  /** Optional hook invoked when the user clicks "Open in SQL Server tab" or "Open in BigQuery tab" in a guard strip. */
  readonly onOpenInSingleEngine?: (dialect: ProviderId, sql: string) => void
}

/**
 * Dual-Dialect Split (`Transact-SQL` | `GoogleSQL`) and canonical `-- #Dialect` File editor for Cross-Engine SELECT
 * tabs. Manages the secondary Monaco editor lifecycle, synchronous `activePane` focus updates, responsive auto-stacking
 * (`<= 680 px`), pane-targeted drag-and-drop attributes (`data-cross-dialect`), and the debounced 150 ms live read-only
 * guard with dedicated Monaco markers (`varia-cross-engine-guard`).
 */
export default function CrossEngineEditor({ tabId, visible, primarySlotRef, onActivate, onOpenInSingleEngine }: CrossEngineEditorProps) {
  const area = useContext(AreaContext)
  const areaRef = useRef(area)
  areaRef.current = area
  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate
  const workbench = useWorkbench()
  const { documents, connections: connectionService, targets: targetService, queries, theme, monaco } = workbench
  const docSnapshot = useServiceSnapshot(documents)
  const connections = useServiceSnapshot(connectionService)
  const rememberedTargets = useServiceSnapshot(targetService)
  const queryState = useServiceSnapshot(queries)
  useServiceSnapshot(theme)

  const tab = docSnapshot.documents.find(doc => doc.id === tabId)
  const crossView: 'split' | 'file' = tab?.crossView === 'file' ? 'file' : 'split'
  const activePane: 'primary' | 'secondary' = tab?.activePane === 'secondary' ? 'secondary' : 'primary'
  const running = !!queryState[tabId]?.running
  const locked = running || docSnapshot.busy

  const rootRef = useRef<HTMLDivElement>(null)
  const secondarySlotRef = useRef<HTMLDivElement>(null)
  const secondaryEditorRef = useRef<QueryEditorInstance | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [manualStacked, setManualStacked] = useState<boolean | undefined>(undefined)
  const [switchError, setSwitchError] = useState<string | undefined>(undefined)
  const [guard, setGuard] = useState<CrossEngineGuardState>({ sqlViolations: [], bqViolations: [] })
  const nextIndexRef = useRef<{ sqlserver: number; bigquery: number; file: number }>({ sqlserver: 0, bigquery: 0, file: 0 })

  const autoStacked = containerWidth > 0 && containerWidth <= crossEngineStackBreakpointPx
  const stacked = manualStacked ?? autoStacked

  // Observe container width for responsive auto-stacking <= 680 px.
  useLayoutEffect(() => {
    const node = rootRef.current
    if (!node) return
    const update = () => {
      const width = node.clientWidth
      if (width > 0) setContainerWidth(width)
    }
    update()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // Mount, bind, and dispose the secondary Monaco editor in Split mode.
  useLayoutEffect(() => {
    if (crossView !== 'split') return
    const slot = secondarySlotRef.current
    if (!slot || !monaco?.editor?.create) return
    const element = slot.ownerDocument.createElement('div')
    element.className = 'editor-host'
    slot.append(element)
    const created = createQueryEditor(workbench, element, { ariaLabel: 'GoogleSQL query editor' })
    secondaryEditorRef.current = created
    const binding = documents.bindSecondaryEditor(created.instance, tabId)
    documents.showIn(created.instance, tabId, 'secondary')
    areaRef.current?.syncStatus()
    const focusSub = created.instance.onDidFocusEditorWidget(() => {
      documents.setActivePane(tabId, 'secondary')
      onActivateRef.current?.()
      areaRef.current?.syncStatus()
    })
    created.setVisible(visible)
    return () => {
      focusSub.dispose()
      binding.dispose()
      documents.unbindSecondaryEditor(created.instance)
      created.dispose()
      element.remove()
      if (secondaryEditorRef.current === created) secondaryEditorRef.current = null
      areaRef.current?.syncStatus()
    }
    // `visible` and `onActivate` are synchronized below without recreating the Monaco instance.
  }, [crossView, tabId, workbench, documents, monaco])

  useEffect(() => {
    secondaryEditorRef.current?.setVisible(visible)
    if (visible && crossView === 'split' && secondaryEditorRef.current) {
      documents.showIn(secondaryEditorRef.current.instance, tabId, 'secondary')
    }
  }, [visible, crossView, tabId, documents])

  // Live Cross-Engine read-only guard: immediate on mount/view switch, debounced 150 ms on content changes.
  const runGuard = useCallback(() => {
    const primaryModel = documents.getModel(tabId)
    const secondaryModel = documents.getSecondaryModel(tabId)
    if (!primaryModel) return
    const evaluated = evaluateCrossEngineGuard({
      crossView,
      primaryText: primaryModel.getValue(),
      secondaryText: secondaryModel?.getValue()
    })
    setGuard(evaluated)
    nextIndexRef.current = { sqlserver: 0, bigquery: 0, file: 0 }
    const setMarkers = monaco?.editor?.setModelMarkers
    if (!setMarkers) return
    const severity = monaco.MarkerSeverity?.Error ?? 8
    if (crossView === 'file') {
      const combined = [...evaluated.sqlViolations, ...evaluated.bqViolations].sort((a, b) => a.line - b.line || a.column - b.column)
      setMarkers(primaryModel, crossEngineGuardOwner, toGuardMarkers(combined, severity))
    } else {
      setMarkers(primaryModel, crossEngineGuardOwner, toGuardMarkers(evaluated.sqlViolations, severity))
      if (secondaryModel) {
        setMarkers(secondaryModel, crossEngineGuardOwner, toGuardMarkers(evaluated.bqViolations, severity))
      }
    }
  }, [documents, tabId, crossView, monaco])

  useEffect(() => {
    runGuard()
    let timer: ReturnType<typeof setTimeout> | undefined
    const subscription = documents.onDidChangeContent(tabId, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        runGuard()
      }, crossEngineGuardDebounceMs)
    })
    return () => {
      if (timer) clearTimeout(timer)
      subscription.dispose()
      const setMarkers = monaco?.editor?.setModelMarkers
      if (!setMarkers) return
      const primaryModel = documents.getModel(tabId)
      const secondaryModel = documents.getSecondaryModel(tabId)
      if (primaryModel && !primaryModel.isDisposed?.()) setMarkers(primaryModel, crossEngineGuardOwner, [])
      if (secondaryModel && !secondaryModel.isDisposed?.()) setMarkers(secondaryModel, crossEngineGuardOwner, [])
    }
  }, [runGuard, documents, tabId, monaco])

  const resolvedTargets = useMemo(
    () => tab ? resolveMultiTargets(tab, connections, rememberedTargets) : [],
    [tab, connections, rememberedTargets]
  )
  const enabledSql = useMemo(() => resolvedTargets.filter(item => item.target.enabled && item.target.provider === 'sqlserver'), [resolvedTargets])
  const enabledBq = useMemo(() => resolvedTargets.filter(item => item.target.enabled && item.target.provider === 'bigquery'), [resolvedTargets])

  if (!tab) return null

  const switchView = (nextView: 'split' | 'file') => {
    if (nextView === crossView) return
    const result = documents.setCrossView(tabId, nextView)
    if (!result.ok) {
      setSwitchError(result.reason)
      return
    }
    setSwitchError(undefined)
  }

  const removeTarget = (targetIndex: number, button?: HTMLButtonElement | null) => {
    if (locked) return
    const chips = button?.closest<HTMLElement>('.cross-engine-chips') ?? null
    const buttonsBefore = chips ? [...chips.querySelectorAll<HTMLButtonElement>('.cross-engine-chip-remove')] : []
    const removedPos = button ? buttonsBefore.indexOf(button) : -1
    documents.setMultiTargets(tabId, (tab.multiTargets ?? []).filter((_, index) => index !== targetIndex))
    if (!chips) return
    const restoreFocus = () => {
      if (!chips.isConnected) return
      const remaining = [...chips.querySelectorAll<HTMLButtonElement>('.cross-engine-chip-remove:not(:disabled)')]
      const next = remaining.length > 0
        ? remaining[Math.max(0, Math.min(removedPos >= 0 ? removedPos : 0, remaining.length - 1))]
        : chips.querySelector<HTMLButtonElement>('.cross-engine-add-btn:not(:disabled)') ?? chips.querySelector<HTMLButtonElement>('.cross-engine-add-btn')
      next?.focus({ preventScroll: true })
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restoreFocus)
    else restoreFocus()
  }

  const jumpToNextBlocked = (scope: 'sqlserver' | 'bigquery' | 'file', violations: readonly CrossEngineViolation[]) => {
    if (!violations.length) return
    const index = nextIndexRef.current[scope] % violations.length
    nextIndexRef.current[scope] = (index + 1) % violations.length
    const hit = violations[index]!
    const pane: 'primary' | 'secondary' = scope === 'bigquery' ? 'secondary' : 'primary'
    if (crossView === 'split') documents.setActivePane(tabId, pane)
    onActivate?.()
    const instance = documents.editorOf(tabId, pane) ?? (pane === 'secondary' ? secondaryEditorRef.current?.instance : undefined) ?? documents.boundEditor
    if (!instance) return
    instance.setPosition({ lineNumber: hit.line, column: hit.column })
    instance.revealLineInCenter(hit.line)
    instance.focus()
  }

  const openInSingleEngine = (dialect: ProviderId) => {
    if (docSnapshot.busy) return
    const scripts = documents.getCrossEngineScripts(tabId)
    const sql = scripts.ok
      ? (dialect === 'bigquery' ? scripts.bigquery : scripts.sqlserver)
      : (dialect === 'bigquery' ? (documents.getSecondaryModel(tabId)?.getValue() ?? '') : (documents.getModel(tabId)?.getValue() ?? ''))
    if (onOpenInSingleEngine) {
      onOpenInSingleEngine(dialect, sql)
      return
    }
    const matching = (tab.multiTargets ?? []).filter(target => target.enabled && target.provider === dialect)
    const baseName = tab.name.replace(/\.sql$/i, '')
    const name = `${baseName}_${dialect === 'bigquery' ? 'BigQuery' : 'SqlServer'}.sql`
    const eol = documents.getModel(tabId)?.getEOL() === '\r\n' ? 'crlf' : 'lf'
    if (matching.length >= 2) {
      documents.openMultiQuery({ mode: 'same', targets: matching, name, sql, provider: dialect, unsaved: sql.length > 0, eol })
      return
    }
    const first = matching[0]
    if (first?.connectionId && connectionService.isLive(first.connectionId)) {
      documents.create(name, sql, first.database || (dialect === 'bigquery' ? '' : 'master'), first.connectionId, sql.length > 0, undefined, eol)
      return
    }
    documents.reopen({
      name,
      kind: 'sql',
      text: sql,
      eol,
      dirty: sql.length > 0,
      database: first?.database || (dialect === 'bigquery' ? '' : 'master'),
      provider: dialect,
      ...first?.lastServer ? { server: first.lastServer } : {},
      ...first?.targetId ? { targetId: first.targetId, ...first.attachWanted !== undefined ? { attachWanted: first.attachWanted } : {} } : {}
    })
  }

  const renderTargetChips = (dialect: ProviderId, items: typeof resolvedTargets, emptyLabel: string) => {
    const allTargets = tab.multiTargets ?? []
    return <div className="cross-engine-chips">
      {items.map((item, idx) => {
        const targetIndex = allTargets.indexOf(item.target)
        const swatch = theme.accent(item.color)
        const dbText = item.target.database || (dialect === 'bigquery' ? 'no default dataset' : 'master')
        return <span key={`${item.target.connectionId ?? item.target.targetId ?? item.name}-${idx}`} className="cross-engine-chip" data-live={item.live || undefined} title={`${item.name} · ${dbText}`}>
          {swatch && <span className="cross-engine-chip-dot" style={{ background: swatch }} aria-hidden="true" />}
          <span className="cross-engine-chip-name">{item.name}</span>
          <span className="cross-engine-chip-db">{`· ${dbText}`}</span>
          {!item.live && <span className="cross-engine-chip-offline">Disconnected</span>}
          {targetIndex >= 0 && <button type="button" className="cross-engine-chip-remove" aria-label={`Remove ${item.name}`} disabled={locked} onClick={event => removeTarget(targetIndex, event.currentTarget)}>
            <Icon name="close" />
          </button>}
        </span>
      })}
      <button
        type="button"
        className={items.length ? 'cross-engine-add-btn' : 'cross-engine-add-btn is-empty'}
        disabled={locked}
        onClick={() => {
          onActivate?.()
          requestMultiTargetPopover(tabId, dialect)
        }}>
        {items.length ? '+ Add / Change' : emptyLabel}
      </button>
    </div>
  }

  const renderGuardStrip = (scope: 'sqlserver' | 'bigquery' | 'file', violations: readonly CrossEngineViolation[], openDialect: ProviderId) => {
    if (!violations.length) return null
    const openLabel = openDialect === 'bigquery' ? 'Open in BigQuery tab' : 'Open in SQL Server tab'
    return <div className="cross-engine-guard-strip" role="status" data-guard-scope={scope}>
      <Icon name="error" className="cross-engine-guard-icon" />
      <span className="cross-engine-guard-text">{formatGuardSummary(violations)}</span>
      <div className="cross-engine-guard-actions">
        <button type="button" className="ui-button cross-engine-guard-next" onClick={() => jumpToNextBlocked(scope, violations)}>Next blocked</button>
        <button type="button" className="ui-button cross-engine-guard-open" disabled={docSnapshot.busy} onClick={() => openInSingleEngine(openDialect)}>{openLabel}</button>
      </div>
    </div>
  }

  const fileViolations = crossView === 'file'
    ? [...guard.sqlViolations, ...guard.bqViolations].sort((a, b) => a.line - b.line || a.column - b.column)
    : []
  const firstFileDialect: ProviderId = fileViolations[0]?.dialect ?? 'sqlserver'

  return <div className="cross-engine-editor" ref={rootRef} data-cross-view={crossView} data-tab-id={tabId}>
    <div className="cross-engine-bar" role="toolbar" aria-label="Cross-Engine editor layout">
      <div className="cross-engine-view-toggle" role="group" aria-label="Cross-Engine editor view">
        <button
          type="button"
          className="ui-button cross-engine-view-btn"
          aria-pressed={crossView === 'split'}
          onClick={() => switchView('split')}>
          <Icon name="split-horizontal" /><span>Dual-Dialect Split</span>
        </button>
        <button
          type="button"
          className="ui-button cross-engine-view-btn"
          aria-pressed={crossView === 'file'}
          onClick={() => switchView('file')}>
          <Icon name="file-code" /><span>-- #Dialect File</span>
        </button>
      </div>
      {crossView === 'split' && <button
        type="button"
        className="ui-button cross-engine-stack-btn"
        aria-pressed={stacked}
        title={stacked ? 'Switch to side-by-side panes' : 'Stack Transact-SQL above GoogleSQL'}
        onClick={() => setManualStacked(!stacked)}>
        <Icon name="layout" /><span>Stack vertically</span>
      </button>}
      <span className="cross-engine-bar-counts" aria-hidden="true">
        {`${enabledSql.length} SQL · ${enabledBq.length} BigQuery`}
      </span>
    </div>

    {switchError && <div className="cross-engine-info-strip is-warning" role="alert">
      <Icon name="warning" />
      <span>{`Cannot switch to Split view: ${switchError}`}</span>
      <button type="button" className="icon-button cross-engine-strip-dismiss" aria-label="Dismiss notice" onClick={() => setSwitchError(undefined)}>
        <Icon name="close" />
      </button>
    </div>}

    {crossView === 'split' ? (
      <div className="cross-engine-panes" data-layout={stacked ? 'vertical' : 'horizontal'}>
        <div
          className={activePane === 'primary' ? 'cross-engine-pane is-active' : 'cross-engine-pane'}
          data-cross-dialect="sqlserver"
          data-document-id={tabId}
          onFocusCapture={() => { documents.setActivePane(tabId, 'primary'); onActivate?.(); areaRef.current?.syncStatus() }}>
          <div className="cross-engine-pane-header">
            {renderTargetChips('sqlserver', enabledSql, '+ Pick SQL Server…')}
            <span className="cross-engine-dialect-tag">Transact-SQL</span>
          </div>
          {renderGuardStrip('sqlserver', guard.sqlViolations, 'sqlserver')}
          <div className="editor-container cross-engine-editor-slot" ref={primarySlotRef} data-document-id={tabId} data-cross-dialect="sqlserver" />
        </div>

        <div
          className={activePane === 'secondary' ? 'cross-engine-pane is-active' : 'cross-engine-pane'}
          data-cross-dialect="bigquery"
          data-document-id={tabId}
          onFocusCapture={() => { documents.setActivePane(tabId, 'secondary'); onActivate?.(); areaRef.current?.syncStatus() }}>
          <div className="cross-engine-pane-header">
            {renderTargetChips('bigquery', enabledBq, '+ Pick BigQuery…')}
            <span className="cross-engine-dialect-tag">GoogleSQL</span>
          </div>
          {renderGuardStrip('bigquery', guard.bqViolations, 'bigquery')}
          <div className="editor-container cross-engine-editor-slot" ref={secondarySlotRef} data-document-id={tabId} data-cross-dialect="bigquery" />
        </div>
      </div>
    ) : (
      <div className="cross-engine-file-wrap" data-document-id={tabId}>
        <div className="cross-engine-info-strip" role="status">
          <Icon name="info" />
          <span>Switch to Split view for per-dialect IntelliSense and syntax checking.</span>
          <button type="button" className="ui-button cross-engine-switch-btn" onClick={() => switchView('split')}>Switch to Split view</button>
        </div>
        {guard.parseError && <div className="cross-engine-info-strip is-warning" role="status">
          <Icon name="warning" />
          <span>{guard.parseError}</span>
        </div>}
        {renderGuardStrip('file', fileViolations, firstFileDialect)}
        <div className="editor-container cross-engine-editor-slot" ref={primarySlotRef} data-document-id={tabId} />
      </div>
    )}
  </div>
}
