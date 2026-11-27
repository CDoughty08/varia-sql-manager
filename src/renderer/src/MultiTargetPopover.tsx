import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { DatabaseInfo } from '../../shared/contracts'
import { targetServerName, type ConnectionTarget } from '../../shared/connection-targets'
import { environmentPreset } from '../../shared/environments'
import type { ProviderId } from '../../shared/providers'
import type { MultiDocumentTarget, QueryTab } from './documents'
import { modalOpen } from './core/modal'
import { watchModals, windows } from './core/windows'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import EnvironmentTag from './EnvironmentTag'
import Icon from './Icon'
import { isBigQueryConnection, isLiveConnection } from './services/connection-availability'
import type { LiveConnection } from './services/connections'
import type { DatabaseLists } from './services/database-list'
import { trapFocus } from './trap-focus'

// Chromium handles Escape through close requests, independently of the menu's visual layer.
declare const CloseWatcher: (new () => EventTarget & { destroy(): void }) | undefined

export const maxMultiTargets = 32
const metadataLoadConcurrency = 3
const filterThreshold = 8

type OpenRequestListener = (tabId: string, provider?: ProviderId) => boolean
const openRequestListeners = new Set<OpenRequestListener>()
let pendingOpen: { readonly tabId: string; readonly provider?: ProviderId } | undefined
let pendingOpenCancel: (() => void) | undefined

const clearPendingOpen = () => {
  pendingOpen = undefined
  pendingOpenCancel?.()
  pendingOpenCancel = undefined
}

/** Asks the mounted MultiTargetPopover for `tabId` (e.g. from CrossEngineEditor's "+ Add / Change" button) to open. */
export function requestMultiTargetPopover(tabId: string, provider?: ProviderId): void {
  clearPendingOpen()
  let matched = false
  for (const listener of [...openRequestListeners]) {
    if (listener(tabId, provider)) matched = true
  }
  if (matched) return
  pendingOpen = { tabId, provider }
  if (typeof requestAnimationFrame === 'function') {
    const frame = requestAnimationFrame(() => {
      if (pendingOpen?.tabId === tabId) clearPendingOpen()
    })
    pendingOpenCancel = () => cancelAnimationFrame(frame)
  } else {
    const timer = setTimeout(() => {
      if (pendingOpen?.tabId === tabId) clearPendingOpen()
    }, 0)
    pendingOpenCancel = () => clearTimeout(timer)
  }
}

const keepFocus = (event: PointerEvent<HTMLButtonElement>) => { if (event.button === 0) event.preventDefault() }

export const connectionProvider = (connection: Pick<LiveConnection, 'providerId' | 'options'>): ProviderId =>
  isBigQueryConnection(connection) ? 'bigquery' : 'sqlserver'

export const connectionDisplayName = (connection: Pick<LiveConnection, 'displayName' | 'server'>): string =>
  connection.displayName || connection.server

export interface ResolvedTargetVisual {
  readonly target: MultiDocumentTarget
  readonly connection?: LiveConnection
  readonly remembered?: ConnectionTarget
  readonly live: boolean
  readonly name: string
  readonly host?: string
  readonly environment?: string
  readonly color?: string
}

/** Resolves display name, live connection, environment, and color for each target on a multi-server tab. */
export function resolveMultiTargets(
  tab: Pick<QueryTab, 'multiTargets'>,
  connections: readonly LiveConnection[],
  rememberedTargets: readonly ConnectionTarget[]
): ResolvedTargetVisual[] {
  return (tab.multiTargets ?? []).map(target => {
    const attached = target.connectionId
      ? connections.find(item => item.id === target.connectionId)
      : undefined
    const matched = attached ?? (target.targetId
      ? connections.find(item => item.targetId === target.targetId)
      : undefined)
    const remembered = target.targetId ? rememberedTargets.find(item => item.id === target.targetId) : undefined
    const live = isLiveConnection(attached)
    const host = (remembered ? targetServerName(remembered.options) : undefined) ?? matched?.server ?? target.lastServer
    const displayName = remembered?.details.displayName ?? matched?.displayName
    const name = displayName || host || (target.provider === 'bigquery' ? 'BigQuery project' : 'SQL Server')
    const environment = remembered?.details.environment ?? matched?.options.environment
    const color = remembered?.details.color ?? matched?.color
    return { target, connection: attached, remembered, live, name, host, environment, color }
  })
}

export interface MultiTargetSummaryModel {
  readonly label: string
  readonly shortLabel: string
  readonly enabledCount: number
  readonly connectedCount: number
  readonly sqlCount: number
  readonly bqCount: number
  readonly prodCount: number
  readonly ready: boolean
  readonly colors: readonly (string | undefined)[]
}

/** Computes concise target labels (e.g. "3 SQL Servers (1 PROD)", "1 SQL Server + 1 BigQuery") and swatch list for triggers & tabs. */
export function multiTargetTriggerSummary(
  tab: Pick<QueryTab, 'multiMode' | 'provider' | 'multiTargets'>,
  connections: readonly LiveConnection[],
  rememberedTargets: readonly ConnectionTarget[]
): MultiTargetSummaryModel {
  const resolved = resolveMultiTargets(tab, connections, rememberedTargets)
  const enabled = resolved.filter(item => item.target.enabled)
  const enabledCount = enabled.length
  const connectedCount = enabled.filter(item => item.live).length
  const sqlTargets = enabled.filter(item => item.target.provider === 'sqlserver')
  const bqTargets = enabled.filter(item => item.target.provider === 'bigquery')
  const sqlCount = sqlTargets.length
  const bqCount = bqTargets.length
  const prodCount = enabled.filter(item => environmentPreset(item.environment) === 'Production').length
  const prodSuffix = prodCount > 0 ? ` (${prodCount} PROD)` : ''
  const colors = enabled.map(item => item.color)

  if (tab.multiMode === 'cross') {
    const ready = sqlTargets.some(item => item.live) && bqTargets.some(item => item.live)
    const base = `${sqlCount} ${sqlCount === 1 ? 'SQL Server' : 'SQL Servers'} + ${bqCount} BigQuery`
    return {
      label: `${base}${prodSuffix}`,
      shortLabel: base,
      enabledCount,
      connectedCount,
      sqlCount,
      bqCount,
      prodCount,
      ready,
      colors
    }
  }

  const provider: ProviderId = enabled[0]?.target.provider ?? tab.provider ?? tab.multiTargets?.[0]?.provider ?? 'sqlserver'
  const noun = provider === 'bigquery'
    ? (enabledCount === 1 ? 'BigQuery project' : 'BigQuery projects')
    : (enabledCount === 1 ? 'SQL Server' : 'SQL Servers')
  const ready = connectedCount > 0
  const base = enabledCount === 0 ? 'No targets' : `${enabledCount} ${noun}`
  return {
    label: enabledCount === 0 ? base : `${base}${prodSuffix}`,
    shortLabel: base,
    enabledCount,
    connectedCount,
    sqlCount,
    bqCount,
    prodCount,
    ready,
    colors
  }
}

/**
 * Finds database names shared across all enabled live SQL Server targets (>= 2) for the "Apply database to all" action.
 * Matches case-insensitively while preserving the first target's canonical casing.
 */
export function findSharedSqlDatabases(
  targets: readonly MultiDocumentTarget[],
  connections: readonly LiveConnection[],
  databaseLists: DatabaseLists
): string[] {
  const enabledSql = targets.filter(target =>
    target.enabled && target.provider === 'sqlserver' && !!target.connectionId && isLiveConnection(connections.find(c => c.id === target.connectionId))
  )
  if (enabledSql.length < 2) return []

  const sets = enabledSql.map(target => {
    const listed = (databaseLists.get(target.connectionId!) ?? []).map(db => db.name)
    const names = target.database && !listed.some(name => name.toLowerCase() === target.database.toLowerCase())
      ? [target.database, ...listed]
      : listed
    const map = new Map<string, string>()
    for (const name of names) {
      const key = name.trim().toLowerCase()
      if (key && !map.has(key)) map.set(key, name)
    }
    return map
  })

  const first = sets[0]!
  const shared: string[] = []
  for (const [key, canonical] of first) {
    if (sets.every(set => set.has(key))) shared.push(canonical)
  }
  return shared
}

/** Resolves a database name to a server's own canonical casing from its loaded database list, if present. */
export function canonicalDatabaseName(
  connectionId: string | undefined,
  database: string,
  databaseLists: DatabaseLists
): string {
  if (!connectionId) return database
  const key = database.trim().toLowerCase()
  const match = (databaseLists.get(connectionId) ?? []).find(db => db.name.trim().toLowerCase() === key)
  return match ? match.name : database
}

/** Appends a new target while keeping stored entries within `limit` by pruning a disabled entry first when needed. */
export function appendMultiTarget(
  targets: readonly MultiDocumentTarget[],
  added: MultiDocumentTarget,
  limit = maxMultiTargets
): MultiDocumentTarget[] {
  const next = [...targets]
  while (next.length >= limit) {
    const disabledIndex = next.findIndex(item => !item.enabled)
    if (disabledIndex < 0) break
    next.splice(disabledIndex, 1)
  }
  if (next.length >= limit) return next
  return [...next, added]
}

/** Runs `load` over `connectionIds` with bounded concurrency so the metadata lane is never flooded. */
export function loadDatabaseListsBounded(
  connectionIds: readonly string[],
  load: (connectionId: string) => Promise<void>,
  concurrency = metadataLoadConcurrency
): { readonly promise: Promise<void>; cancel(): void } {
  let cancelled = false
  let index = 0
  const limit = Math.max(1, Math.min(concurrency, connectionIds.length))
  const worker = async () => {
    while (!cancelled && index < connectionIds.length) {
      const id = connectionIds[index++]!
      try { await load(id) } catch { /* DatabaseListService handles load errors */ }
    }
  }
  const promise = connectionIds.length
    ? Promise.all(Array.from({ length: limit }, () => worker())).then(() => undefined)
    : Promise.resolve()
  return { promise, cancel: () => { cancelled = true } }
}

interface PopoverRow {
  readonly key: string
  readonly provider: ProviderId
  readonly live: boolean
  readonly detached: boolean
  readonly connection?: LiveConnection
  readonly target?: MultiDocumentTarget
  readonly targetIndex?: number
  readonly name: string
  readonly host?: string
  readonly environment?: string
  readonly color?: string
  readonly enabled: boolean
  readonly database: string
}

export interface MultiTargetPopoverProps {
  readonly tabId: string
  readonly variant?: 'bar' | 'classic'
  readonly onActivate?: () => void
  readonly onReconnectTarget?: (target: MultiDocumentTarget, offlineConnectionId?: string) => void
}

/**
 * Target & Database/Dataset picker popover for Same-Engine Multi-Server and Cross-Engine SELECT tabs.
 * Portaled to `trigger.ownerDocument.body`, clamped to viewport, lazy-loads database lists with bounded concurrency,
 * includes quick filter when > 8 targets, one-click Reconnect for disconnected targets, and "Apply database to all"
 * when >= 2 enabled SQL Server targets share a matching database name.
 */
export default function MultiTargetPopover({ tabId, variant = 'bar', onActivate, onReconnectTarget }: MultiTargetPopoverProps) {
  const workbench = useWorkbench()
  const { documents, connections: connectionService, targets: targetService, databaseList, queries, commands, menus, theme } = workbench
  const docSnapshot = useServiceSnapshot(documents)
  const connections = useServiceSnapshot(connectionService)
  const rememberedTargets = useServiceSnapshot(targetService)
  const databaseLists = useServiceSnapshot(databaseList)
  const queryState = useServiceSnapshot(queries)
  useServiceSnapshot(theme)

  const tab = docSnapshot.documents.find(doc => doc.id === tabId)
  const busy = docSnapshot.busy
  const running = !!queryState[tabId]?.running
  const locked = running || busy

  const popoverId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const filterInput = useRef<HTMLInputElement>(null)
  const openedByKeyboard = useRef(false)
  const focusOnOpen = useRef(false)
  const inFlightRef = useRef<Set<string>>(new Set())
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [coords, setCoords] = useState<{ top: number; left: number; maxHeight: number } | undefined>()
  const [sharedChoice, setSharedChoice] = useState('')
  const [loadingIds, setLoadingIds] = useState<ReadonlySet<string>>(() => new Set())

  const close = useCallback((returnFocus = false) => {
    setOpen(false)
    setCoords(undefined)
    setFilter('')
    if (returnFocus) trigger.current?.focus({ preventScroll: true })
    openedByKeyboard.current = false
    focusOnOpen.current = false
  }, [])

  useEffect(() => {
    close(false)
    setSharedChoice('')
  }, [tabId, close])

  const openPopover = useCallback((fromKeyboard: boolean) => {
    if (modalOpen() || menus?.ownsKeyboard?.()) return
    onActivate?.()
    openedByKeyboard.current = fromKeyboard
    focusOnOpen.current = true
    setOpen(true)
  }, [menus, onActivate])

  useEffect(() => {
    const listener: OpenRequestListener = requestedTabId => {
      if (requestedTabId !== tabId) return false
      openPopover(false)
      return true
    }
    openRequestListeners.add(listener)
    if (pendingOpen?.tabId === tabId) {
      clearPendingOpen()
      openPopover(false)
    }
    return () => { openRequestListeners.delete(listener) }
  }, [tabId, openPopover])

  const summary = useMemo(
    () => tab ? multiTargetTriggerSummary(tab, connections, rememberedTargets) : undefined,
    [tab, connections, rememberedTargets]
  )

  const isCross = tab?.multiMode === 'cross'
  const tabProvider: ProviderId = tab?.provider ?? tab?.multiTargets?.[0]?.provider ?? 'sqlserver'

  const rows = useMemo((): PopoverRow[] => {
    if (!tab?.multiMode) return []
    const tabTargets = tab.multiTargets ?? []
    const matchedTargetIndices = new Set<number>()
    const result: PopoverRow[] = []

    const eligibleLive = connections.filter(conn => {
      if (!isLiveConnection(conn)) return false
      const prov = connectionProvider(conn)
      return isCross || prov === tabProvider
    })

    for (const conn of eligibleLive) {
      const prov = connectionProvider(conn)
      let targetIndex = tabTargets.findIndex((item, index) => !matchedTargetIndices.has(index) && item.connectionId === conn.id)
      if (targetIndex < 0 && conn.targetId) {
        targetIndex = tabTargets.findIndex((item, index) => !matchedTargetIndices.has(index) && item.targetId === conn.targetId)
      }
      const target = targetIndex >= 0 ? tabTargets[targetIndex] : undefined
      if (targetIndex >= 0) matchedTargetIndices.add(targetIndex)
      result.push({
        key: `live:${conn.id}`,
        provider: prov,
        live: true,
        detached: !!target?.enabled && target.connectionId !== conn.id,
        connection: conn,
        target,
        targetIndex: targetIndex >= 0 ? targetIndex : undefined,
        name: connectionDisplayName(conn),
        host: conn.server,
        environment: conn.options.environment,
        color: conn.color,
        enabled: !!target?.enabled && target?.connectionId === conn.id,
        database: target?.database ?? (prov === 'bigquery' ? (conn.database || '') : (conn.database || 'master'))
      })
    }

    // Include any disconnected / lost / hint-only targets belonging to this tab.
    for (let index = 0; index < tabTargets.length; index++) {
      if (matchedTargetIndices.has(index)) continue
      const target = tabTargets[index]!
      const offlineConn = target.connectionId
        ? connections.find(c => c.id === target.connectionId)
        : target.targetId
          ? connections.find(c => c.targetId === target.targetId)
          : undefined
      const remembered = target.targetId ? rememberedTargets.find(item => item.id === target.targetId) : undefined
      const host = (remembered ? targetServerName(remembered.options) : undefined) ?? offlineConn?.server ?? target.lastServer
      const name = remembered?.details.displayName ?? offlineConn?.displayName ?? host ?? (target.provider === 'bigquery' ? 'BigQuery project' : 'SQL Server')
      result.push({
        key: `offline:${index}:${target.targetId ?? target.lastServer ?? index}`,
        provider: target.provider,
        live: false,
        detached: false,
        connection: offlineConn,
        target,
        targetIndex: index,
        name,
        host,
        environment: remembered?.details.environment ?? offlineConn?.options.environment,
        color: remembered?.details.color ?? offlineConn?.color,
        enabled: target.enabled,
        database: target.database
      })
    }
    return result
  }, [tab, connections, rememberedTargets, isCross, tabProvider])

  const showFilter = rows.length > filterThreshold
  const normalizedFilter = filter.trim().toLowerCase()
  const filteredRows = useMemo(() => {
    if (!normalizedFilter) return rows
    return rows.filter(row =>
      row.name.toLowerCase().includes(normalizedFilter)
      || (row.host?.toLowerCase().includes(normalizedFilter) ?? false)
      || (row.environment?.toLowerCase().includes(normalizedFilter) ?? false)
      || row.database.toLowerCase().includes(normalizedFilter)
    )
  }, [rows, normalizedFilter])

  const sharedSqlDatabases = useMemo(
    () => tab?.multiTargets ? findSharedSqlDatabases(tab.multiTargets, connections, databaseLists) : [],
    [tab?.multiTargets, connections, databaseLists]
  )

  useEffect(() => {
    if (!sharedSqlDatabases.length) {
      if (sharedChoice) setSharedChoice('')
      return
    }
    if (!sharedChoice || !sharedSqlDatabases.includes(sharedChoice)) {
      const existingCaseMatch = sharedChoice
        ? sharedSqlDatabases.find(db => db.toLowerCase() === sharedChoice.toLowerCase())
        : undefined
      const firstEnabledSqlDb = tab?.multiTargets?.find(t => t.enabled && t.provider === 'sqlserver')?.database
      const preferred = existingCaseMatch ?? (firstEnabledSqlDb ? sharedSqlDatabases.find(db => db.toLowerCase() === firstEnabledSqlDb.toLowerCase()) : undefined)
      setSharedChoice(preferred ?? sharedSqlDatabases[0]!)
    }
  }, [sharedSqlDatabases, sharedChoice, tab?.multiTargets])

  // Lazy-load missing database/dataset lists when popover opens, bounded to avoid flooding the metadata lane.
  const ensureDatabaseList = useCallback((connectionIds: readonly string[]) => {
    const snapshot = databaseList.getSnapshot()
    const missing = [...new Set(connectionIds)].filter(id => !snapshot.has(id) && !inFlightRef.current.has(id))
    if (!missing.length) return () => {}
    const task = loadDatabaseListsBounded(missing, async id => {
      if (databaseList.getSnapshot().has(id) || inFlightRef.current.has(id)) return
      inFlightRef.current.add(id)
      setLoadingIds(prev => { const next = new Set(prev); next.add(id); return next })
      try { await databaseList.reload(id) }
      finally {
        inFlightRef.current.delete(id)
        setLoadingIds(prev => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    }, metadataLoadConcurrency)
    return () => task.cancel()
  }, [databaseList])

  const liveIdsKey = useMemo(
    () => rows.filter(row => row.live && row.connection).map(row => row.connection!.id).join(','),
    [rows]
  )

  useEffect(() => {
    if (!open || !liveIdsKey) return
    return ensureDatabaseList(liveIdsKey.split(','))
  }, [open, liveIdsKey, ensureDatabaseList])

  // Positioning & dismiss lifecycle (matching QueryBar's PlanMenuButton).
  useLayoutEffect(() => {
    if (!open) return
    const button = trigger.current, panel = popover.current
    if (!button || !panel) return
    const place = () => {
      const own = button.ownerDocument, view = own.defaultView ?? window, box = button.getBoundingClientRect()
      const inset = 8, gap = 4
      const width = Math.min(panel.offsetWidth || 380, view.innerWidth - inset * 2)
      const body = panel.querySelector<HTMLElement>('.multi-target-popover-body')
      const measuredHeight = body ? (panel.offsetHeight - body.clientHeight + body.scrollHeight) : panel.scrollHeight
      const naturalHeight = measuredHeight > 0 ? measuredHeight : 320
      const below = Math.max(120, view.innerHeight - box.bottom - gap - inset)
      const above = Math.max(120, box.top - gap - inset)
      const up = naturalHeight > below && above > below
      const maxHeight = Math.min(460, up ? above : below)
      const placedHeight = Math.min(naturalHeight, maxHeight)
      const left = Math.max(inset, Math.min(box.right - width, view.innerWidth - width - inset))
      const top = up ? Math.max(inset, box.top - gap - placedHeight) : box.bottom + gap
      setCoords(current => current && current.top === top && current.left === left && current.maxHeight === maxHeight ? current : { top, left, maxHeight })
    }
    place()
    const own = button.ownerDocument, view = own.defaultView ?? window
    const onOutside = (event: globalThis.PointerEvent) => {
      const path = event.composedPath()
      if (!path.includes(button) && !path.includes(panel)) close(false)
    }
    const onScroll = (event: Event) => {
      const NodeCtor = view.Node ?? Node
      if (!(event.target instanceof NodeCtor && panel.contains(event.target))) place()
    }
    const onCloseRequest = () => close(openedByKeyboard.current || panel.contains(own.activeElement))
    const onBlur = () => close(false)
    own.addEventListener('pointerdown', onOutside, true)
    const watcher = typeof CloseWatcher === 'function' ? new CloseWatcher() : undefined
    watcher?.addEventListener('close', onCloseRequest)
    view.addEventListener('resize', place)
    own.addEventListener('scroll', onScroll, true)
    view.addEventListener('blur', onBlur)
    const modals = watchModals(own, () => close(false))
    const adoption = windows.onDidAdopt(() => close(false))
    const stopMenus = menus?.controller?.subscribe?.(() => { if (menus.ownsKeyboard()) close(false) })
    return () => {
      own.removeEventListener('pointerdown', onOutside, true)
      watcher?.destroy()
      view.removeEventListener('resize', place)
      own.removeEventListener('scroll', onScroll, true)
      view.removeEventListener('blur', onBlur)
      modals.dispose()
      adoption.dispose()
      stopMenus?.()
    }
  }, [menus, open, close, filteredRows.length, sharedSqlDatabases.length])

  const placed = !!coords
  useLayoutEffect(() => {
    if (!open || !placed || !focusOnOpen.current) return
    focusOnOpen.current = false
    if (showFilter && filterInput.current) {
      filterInput.current.focus({ preventScroll: true })
      return
    }
    const focusableSelector = 'input:not(:disabled), select:not(:disabled), button:not(:disabled)'
    const body = popover.current?.querySelector<HTMLElement>('.multi-target-popover-body')
    const bodyFirst = body?.querySelector<HTMLElement>(focusableSelector)
    const dialogFirst = popover.current?.querySelector<HTMLElement>(
      '.multi-target-popover-foot button:not(:disabled), input:not(:disabled), select:not(:disabled), button:not(:disabled):not(.multi-target-popover-close)'
    )
    ;(bodyFirst ?? dialogFirst ?? popover.current)?.focus({ preventScroll: true })
  }, [open, placed, showFilter])

  if (!tab || !tab.multiMode || !summary) return null

  const currentTargets = tab.multiTargets ?? []
  const enabledCount = currentTargets.filter(target => target.enabled).length
  const detachedTotal = rows.filter(row => row.detached).length
  const atLimit = enabledCount >= maxMultiTargets

  const toggleRow = (row: PopoverRow, checked: boolean) => {
    if (locked) return
    if (row.targetIndex !== undefined) {
      if (checked && !row.target?.enabled && atLimit) return
      const attach = checked && row.live && row.connection ? row.connection : undefined
      const targetId = attach ? (targetService.targetForConnection(attach.id) ?? attach.targetId) : undefined
      documents.updateMultiTarget(tab.id, row.targetIndex, prev => ({
        ...prev,
        enabled: checked,
        ...attach ? { connectionId: attach.id, ...targetId ? { targetId, attachWanted: true } : {} } : {}
      }))
      return
    }
    if (!checked || !row.live || !row.connection || atLimit) return
    const targetId = targetService.targetForConnection(row.connection.id) ?? row.connection.targetId
    const added: MultiDocumentTarget = {
      ...targetId ? { targetId, attachWanted: true } : {},
      connectionId: row.connection.id,
      database: row.database,
      enabled: true,
      provider: row.provider
    }
    documents.setMultiTargets(tab.id, appendMultiTarget(currentTargets, added, maxMultiTargets))
  }

  const clearDetachedRow = (row: PopoverRow) => {
    if (locked || row.targetIndex === undefined) return
    documents.updateMultiTarget(tab.id, row.targetIndex, { enabled: false })
  }

  const changeRowDatabase = (row: PopoverRow, database: string) => {
    if (locked) return
    if (row.targetIndex !== undefined) {
      documents.updateMultiTarget(tab.id, row.targetIndex, { database })
      if (row.provider === 'sqlserver') {
        const canonical = sharedSqlDatabases.find(db => db.toLowerCase() === database.toLowerCase())
        if (canonical) setSharedChoice(canonical)
      }
    }
  }

  const applyDatabaseToAll = () => {
    if (locked || !sharedChoice) return
    const liveIds = new Set(connections.filter(isLiveConnection).map(c => c.id))
    documents.updateMultiTarget(
      tab.id,
      target => target.enabled && target.provider === 'sqlserver' && !!target.connectionId && liveIds.has(target.connectionId),
      target => ({ ...target, database: canonicalDatabaseName(target.connectionId, sharedChoice, databaseLists) })
    )
  }

  const reconnectRow = (row: PopoverRow) => {
    if (locked || !row.target) return
    close(false)
    if (onReconnectTarget) {
      onReconnectTarget(row.target, row.connection?.id)
      return
    }
    if (row.connection?.lost && row.connection.inExplorer !== false) {
      const reconnectArgs = {
        target: {
          kind: 'explorer' as const,
          node: {
            id: 0,
            kind: 'server' as const,
            connectionId: row.connection.id,
            ref: { type: 'object' as const, object: { kind: 'server' as const } },
            label: row.name,
            lost: true as const,
            ...row.provider === 'bigquery' ? { provider: 'bigquery' as const } : {}
          }
        }
      }
      if (commands.isEnabled('connection.reconnect', reconnectArgs)) {
        void commands.execute('connection.reconnect', reconnectArgs, 'toolbar')
        return
      }
    }
    void commands.execute('connection.connect', undefined, 'toolbar')
  }

  const triggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key === 'ArrowDown') { event.preventDefault(); openPopover(true) }
    else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true) }
  }

  const popoverKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
  }

  const databaseChoicesFor = (row: PopoverRow): readonly string[] => {
    const listed: readonly DatabaseInfo[] = row.live && row.connection ? databaseLists.get(row.connection.id) ?? [] : []
    const names = listed.map(item => item.name)
    const choices = row.database && !names.includes(row.database) ? [row.database, ...names] : names
    if (row.provider === 'bigquery') {
      return choices.includes('') ? choices : ['', ...choices]
    }
    return choices.length ? choices : [row.database || 'master']
  }

  const renderSection = (provider: ProviderId, heading: string, sectionRows: readonly PopoverRow[]) => {
    const activeCount = sectionRows.filter(row => row.enabled || row.detached).length
    const detachedCount = sectionRows.filter(row => row.detached).length
    const isBigQuery = provider === 'bigquery'
    return <div className="multi-target-section" key={provider} data-provider={provider}>
      <div className="multi-target-section-head">
        <Icon name={isBigQuery ? 'bigquery' : 'server'} />
        <span className="multi-target-section-title">{heading}</span>
        <span className="multi-target-section-count">
          {detachedCount > 0 ? `${activeCount} of ${sectionRows.length} selected (${detachedCount} detached)` : `${activeCount} of ${sectionRows.length} selected`}
        </span>
      </div>
      {sectionRows.length === 0
        ? <div className="multi-target-empty">{`No connected ${isBigQuery ? 'BigQuery projects' : 'SQL Servers'} match.`}</div>
        : sectionRows.map(row => {
          const swatch = theme.accent(row.color)
          const choices = databaseChoicesFor(row)
          const isLoading = !!(row.connection && loadingIds.has(row.connection.id))
          const checkDisabled = locked || (!row.enabled && !row.detached && !row.target?.enabled && atLimit)
          const rowClass = row.enabled
            ? 'multi-target-row'
            : row.detached
              ? 'multi-target-row is-detached'
              : 'multi-target-row is-unchecked'
          return <div key={row.key} className={rowClass} data-live={row.live || undefined} data-detached={row.detached || undefined}>
            <input
              type="checkbox"
              className="multi-target-check"
              checked={row.enabled}
              disabled={checkDisabled}
              aria-label={row.detached ? `Re-attach ${row.name}` : `${row.enabled ? 'Disable' : 'Enable'} ${row.name}`}
              onChange={event => toggleRow(row, event.target.checked)}
            />
            {swatch && <span className="multi-target-swatch" style={{ background: swatch }} aria-hidden="true" />}
            <span className="multi-target-name" title={row.host && row.host !== row.name ? `${row.name} (${row.host})` : row.name}>{row.name}</span>
            {row.environment && <EnvironmentTag environment={row.environment} place="list" />}
            {row.live
              ? row.detached
                ? <div className="multi-target-offline">
                  <span className="multi-target-offline-label multi-target-detached-badge">Detached</span>
                  <button
                    type="button"
                    className="ui-button multi-target-reconnect multi-target-clear"
                    disabled={locked}
                    aria-label={`Remove ${row.name}`}
                    onClick={() => clearDetachedRow(row)}>
                    Remove
                  </button>
                </div>
                : <select
                  className="ui-field multi-target-db"
                  aria-label={`${row.name} ${isBigQuery ? 'default dataset' : 'database'}`}
                  title={isLoading ? 'Loading…' : isBigQuery ? `Default dataset: ${row.database || 'none'}` : `Database: ${row.database}`}
                  value={row.database}
                  disabled={locked || !row.enabled}
                  onFocus={() => { if (row.connection) ensureDatabaseList([row.connection.id]) }}
                  onChange={event => changeRowDatabase(row, event.target.value)}>
                  {choices.map(name => <option key={name} value={name}>{name || (isBigQuery ? '<no default dataset>' : name)}</option>)}
                </select>
              : <div className="multi-target-offline">
                <span className="multi-target-offline-label">Disconnected</span>
                <button type="button" className="ui-button multi-target-reconnect" disabled={locked} onClick={() => reconnectRow(row)}>Reconnect</button>
              </div>}
          </div>
        })}
      {provider === 'sqlserver' && sharedSqlDatabases.length > 0 && <div className="multi-target-apply-all">
        {sharedSqlDatabases.length > 1 && <select
          className="ui-field multi-target-shared-select"
          aria-label="Shared database for all SQL Servers"
          value={sharedChoice}
          disabled={locked}
          onChange={event => setSharedChoice(event.target.value)}>
          {sharedSqlDatabases.map(name => <option key={name} value={name}>{name}</option>)}
        </select>}
        <button
          type="button"
          className="ui-button multi-target-apply-btn"
          disabled={locked || !sharedChoice}
          title={`Set every enabled SQL Server target to ${sharedChoice}`}
          onClick={applyDatabaseToAll}>
          {sharedSqlDatabases.length === 1 ? `Apply ${sharedChoice} to all` : 'Apply database to all'}
        </button>
      </div>}
    </div>
  }

  const sqlRows = filteredRows.filter(row => row.provider === 'sqlserver')
  const bqRows = filteredRows.filter(row => row.provider === 'bigquery')
  const visibleSwatches = summary.colors.map(color => theme.accent(color)).filter((color): color is string => !!color).slice(0, 5)
  const host = open ? trigger.current?.ownerDocument.body : undefined

  return <>
    <button
      ref={trigger}
      type="button"
      className={variant === 'classic' ? 'ui-button multi-target-trigger' : 'ui-button query-bar-action multi-target-trigger'}
      aria-label={`Targets: ${summary.label}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? popoverId : undefined}
      data-open={open ? '' : undefined}
      data-cross={isCross ? '' : undefined}
      title={`Configure targets (${summary.label})`}
      onPointerDown={keepFocus}
      onKeyDown={triggerKeyDown}
      onClick={event => {
        if (open) close(event.detail === 0)
        else openPopover(event.detail === 0)
      }}>
      {visibleSwatches.length > 0 && <span className="multi-swatch-stack" aria-hidden="true">
        {visibleSwatches.map((bg, index) => <span key={index} className="multi-swatch" style={{ background: bg }} />)}
      </span>}
      <span className="multi-target-trigger-label">{summary.shortLabel}</span>
      {summary.prodCount > 0 && <span className="multi-target-prod-tag" title={`${summary.prodCount} Production ${summary.prodCount === 1 ? 'target' : 'targets'}`}>
        {`${summary.prodCount} PROD`}
      </span>}
      <Icon name="chevron-down" className="multi-target-chevron" />
    </button>
    {open && host && createPortal(
      <div
        ref={popover}
        id={popoverId}
        className="multi-target-popover"
        role="dialog"
        tabIndex={-1}
        aria-label={isCross ? 'Cross-Engine Targets' : 'Query Targets'}
        style={coords ? { top: `${coords.top}px`, left: `${coords.left}px`, maxHeight: `${coords.maxHeight}px` } : { visibility: 'hidden' }}
        onKeyDown={popoverKeyDown}>
        <div className="multi-target-popover-head">
          <strong className="multi-target-popover-title">
            {`${isCross ? 'Cross-Engine Targets' : 'Query Targets'} (${summary.enabledCount} active${detachedTotal > 0 ? `, ${detachedTotal} detached` : ''})`}
          </strong>
          <button type="button" className="icon-button multi-target-popover-close" aria-label="Close target picker" onClick={() => close(true)}>
            <Icon name="close" />
          </button>
        </div>
        {showFilter && <div className="multi-target-filter">
          <Icon name="search" className="multi-target-filter-icon" />
          <input
            ref={filterInput}
            type="text"
            className="ui-field multi-target-filter-input"
            aria-label="Filter target servers"
            placeholder="Filter servers…"
            value={filter}
            onChange={event => setFilter(event.target.value)}
          />
        </div>}
        <div className="multi-target-popover-body">
          {locked && <div className="multi-target-notice" role="status">Targets are locked while this query is executing.</div>}
          {isCross ? <>
            {renderSection('sqlserver', 'SQL Server (Transact-SQL)', sqlRows)}
            {renderSection('bigquery', 'BigQuery (GoogleSQL)', bqRows)}
          </> : tabProvider === 'bigquery'
            ? renderSection('bigquery', 'Connected BigQuery Projects', bqRows)
            : renderSection('sqlserver', 'Connected SQL Servers', sqlRows)}
        </div>
        <div className="multi-target-popover-foot">
          <span className="multi-target-popover-hint">
            {atLimit
              ? detachedTotal > 0
                ? `Maximum ${maxMultiTargets} targets reached (${detachedTotal} detached)`
                : `Maximum ${maxMultiTargets} targets reached`
              : isCross
                ? detachedTotal > 0
                  ? `Requires ≥1 SQL Server and ≥1 BigQuery (${detachedTotal} detached)`
                  : 'Requires ≥1 SQL Server and ≥1 BigQuery'
                : detachedTotal > 0
                  ? `${summary.connectedCount} of ${summary.enabledCount} connected (${detachedTotal} detached)`
                  : `${summary.connectedCount} of ${summary.enabledCount} connected`}
          </span>
          <button type="button" className="ui-button primary" onClick={() => close(true)}>Done</button>
        </div>
      </div>,
      host
    )}
  </>
}
