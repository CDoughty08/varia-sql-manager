import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { VariaApi } from '../../../shared/contracts'
import { bigQueryPath, isBigQueryName } from '../../../shared/bigquery/names'
import { completeFromIndex } from '../../../shared/completion/complete'
import { definitionFromIndex, IndexUnavailableError } from '../../../shared/completion/definition'
import { datasetMarkdown, escapeMarkdown, hoverColumns, hoverFromIndex, objectMarkdown, projectMarkdown } from '../../../shared/completion/hover'
import { LookupCache, lookupCacheLimits } from '../../../shared/completion/lookup-cache'
import type { CompletionDialect, CompletionItem, CompletionKind, CompletionWord, IndexLookup, QueryScope } from '../../../shared/completion/model'
import { boundedLookup, childrenOf, sameName, ScopeResolver } from '../../../shared/completion/resolve'
import type { BigQueryIndexScope, ObjectIndexStatus } from '../../../shared/explorer/search'
import type { BigQueryScopeRefreshResult } from '../search/ObjectSearchService'
import { googleSqlDialect, quoteGoogleSqlName } from '../../../shared/googlesql/dialect'
import { scanGoogleSql } from '../../../shared/googlesql/lexer'
import { readGoogleSqlCompletion, readGoogleSqlHover, readGoogleSqlStatementSources } from '../../../shared/googlesql/scope'
import { languageLimits } from '../../../shared/language-service'
import { jumpLookupLimits, languageHydrateLimits, languageLookupLimits, type LanguageHydrateOutcome, type LanguageLookupAnswer, type LanguageLookupItem, type LanguageLookupPath } from '../../../shared/language-lookup'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { documentProvider, isQueryDocument } from '../documents'
import type { ConnectionService } from '../services/connections'
import { isBigQueryConnection, isLiveConnection } from '../services/connection-availability'
import type { DocumentService } from '../services/documents'
import { definitionErrors } from './definition'
import { googleSqlLanguageId } from './googlesql'

type LookupApi = Pick<VariaApi, 'languageLookup'> & Partial<Pick<VariaApi, 'languageHydrate'>>
/** Scoped Monaco command ids for one-click JIT hydration and starring on unstarred external BigQuery projects. */
export const hydrateTableCommandId = 'varia.bigquery.hydrateTable'
export const starProjectCommandId = 'varia.bigquery.starProject'

interface Snapshot {
  readonly errors: ReadonlyMap<string, string>
  readonly indexErrors: ReadonlyMap<string, string>
  readonly indexes: ReadonlyMap<string, 'none' | 'building' | 'ready'>
  readonly refreshing: ReadonlySet<string>
}
/** What Go To Definition found in a BigQuery tab: an object of the index, on the tab's connection. */
export interface FoundIndexObject { readonly connectionId: string; readonly kind: string; readonly subtype?: string; readonly project: string; readonly dataset: string; readonly name: string }
interface Target { readonly documentId: string; readonly connectionId?: string; readonly key?: string; readonly project?: string; readonly dataset?: string; readonly dialect: CompletionDialect }
type BigQueryResolveMeta =
  | { readonly kind: 'object'; readonly target: Target; readonly path: readonly [string, string, string] }
  | { readonly kind: 'dataset'; readonly target: Target; readonly project: string; readonly dataset: string }
  | { readonly kind: 'project'; readonly target: Target; readonly project: string }
  | { readonly kind: 'cte'; readonly target: Target; readonly name: string; readonly scope: QueryScope }
export interface IndexStateEntry { readonly requestId?: string; readonly status?: ObjectIndexStatus; readonly error?: string }
export interface IndexStateStore {
  getSnapshot(): { readonly indexes: Readonly<Record<string, IndexStateEntry | undefined>> }
  subscribe(listener: () => void): () => void
  syncStatus?(connectionId: string): void
}
export interface IndexCompletionOptions {
  /** Starts the connection's Search Objects index when it has none (and Options lets builds start on their own). */
  readonly ensureIndex: (connectionId: string) => void
  /** Refreshes the scopes a query tab reads and settles when the refresh completes. */
  readonly refreshScopes?: (connectionId: string, scopes: readonly BigQueryIndexScope[]) => Promise<boolean>
  /** Refreshes scopes and distinguishes deliberate cancellation/disconnect from a backend/index failure. */
  readonly refreshScopesOutcome?: (connectionId: string, scopes: readonly BigQueryIndexScope[]) => Promise<BigQueryScopeRefreshResult>
  /** Search Objects' index state store: updates `Snapshot.indexes` and clears `LookupCache` immediately on build changes. */
  readonly indexState?: IndexStateStore
  /** Whether Options › Text Editor › GoogleSQL auto-hydrates Wave-3-pending / memory-capped tables on demand (default true). */
  readonly jitHydrateEnabled?: () => boolean
  /** Stars an external BigQuery project via PR #738's BigQueryStarredService and starts indexing it. */
  readonly starProject?: (connectionId: string, project: string) => Promise<boolean>
  /** Reports a non-blocking error banner when an explicit one-click JIT hydration fails. */
  readonly reportError?: (message: string) => void
}
/** Lookups in flight at once across every editor: past it, completion answers keywords and functions only, marked incomplete. */
export const indexCompletionLimits = { inFlight: 4, refreshStatements: 32, refreshScopes: 16, jumpCacheEntries: 64 } as const

const kinds: Readonly<Record<CompletionKind, keyof typeof Monaco.languages.CompletionItemKind>> = {
  keyword: 'Keyword', function: 'Function', container: 'Module', table: 'Class', view: 'Interface', routine: 'Method', model: 'Value',
  column: 'Field', field: 'Property', alias: 'Variable', cte: 'Reference'
}
/** Leaf identifier kinds whose completions exit an auto-closed trailing backtick; containers stay inside for `.` chaining. */
const leafKinds: ReadonlySet<CompletionKind> = new Set(['table', 'view', 'routine', 'model', 'column', 'field', 'cte', 'alias'])
const objectLabels: Readonly<Record<string, string>> = {
  bqTable: 'Table', bqView: 'View', bqMaterializedView: 'Materialized view', bqExternalTable: 'External table', bqRoutine: 'Routine', bqModel: 'Model'
}
const subtypeLabels: Readonly<Record<string, string>> = {
  snapshot: 'Snapshot', clone: 'Clone', procedure: 'Procedure', scalar: 'Function', tableValued: 'Table function', aggregate: 'Aggregate function'
}

interface JumpCacheEntry { readonly prefix: string; readonly dataset?: string; readonly answer: LanguageLookupAnswer; readonly at: number }
interface BatchedJumpSlot {
  readonly request: LanguageLookupPath
  consumed: boolean
  readonly promise: Promise<LanguageLookupAnswer | undefined>
  readonly resolve: (answer: LanguageLookupAnswer | undefined) => void
}
interface HydrateTargetRef { readonly project: string; readonly dataset: string; readonly name: string }
interface ProjectRankInfo { readonly tierRank: number; readonly order: number }

/** Formats a BigQuery project's PR #738 tier & wave/memory-cap description for Monaco's structured label. */
export function formatBigQueryProjectDetail(item: LanguageLookupItem): string {
  const base = item.tier === 'billing' ? 'Billing'
    : item.tier === 'starred' ? '★ Starred'
    : item.recent ? 'Recent'
    : item.tier === 'discovered' ? 'Discovered'
    : 'Project'
  const status = item.namesOnly || item.detail === 'names' ? 'Names only · memory cap'
    : item.indexing ? 'Wave 3 indexing…'
    : undefined
  return status ? `${base} · ${status}` : base
}

/** Case-insensitive subsequence match matching the backend's JumpMatchScore so cached jump answers filter cleanly in RAM. */
function jumpMatches(name: string, query: string): boolean {
  if (name.length < query.length) return false
  const lowName = name.toLowerCase(), lowQuery = query.toLowerCase()
  if (lowName.includes(lowQuery)) return true
  let qi = 0
  for (let ni = 0; ni < lowName.length; ni++) {
    if (lowName[ni] === lowQuery[qi] && ++qi === lowQuery.length) return true
  }
  return false
}

/**
 * Completion and hover for BigQuery tabs (the `googlesql` language), Varia's own from the Search Objects index (docs/language-services.md,
 * Completion from the index): the GoogleSQL scope reader reads the caret's statement, and the shared pipeline asks language.lookup for
 * the projects, datasets, tables and columns it needs. When enabled, Wave-3-pending or memory-capped tables referenced in a query
 * are hydrated on demand via free REST `tables.get` / `routines.get` (`language.hydrate`); unstarred external projects offer
 * one-click Fetch schema (free) and ★ Star project actions. SQL Server's tabs keep SqlLanguageService.
 */
export class IndexCompletionService extends SnapshotStore<Snapshot> implements Disposable {
  private readonly bindings: Disposable[] = []
  private readonly caches = new Map<string, LookupCache>()
  private readonly resolveMeta = new WeakMap<Monaco.languages.CompletionItem, BigQueryResolveMeta>()
  private readonly cacheEpoch = new Map<string, number>()
  private readonly jumpCaches = new Map<string, JumpCacheEntry[]>()
  private readonly hydrateAttempted = new Map<string, Set<string>>()
  private readonly externalKnown = new Map<string, Set<string>>()
  private readonly hydrateInFlight = new Map<string, Map<string, Promise<LanguageHydrateOutcome | undefined>>>()
  private readonly ensured = new Set<string>()
  /** Optional sidecar jump request batched into the next `language.lookup` IPC on the current completion turn. */
  private readonly batchedJump = new Map<string, BatchedJumpSlot>()
  /** The connection (and generation) and origin each tab's error came from: it goes when the tab moves, reconnects, or a Search Objects build clears a refresh error. */
  private readonly errorMeta = new Map<string, { readonly key: string; readonly source: 'lookup' | 'refresh' }>()
  private readonly indexSignatures = new Map<string, string>()
  private readonly refreshOps = new Map<string, {
    readonly key: string
    readonly cancel: () => void
    readonly isCancelled: () => boolean
    readonly work: Promise<boolean>
    waiters: number
  }>()
  private inFlight = 0
  private disposed = false

  constructor(private readonly monaco: typeof Monaco, private readonly api: LookupApi, private readonly documents: DocumentService, private readonly connections: ConnectionService,
    private readonly options: IndexCompletionOptions) {
    super({ errors: new Map(), indexErrors: new Map(), indexes: new Map(), refreshing: new Set() })
    this.bindings.push(monaco.languages.registerCompletionItemProvider(googleSqlLanguageId, {
      triggerCharacters: ['.', '`', '@'],
      provideCompletionItems: async (model, position, _context, token) => {
        const target = this.target(model)
        if (!target || token.isCancellationRequested) return { suggestions: [] }
        const text = model.getValue(), offset = model.getOffsetAt(position), version = model.getVersionId()
        let read: ReturnType<typeof readGoogleSqlCompletion>
        try { read = readGoogleSqlCompletion(text, offset) } catch { return { incomplete: true, suggestions: [] } }
        if (read.site.kind === 'none') return { suggestions: [] }

        const projectRanks = new Map<string, ProjectRankInfo>()
        const objectLookups = new Map<string, { readonly path: readonly string[]; readonly answer: LanguageLookupAnswer }>()
        const dialect = wrapProjectTierDialect(target.dialect)
        const baseLookup = this.lookup(target)
        const trackedLookup: IndexLookup = async requests => {
          const answers = await baseLookup(requests)
          if (!answers) return answers
          answers.forEach((answer, idx) => {
            const req = requests[idx]
            if (!req) return
            if (req.path.length === 0 && req.mode !== 'jump') {
              answer.items.forEach((entry, order) => {
                if (entry.kind !== 'bqProject') return
                const tierRank = entry.tier === 'billing' ? 0 : entry.tier === 'starred' ? 1 : entry.recent ? 2 : 3
                projectRanks.set(entry.name, { tierRank, order })
              })
            } else if (req.path.length === 3) {
              objectLookups.set(req.path.join('\u0000'), { path: req.path, answer })
            }
          })
          return answers
        }

        // Cross-project fuzzy table jump on `FROM <2+ chars>` (batched into the same language.lookup IPC when uncached).
        const typedUnquoted = unquoteGoogleSqlName(read.word.typed, read.word.quoted)
        const jumpQuery = typedUnquoted.trim()
        const wantsJump = read.site.kind === 'object'
          && read.site.qualifier.length === 0
          && !typedUnquoted.includes('.')
          && jumpQuery.length >= jumpLookupLimits.minPrefixChars
          && jumpQuery.length <= jumpLookupLimits.maxPrefixChars
          && !!target.connectionId
          && !!target.key
        let jumpAnswer: LanguageLookupAnswer | undefined
        let jumpSlot: BatchedJumpSlot | undefined
        if (wantsJump && target.key) {
          jumpAnswer = this.findJumpCache(target.key, jumpQuery, target.dataset)
          if (!jumpAnswer) {
            let resolveSlot!: (answer: LanguageLookupAnswer | undefined) => void
            const promise = new Promise<LanguageLookupAnswer | undefined>(resolve => { resolveSlot = resolve })
            jumpSlot = {
              request: { path: [], prefix: jumpQuery, mode: 'jump', limit: jumpLookupLimits.items, ...target.dataset ? { dataset: target.dataset } : {} },
              consumed: false,
              promise,
              resolve: resolveSlot
            }
            this.batchedJump.set(target.key, jumpSlot)
          }
        }

        // A failure is a value: an empty list the editor asks for again, never a rejection.
        const epochBefore = target.key ? (this.cacheEpoch.get(target.key) ?? 0) : 0
        let list: Awaited<ReturnType<typeof completeFromIndex>>
        try {
          list = await completeFromIndex(read, dialect, trackedLookup).catch(() => ({ items: [], incomplete: true }))
        } finally {
          if (jumpSlot && target.key && this.batchedJump.get(target.key) === jumpSlot) this.batchedJump.delete(target.key)
        }
        if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return { suggestions: [] }

        if (wantsJump && !jumpAnswer && jumpSlot) {
          if (jumpSlot.consumed) {
            jumpAnswer = await jumpSlot.promise
            if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return { suggestions: [] }
          } else if (target.connectionId && target.key) {
            jumpAnswer = await this.fetchJumpAlone(target.connectionId, target.key, target.documentId, jumpSlot.request)
            if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return { suggestions: [] }
          }
        }

        // Hybrid JIT hydration: auto-hydrate Wave-3-pending / memory-capped tracked tables when enabled,
        // and surface actionable Fetch schema (free) / ★ Star project prompts for unstarred external projects.
        const externalKnown = target.key ? this.externalKnown.get(target.key) : undefined
        const { autoTargets, externalTargets } = classifyLookupTargets(objectLookups, target.project, externalKnown)
        const asksColumns = read.site.kind === 'member' || read.site.kind === 'expression' || read.site.kind === 'joinCondition' || read.site.kind === 'unnestArg'
        if (asksColumns && autoTargets.length > 0 && this.isJitHydrateEnabled() && this.api.languageHydrate && target.connectionId && target.key) {
          let anyHydrated = (this.cacheEpoch.get(target.key) ?? 0) !== epochBefore
          if (!anyHydrated) {
            const outcomes = await this.runAutoHydrate(target.connectionId, target.key, autoTargets)
            if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return { suggestions: [] }
            for (const outcome of outcomes) {
              if (!outcome) continue
              if (outcome.status === 'hydrated' || outcome.status === 'cached') anyHydrated = true
              else if (outcome.status === 'external') {
                if (!externalTargets.some(existing => existing.project === outcome.project && existing.dataset === outcome.dataset && existing.name === outcome.name)) {
                  externalTargets.push({ project: outcome.project, dataset: outcome.dataset, name: outcome.name })
                }
              }
            }
            if ((this.cacheEpoch.get(target.key) ?? 0) !== epochBefore) anyHydrated = true
          }
          if (anyHydrated) {
            list = await completeFromIndex(read, dialect, trackedLookup).catch(() => list)
            if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return { suggestions: [] }
          }
        }

        const start = model.getPositionAt(read.word.start), end = model.getPositionAt(Math.max(read.word.end, offset))
        const insert = { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: position.lineNumber, endColumn: position.column }
        const replace = { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }
        const canExitBacktick = read.word.quoted
          && read.word.end === offset
          && position.column < model.getLineMaxColumn(position.lineNumber)
          && model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column + 1
          }) === '`'

        const suggestions = list.items.map(item => {
          const monacoItem = suggestion(monaco, model, item, { insert, replace }, read.word, canExitBacktick, projectRanks)
          const meta = resolveMetaFor(item, read, target, projectRanks)
          if (meta) this.resolveMeta.set(monacoItem, meta)
          return monacoItem
        })

        // Append deduplicated cross-project fuzzy table jump hits ranked Billing → ★ Starred → Recent → Discovered.
        if (jumpAnswer?.items.length && target.project) {
          const existingDefaultNames = new Set(list.items.filter(item => item.kind !== 'container' && item.kind !== 'cte').map(item => item.label))
          jumpAnswer.items.forEach((hit, index) => {
            if (!hit.project || !hit.dataset) return
            const isDefault = hit.project === target.project && !!target.dataset && hit.dataset.toLowerCase() === target.dataset.toLowerCase()
            if (isDefault && existingDefaultNames.has(hit.name)) return
            const monacoItem = jumpSuggestion(monaco, hit, index, target.project!, { insert, replace }, read.word, canExitBacktick)
            if (target.connectionId && target.key && validLookupSegments([hit.project, hit.dataset, hit.name])) {
              this.resolveMeta.set(monacoItem, { kind: 'object', target, path: [hit.project, hit.dataset, hit.name] })
            }
            suggestions.push(monacoItem)
          })
        }

        // Actionable Fetch schema (free) / ★ Star project items when an unstarred external table (or unhydrated table with auto-hydrate off) has no columns.
        const hasColumns = list.items.some(item => item.kind === 'column' || item.kind === 'field')
        const isMemberSite = read.site.kind === 'member'
        const actionableTargets = externalTargets.length > 0
          ? externalTargets
          : (!this.isJitHydrateEnabled() && isMemberSite && !hasColumns ? autoTargets : [])
        const showActions = asksColumns
          && actionableTargets.length > 0
          && !!target.connectionId
          && (isMemberSite ? !hasColumns : read.word.typed.length === 0)
        if (showActions && target.connectionId) {
          const picked = pickActionTarget(read, target.dialect, actionableTargets)
          if (picked) {
            const actions = actionSuggestions(monaco, target.connectionId, picked, target.project, { insert, replace }, read.word, isMemberSite)
            if (isMemberSite) suggestions.unshift(...actions)
            else suggestions.push(...actions)
          }
        }

        // Every site that reads the index stays incomplete while building; non-empty lists stay incomplete so exact matches re-rank via LookupCache.
        const asksIndex = read.site.kind === 'object' || read.site.kind === 'member' || read.site.kind === 'expression' || read.site.kind === 'joinCondition' || read.site.kind === 'unnestArg'
        const building = target.key && asksIndex ? this.caches.get(target.key)?.index !== 'ready' : false
        return {
          incomplete: suggestions.length > 0 || list.incomplete || !!jumpAnswer?.truncated || building,
          suggestions
        }
      },
      resolveCompletionItem: async (item, token) => this.resolveSuggestion(item, token)
    }), monaco.languages.registerHoverProvider(googleSqlLanguageId, {
      provideHover: async (model, position, token) => {
        const target = this.target(model)
        if (!target || token.isCancellationRequested) return null
        const version = model.getVersionId()
        let read: ReturnType<typeof readGoogleSqlHover>
        try { read = readGoogleSqlHover(model.getValue(), model.getOffsetAt(position)) } catch { return null }
        if (!read) return null
        const objectLookups = new Map<string, { readonly path: readonly string[]; readonly answer: LanguageLookupAnswer }>()
        const baseLookup = this.lookup(target)
        const trackedLookup: IndexLookup = async requests => {
          const answers = await baseLookup(requests)
          if (!answers) return answers
          answers.forEach((answer, idx) => {
            const req = requests[idx]
            if (req?.path.length === 3) objectLookups.set(req.path.join('\u0000'), { path: req.path, answer })
          })
          return answers
        }
        const hover = await hoverFromIndex(read, target.dialect, trackedLookup).catch(() => undefined)
        if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return null
        if (hover) {
          const start = model.getPositionAt(hover.span.start), end = model.getPositionAt(hover.span.end)
          return { contents: [{ value: hover.markdown, isTrusted: false, supportHtml: false }], range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column } }
        }
        // Unstarred external project hover prompt with one-click Fetch schema (free) and ★ Star project links.
        if (target.connectionId) {
          const { externalTargets } = classifyLookupTargets(objectLookups, target.project, target.key ? this.externalKnown.get(target.key) : undefined)
          const hoveredPath = read.object ? target.dialect.objectPath(read.parts) : undefined
          const matched = hoveredPath && hoveredPath.length === 3
            ? externalTargets.find(item => item.project === hoveredPath[0] && item.dataset === hoveredPath[1] && item.name === hoveredPath[2])
            : externalTargets[0]
          if (matched) {
            const start = model.getPositionAt(read.span.start), end = model.getPositionAt(read.span.end)
            const fullName = `${matched.project}.${matched.dataset}.${matched.name}`
            const hydrateArgs = encodeURIComponent(JSON.stringify([target.connectionId, matched.project, matched.dataset, matched.name]))
            const starArgs = encodeURIComponent(JSON.stringify([target.connectionId, matched.project]))
            const links = matched.project !== target.project
              ? `[Fetch schema (free)](command:${hydrateTableCommandId}?${hydrateArgs}) · [★ Star ${matched.project}](command:${starProjectCommandId}?${starArgs})`
              : `[Fetch schema (free)](command:${hydrateTableCommandId}?${hydrateArgs})`
            return {
              contents: [
                {
                  value: `**${escapeMarkdown(fullName)}** · Unstarred external project\n\nNot indexed yet. Fetch this table's columns with a free \`tables.get\` metadata call (0 B billed), or star the project for full indexing.`,
                  isTrusted: false,
                  supportHtml: false
                },
                {
                  value: links,
                  isTrusted: { enabledCommands: [hydrateTableCommandId, starProjectCommandId] },
                  supportHtml: false
                }
              ],
              range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }
            }
          }
        }
        return null
      }
    }))
    if (monaco.editor?.registerCommand) {
      this.bindings.push(
        monaco.editor.registerCommand(hydrateTableCommandId, (_accessor: unknown, connectionId?: unknown, project?: unknown, dataset?: unknown, name?: unknown) => {
          if (typeof connectionId !== 'string' || typeof project !== 'string' || typeof dataset !== 'string' || typeof name !== 'string') return
          void this.hydrateExternal(connectionId, project, dataset, name)
        }),
        monaco.editor.registerCommand(starProjectCommandId, (_accessor: unknown, connectionId?: unknown, project?: unknown) => {
          if (typeof connectionId !== 'string' || typeof project !== 'string') return
          void this.starExternalProject(connectionId, project)
        })
      )
    }
    const reconcile = () => this.reconcile()
    this.bindings.push({ dispose: connections.subscribe(reconcile) }, { dispose: documents.subscribe(reconcile) })
    if (options.indexState) {
      this.bindings.push({ dispose: options.indexState.subscribe(() => this.syncIndexes()) })
      this.syncIndexes()
    }
  }

  /** One-click free `tables.get` / `routines.get` hydration for an external/unindexed table, then re-opens suggest if focused. */
  async hydrateExternal(connectionId: string, project: string, dataset: string, name: string): Promise<boolean> {
    if (this.disposed || !this.api.languageHydrate) return false
    if (!isBigQueryName('project', project) || !isBigQueryName('dataset', dataset) || !(isBigQueryName('table', name) || isBigQueryName('routine', name))) return false
    const connection = this.connections.get(connectionId)
    if (!connection || !isLiveConnection(connection) || !isBigQueryConnection(connection)) return false
    const key = cacheKey(connection)
    const result = await this.api.languageHydrate({
      connectionId,
      targets: [{ project, dataset, name, allowExternal: true }]
    }).catch(() => undefined)
    if (this.disposed) return false
    if (!result) {
      this.options.reportError?.(`Could not fetch metadata for ${project}.${dataset}.${name}.`)
      return false
    }
    if (!result.ok) {
      this.options.reportError?.(result.error || `Could not fetch metadata for ${project}.${dataset}.${name}.`)
      return false
    }
    const outcome = result.value.outcomes[0]
    if (outcome?.status === 'hydrated' || outcome?.status === 'cached') {
      this.externalKnown.get(key)?.delete(hydrateKey({ project, dataset, name }))
      this.clearConnectionCaches(key, false)
      const activeEditor = this.monaco.editor?.getEditors?.().find(editor => editor.hasWidgetFocus?.() || editor.hasTextFocus?.())
      if (activeEditor) activeEditor.trigger('varia.jit', 'editor.action.triggerSuggest', {})
      return true
    }
    this.options.reportError?.(describeHydrateFailure(project, dataset, name, outcome))
    return false
  }

  /** One-click ★ Star project action wired to PR #738's `BigQueryStarredService`. */
  async starExternalProject(connectionId: string, project: string): Promise<boolean> {
    if (this.disposed || !this.options.starProject) return false
    if (!isBigQueryName('project', project)) return false
    const connection = this.connections.get(connectionId)
    if (!connection || !isLiveConnection(connection) || !isBigQueryConnection(connection)) return false
    if (project === connection.server) return false
    const key = cacheKey(connection)
    const ok = await this.options.starProject(connectionId, project).catch(() => false)
    if (this.disposed || !ok) return false
    this.clearConnectionCaches(key, true)
    return true
  }

  /**
   * Go To Definition in a BigQuery tab: the project, dataset and object the name at `position` stands for, from the connection's
   * Search Objects index, as completion resolves names (`definitionFromIndex`). Null when it names no indexed object, undefined
   * when the text changed or `wanted` turned false meanwhile; throws `definitionErrors` when it cannot ask at all or the index
   * could not answer (busy past its in-flight cap, or failed). A model that is no query tab's (Properties' read-only Definition
   * editor) has no connection to ask: null.
   */
  async definition(model: Monaco.editor.ITextModel, position: Monaco.Position, wanted: () => boolean = () => true): Promise<FoundIndexObject | null | undefined> {
    if (model.getValueLength() > languageLimits.documentCharacters) throw new Error(definitionErrors.tooLarge)
    const target = this.target(model)
    if (!target) return null
    const { connectionId } = target
    if (!connectionId) throw new Error(definitionErrors.connectBigQueryFirst)
    const version = model.getVersionId()
    let read: ReturnType<typeof readGoogleSqlHover>
    try { read = readGoogleSqlHover(model.getValue(), model.getOffsetAt(position)) } catch { return null }
    if (!read) return null
    let found
    try { found = await definitionFromIndex(read, target.dialect, this.lookup(target)) }
    catch (error) { if (error instanceof IndexUnavailableError) throw new Error(definitionErrors.indexUnavailable); throw error }
    if (!wanted() || model.isDisposed() || model.getVersionId() !== version) return undefined
    if (!found || found.path.length !== 3) return null
    const [project, dataset, name] = found.path as [string, string, string]
    return { connectionId, kind: found.kind, ...found.subtype ? { subtype: found.subtype } : {}, project, dataset, name }
  }

  /** The status bar's IntelliSense segment for a BigQuery tab, or undefined for any other document (SqlLanguageService's). */
  availability(documentId: string): { label: string; detail: string } | undefined {
    const document = this.documents.get(documentId)
    if (!document || !isQueryDocument(document) || documentProvider(document) !== 'bigquery') return
    const model = this.documents.modelFor ? this.documents.modelFor(documentId, 'bigquery') : this.documents.getModel(documentId)
    if ((model?.getValueLength() ?? 0) > languageLimits.documentCharacters)
      return { label: 'IntelliSense paused', detail: `Language support is available for queries up to ${languageLimits.documentCharacters.toLocaleString('en-US')} characters.` }
    const ctx = model ? this.documents.languageContext?.(model, id => this.connections.isLive(id)) : undefined
    const connectionId = ctx ? ctx.connectionId : document.connectionId
    const connection = connectionId ? this.connections.get(connectionId) : undefined
    if (!connection || !isLiveConnection(connection) || !isBigQueryConnection(connection))
      return { label: 'IntelliSense disconnected', detail: 'Keywords and functions complete. Connect this query to BigQuery for projects, datasets, tables and columns from its Search Objects index.' }
    const snapshot = this.getSnapshot()
    if (snapshot.refreshing.has(documentId))
      return { label: 'IntelliSense refreshing', detail: 'Refreshing schema suggestions for this query’s connection and dataset.' }
    const key = cacheKey(connection)
    const error = snapshot.errors.get(documentId) ?? snapshot.indexErrors.get(key)
    if (error) return { label: 'IntelliSense unavailable', detail: error }
    const index = snapshot.indexes.get(key)
    if (index === 'building') return { label: 'IntelliSense indexing', detail: 'Search Objects is reading this connection’s metadata; suggestions fill in as it reads each dataset. Ctrl+Space opens suggestions.' }
    if (index === 'none') return { label: 'IntelliSense', detail: 'Table and column suggestions come from this connection’s Search Objects index, which has not been built. Build it in Search Objects, or turn on Options › Object Explorer › Index objects when a server connects. Ctrl+Space opens suggestions.' }
    return { label: 'IntelliSense', detail: 'Completion and hover use this connection’s Search Objects index (free metadata reads; nothing runs in BigQuery). Ctrl+Space opens suggestions.' }
  }

  /**
   * Clears the connection's `LookupCache` immediately and triggers a scoped Search Objects refresh for the datasets
   * referenced by `documentId` (or its default dataset / billing project), keeping the query session and unsaved SQL intact.
   */
  async refreshCache(documentId = this.documents.getSnapshot().activeId, token?: Monaco.CancellationToken): Promise<boolean> {
    if (this.disposed || token?.isCancellationRequested) return false
    const document = documentId ? this.documents.get(documentId) : undefined
    const model = document ? (this.documents.modelFor ? this.documents.modelFor(document.id, 'bigquery') : this.documents.getModel(document.id)) : undefined
    if (!document || !isQueryDocument(document) || !model) throw new Error('Open a SQL query to refresh IntelliSense.')
    if (model.getValueLength() > languageLimits.documentCharacters) throw new Error('This query is too large for SQL language support.')
    const ctx = this.documents.languageContext?.(model, id => this.connections.isLive(id))
    const provider = ctx ? (ctx.suspended ? undefined : ctx.provider) : documentProvider(document)
    if (provider !== 'bigquery') throw new Error('The query is unavailable for SQL language support.')
    const connectionId = ctx ? ctx.connectionId : document.connectionId
    const connection = connectionId ? this.connections.get(connectionId) : undefined
    if (!connection || !isLiveConnection(connection) || !isBigQueryConnection(connection)) throw new Error('Connect this query to a live database before refreshing IntelliSense.')
    const key = cacheKey(connection)
    const existing = this.refreshOps.get(document.id)
    let op: {
      readonly key: string
      readonly cancel: () => void
      readonly isCancelled: () => boolean
      work: Promise<boolean>
      waiters: number
    }
    if (existing && existing.key === key && !existing.isCancelled()) {
      op = existing
    } else {
      if (existing) existing.cancel()
      this.clearConnectionCaches(key, true)
      this.failure(document.id, key, undefined)
      const rawDatabase = ctx ? ctx.database : document.database
      const dataset = /^\w{1,1024}$/.test(rawDatabase ?? '') ? rawDatabase : undefined
      const scopes = extractBigQueryRefreshScopes(model.getValue(), connection.server, dataset)
      if (!this.options.refreshScopesOutcome && !this.options.refreshScopes) return true
      let cancelled = false
      let settleCancel = () => {}
      const cancelledPromise = new Promise<BigQueryScopeRefreshResult>(resolve => { settleCancel = () => resolve({ ok: false, cancelled: true }) })
      const cancel = () => { if (cancelled) return; cancelled = true; settleCancel() }
      const created = { key, cancel, isCancelled: () => cancelled, work: Promise.resolve(false), waiters: 0 }
      const refreshCall: Promise<BigQueryScopeRefreshResult> = this.options.refreshScopesOutcome
        ? this.options.refreshScopesOutcome(connection.id, scopes)
        : this.options.refreshScopes!(connection.id, scopes).then(ok => (ok ? { ok: true } : { ok: false, cancelled: true }))
      const work = (async () => {
        try {
          const result = await Promise.race([
            refreshCall,
            cancelledPromise
          ])
          if (cancelled || this.disposed || !this.isCurrentTarget(document.id, key)) return false
          if (result.ok) { this.failure(document.id, key, undefined); return true }
          if (result.cancelled) return false
          const message = result.error || 'The BigQuery index refresh failed.'
          this.failure(document.id, key, message, 'refresh')
          throw new Error(message)
        } catch (error) {
          if (cancelled || this.disposed || !this.isCurrentTarget(document.id, key)) return false
          const message = error instanceof Error && error.message ? error.message : 'The BigQuery index refresh failed.'
          this.failure(document.id, key, message, 'refresh')
          throw error instanceof Error ? error : new Error(message)
        } finally {
          if (this.refreshOps.get(document.id) === created) {
            this.refreshOps.delete(document.id)
            this.publishSnapshot()
          }
          this.clearConnectionCaches(key, true)
        }
      })()
      created.work = work
      op = created
      this.refreshOps.set(document.id, op)
      this.publishSnapshot()
    }
    if (!token) {
      op.waiters++
      return op.work.finally(() => { op.waiters = Math.max(0, op.waiters - 1) })
    }
    return new Promise<boolean>((resolve, reject) => {
      let settled = false
      op.waiters++
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        sub.dispose()
        op.waiters = Math.max(0, op.waiters - 1)
        resolve(ok)
      }
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        sub.dispose()
        op.waiters = Math.max(0, op.waiters - 1)
        reject(error)
      }
      const sub = token.onCancellationRequested(() => {
        finish(false)
        if (op.waiters === 0) op.cancel()
      })
      void op.work.then(
        ok => finish(token.isCancellationRequested ? false : ok),
        error => { if (token.isCancellationRequested) finish(false); else fail(error) }
      )
    })
  }

  /** What a model's requests use: its BigQuery tab, the tab's live connection (if any) and the names it resolves unqualified names to. */
  private target(model: Monaco.editor.ITextModel): Target | undefined {
    if (this.disposed || model.getLanguageId() !== googleSqlLanguageId || model.getValueLength() > languageLimits.documentCharacters) return
    const ctx = this.documents.languageContext(model, id => this.connections.isLive(id))
    if (!ctx || ctx.suspended || ctx.provider !== 'bigquery') return
    const connection = ctx.connectionId ? this.connections.get(ctx.connectionId) : undefined
    if (!connection || !isLiveConnection(connection) || !isBigQueryConnection(connection)) return { documentId: ctx.documentId, dialect: googleSqlDialect({ project: '' }) }
    // The tab's default dataset, as Execute sends it (a dataset id: letters, digits and underscores).
    const dataset = /^\w{1,1024}$/.test(ctx.database ?? '') ? ctx.database : undefined
    return { documentId: ctx.documentId, connectionId: connection.id, key: cacheKey(connection), project: connection.server, dataset, dialect: googleSqlDialect({ project: connection.server, dataset }) }
  }

  /** Lazy schema preview drawer (`resolveCompletionItem`): reads local `LookupCache` / `language.lookup` with 0 BigQuery API calls. */
  private async resolveSuggestion(item: Monaco.languages.CompletionItem, token: Monaco.CancellationToken): Promise<Monaco.languages.CompletionItem> {
    const meta = this.resolveMeta.get(item)
    if (!meta || this.disposed || token.isCancellationRequested) return item
    const { target } = meta
    if (!target.connectionId || !target.key || !this.isCurrentTarget(target.documentId, target.key)) return item
    try {
      const lookup = boundedLookup(this.lookup(target, true))
      let markdown: string | undefined
      if (meta.kind === 'object') {
        const [project, dataset, name] = meta.path
        const answers = await lookup([
          { path: [project, dataset, name], limit: languageLookupLimits.items, details: true },
          { path: [], prefix: project, exact: true, limit: 1 }
        ])
        if (this.disposed || token.isCancellationRequested) return item
        const answer = answers?.[0], proj = answers?.[1]?.items[0]
        if (answer?.object) {
          markdown = objectMarkdown(
            target.dialect,
            answer.path,
            answer.object,
            answer.items.map(entry => ({ path: entry.name, type: entry.type, nullable: entry.nullable, description: entry.description })),
            answer.truncated,
            { tier: proj?.tier, namesOnly: proj?.namesOnly === true || proj?.detail === 'names' }
          )
        }
      } else if (meta.kind === 'dataset') {
        const answers = await lookup([
          { path: [meta.project], prefix: meta.dataset, exact: true, limit: 1 },
          { path: [meta.project, meta.dataset], limit: languageLookupLimits.defaultItems },
          { path: [], prefix: meta.project, exact: true, limit: 1 }
        ])
        if (this.disposed || token.isCancellationRequested) return item
        const dsInfo = answers?.[0]?.items[0], objects = answers?.[1], proj = answers?.[2]?.items[0]
        if (dsInfo || (objects && objects.state !== 'absent')) {
          const resolvedProject = objects?.path[0] ?? proj?.name ?? meta.project
          const resolvedDataset = objects?.path[1] ?? dsInfo?.name ?? meta.dataset
          markdown = datasetMarkdown(target.dialect, resolvedProject, resolvedDataset, dsInfo, objects?.items ?? [], objects?.state ?? 'ready', objects?.truncated ?? false, proj?.tier)
        }
      } else if (meta.kind === 'project') {
        const answers = await lookup([
          { path: [], prefix: meta.project, exact: true, limit: 1 },
          { path: [meta.project], limit: languageLookupLimits.defaultItems }
        ])
        if (this.disposed || token.isCancellationRequested) return item
        const proj = answers?.[0]?.items[0], datasets = answers?.[1]
        if (proj || (datasets && datasets.state !== 'absent')) {
          const resolvedProject = datasets?.path[0] ?? proj?.name ?? meta.project
          markdown = projectMarkdown(target.dialect, resolvedProject, proj, datasets?.items ?? [], datasets?.state ?? 'ready', datasets?.truncated ?? false)
        }
      } else if (meta.kind === 'cte') {
        const resolver = new ScopeResolver(meta.scope, target.dialect, lookup)
        await resolver.load()
        if (this.disposed || token.isCancellationRequested) return item
        const columns = (await resolver.columns({ kind: 'cte', name: meta.name, cte: meta.name })).columns
        if (this.disposed || token.isCancellationRequested) return item
        const allTop = childrenOf(columns, [])
        const top = allTop.slice(0, hoverColumns)
        const more = allTop.length - top.length
        const lines = [`**${escapeMarkdown(meta.name)}** · WITH query`, '', ...(top.length ? top.map(col => `- ${escapeMarkdown(col.path)}${col.type ? ` ${escapeMarkdown(col.type)}` : ''}`) : ['Columns resolved from query.'])]
        if (more > 0) lines.push('', `and ${more.toLocaleString('en-US')} more columns`)
        markdown = lines.join('\n')
      }
      if (!markdown || this.disposed || token.isCancellationRequested) return item
      return { ...item, documentation: { value: markdown, isTrusted: false, supportHtml: false } }
    } catch {
      return item
    }
  }

  /** Cached RAM `language.lookup` for a BigQuery tab (used by the status bar IntelliSense popover's source health list). */
  async lookupDocument(documentId: string, requests: readonly LanguageLookupPath[]): Promise<readonly LanguageLookupAnswer[] | undefined> {
    if (this.disposed || !requests.length) return []
    const model = this.documents.modelFor ? this.documents.modelFor(documentId, 'bigquery') : this.documents.getModel(documentId)
    if (!model) return undefined
    const target = this.target(model)
    if (!target?.connectionId || !target.key) return undefined
    return boundedLookup(this.lookup(target, true))(requests)
  }

  private isJitHydrateEnabled(): boolean {
    return this.options.jitHydrateEnabled ? this.options.jitHydrateEnabled() : true
  }

  private attemptedSet(key: string): Set<string> {
    let set = this.hydrateAttempted.get(key)
    if (!set) { set = new Set(); this.hydrateAttempted.set(key, set) }
    return set
  }

  private externalSet(key: string): Set<string> {
    let set = this.externalKnown.get(key)
    if (!set) { set = new Set(); this.externalKnown.set(key, set) }
    return set
  }

  private recordBounded(set: Set<string>, entry: string): void {
    if (set.has(entry)) { set.delete(entry); set.add(entry); return }
    while (set.size >= languageHydrateLimits.maxNegativeEntries) {
      const oldest = set.values().next().value
      if (oldest === undefined) break
      set.delete(oldest)
    }
    set.add(entry)
  }

  /**
   * Coalesces auto-hydration per `(connectionKey, project, dataset, name)` and invalidates `LookupCache` on completion
   * even if the triggering completion request was cancelled by rapid typing.
   */
  private runAutoHydrate(connectionId: string, key: string, targets: readonly HydrateTargetRef[]): Promise<readonly (LanguageHydrateOutcome | undefined)[]> {
    const hydrate = this.api.languageHydrate
    if (!hydrate) return Promise.resolve([])
    let inFlight = this.hydrateInFlight.get(key)
    if (!inFlight) { inFlight = new Map(); this.hydrateInFlight.set(key, inFlight) }
    const attempted = this.attemptedSet(key)
    const promises: Promise<LanguageHydrateOutcome | undefined>[] = []
    const fresh: HydrateTargetRef[] = []
    for (const item of targets) {
      const k = hydrateKey(item)
      const existing = inFlight.get(k)
      if (existing) { promises.push(existing); continue }
      if (!attempted.has(k) && fresh.length < languageHydrateLimits.targets) fresh.push(item)
    }
    if (fresh.length > 0) {
      for (const item of fresh) this.recordBounded(attempted, hydrateKey(item))
      const batchPromise = hydrate({
        connectionId,
        targets: fresh.map(item => ({ project: item.project, dataset: item.dataset, name: item.name, allowExternal: false }))
      }).catch(() => undefined).then(result => {
        if (this.disposed || !result?.ok) return undefined
        let anyHydrated = false
        for (const outcome of result.value.outcomes) {
          const outcomeKey = hydrateKey(outcome)
          if (outcome.status === 'hydrated' || outcome.status === 'cached') {
            anyHydrated = true
            this.externalKnown.get(key)?.delete(outcomeKey)
          } else if (outcome.status === 'external') {
            this.recordBounded(this.externalSet(key), outcomeKey)
          }
        }
        if (anyHydrated) this.clearConnectionCaches(key, false)
        return result.value.outcomes
      })
      fresh.forEach((item, idx) => {
        const k = hydrateKey(item)
        const tracked = batchPromise.then(outcomes => outcomes?.[idx]).finally(() => {
          const map = this.hydrateInFlight.get(key)
          if (map?.get(k) === tracked) {
            map.delete(k)
            if (map.size === 0) this.hydrateInFlight.delete(key)
          }
        })
        inFlight!.set(k, tracked)
        promises.push(tracked)
      })
    }
    return promises.length > 0 ? Promise.all(promises) : Promise.resolve([])
  }

  private clearConnectionCaches(key: string, resetHydrateAttempts: boolean): void {
    this.cacheEpoch.set(key, (this.cacheEpoch.get(key) ?? 0) + 1)
    this.caches.get(key)?.clear()
    this.jumpCaches.delete(key)
    if (resetHydrateAttempts) {
      this.hydrateAttempted.delete(key)
      this.externalKnown.delete(key)
    }
  }

  private findJumpCache(key: string, prefix: string, dataset?: string): LanguageLookupAnswer | undefined {
    const entries = this.jumpCaches.get(key)
    if (!entries?.length) return undefined
    const now = Date.now()
    const low = prefix.toLowerCase()
    for (const entry of entries) {
      if (now - entry.at > lookupCacheLimits.ttlMs || now < entry.at) continue
      if (entry.dataset !== dataset) continue
      const askedLow = entry.prefix.toLowerCase()
      if (low === askedLow) return entry.answer
      if (!entry.answer.truncated && low.startsWith(askedLow)) {
        return { ...entry.answer, items: entry.answer.items.filter(item => jumpMatches(item.name, prefix)), truncated: false }
      }
    }
    return undefined
  }

  private keepJumpCache(key: string, request: LanguageLookupPath, answer: LanguageLookupAnswer): void {
    const prefix = request.prefix?.trim()
    if (!prefix) return
    const now = Date.now()
    const existing = (this.jumpCaches.get(key) ?? []).filter(entry => now - entry.at <= lookupCacheLimits.ttlMs && !(entry.prefix.toLowerCase() === prefix.toLowerCase() && entry.dataset === request.dataset))
    existing.unshift({ prefix, dataset: request.dataset, answer, at: now })
    if (existing.length > indexCompletionLimits.jumpCacheEntries) existing.length = indexCompletionLimits.jumpCacheEntries
    this.jumpCaches.set(key, existing)
  }

  private async fetchJumpAlone(connectionId: string, key: string, documentId: string | undefined, request: LanguageLookupPath): Promise<LanguageLookupAnswer | undefined> {
    const result = await this.ask(connectionId, key, documentId, [request], true)
    const answer = result?.answers[0]
    if (result?.index === 'ready' && answer && answer.state !== 'building') this.keepJumpCache(key, request, answer)
    return answer
  }

  /** language.lookup for a target, through its connection's cache; a tab without a live connection has no index to ask. */
  private lookup(target: Target, passive = false): IndexLookup {
    const { connectionId, key, documentId } = target
    if (!connectionId || !key) return async () => undefined
    let cache = this.caches.get(key)
    if (!cache) {
      cache = new LookupCache(async (requests, caller) => this.ask(connectionId, key, caller, requests))
      this.caches.set(key, cache)
    }
    const kept = cache
    const caller = passive ? undefined : documentId
    return async requests => {
      const answers = await kept.lookup(requests, caller)
      // A connection reconcile() dropped while this lookup ran is not brought back.
      if (kept.index && this.caches.get(key) === kept && this.getSnapshot().indexes.get(key) !== kept.index) {
        const indexes = new Map(this.getSnapshot().indexes).set(key, kept.index)
        this.publish({ ...this.getSnapshot(), indexes })
      }
      if (kept.index === 'none' && !this.ensured.has(key)) { this.ensured.add(key); this.options.ensureIndex(connectionId) }
      return answers
    }
  }

  /** One language.lookup; its failure (or success) is shown on the tab that asked. Batches any pending cross-project jump into the same IPC call. */
  private async ask(connectionId: string, key: string, documentId: string | undefined, requests: LanguageLookupPath[], isSoloJump = false) {
    if (this.disposed || this.inFlight >= indexCompletionLimits.inFlight) return undefined
    const pending = !isSoloJump && documentId !== undefined ? this.batchedJump.get(key) : undefined
    const attachJump = !!pending && !pending.consumed && requests.length < languageLookupLimits.requests
    const sent = attachJump ? [...requests, pending.request] : requests
    if (attachJump && pending) {
      pending.consumed = true
      if (this.batchedJump.get(key) === pending) this.batchedJump.delete(key)
    }
    this.inFlight++
    let jumpAnswer: LanguageLookupAnswer | undefined
    try {
      const result = await this.api.languageLookup({ connectionId, requests: sent })
      if (this.disposed) return undefined
      this.failure(documentId, key, result.ok ? undefined : result.error, 'lookup')
      if (!result.ok) return undefined
      if (attachJump && pending && result.value.answers.length === sent.length) {
        jumpAnswer = result.value.answers[result.value.answers.length - 1]
        if (result.value.index === 'ready' && jumpAnswer.state !== 'building') this.keepJumpCache(key, pending.request, jumpAnswer)
        return { index: result.value.index, answers: result.value.answers.slice(0, requests.length) }
      }
      return result.value
    } catch (error) {
      this.failure(documentId, key, error instanceof Error ? error.message : 'The index could not answer.', 'lookup')
      return undefined
    } finally {
      this.inFlight--
      if (attachJump && pending) pending.resolve(jumpAnswer)
    }
  }

  private isCurrentTarget(documentId: string, key: string): boolean {
    const model = this.documents.modelFor ? this.documents.modelFor(documentId, 'bigquery') : this.documents.getModel(documentId)
    const ctx = model ? this.documents.languageContext?.(model, id => this.connections.isLive(id)) : undefined
    if (ctx) {
      const connection = !ctx.suspended && ctx.provider === 'bigquery' && ctx.connectionId ? this.connections.get(ctx.connectionId) : undefined
      return !!connection && isLiveConnection(connection) && isBigQueryConnection(connection) && cacheKey(connection) === key
    }
    const document = this.documents.get(documentId)
    const connection = document?.connectionId ? this.connections.get(document.connectionId) : undefined
    return !!document && isQueryDocument(document) && documentProvider(document) === 'bigquery'
      && !!connection && isLiveConnection(connection) && isBigQueryConnection(connection) && cacheKey(connection) === key
  }

  private failure(documentId: string | undefined, key: string, error?: string, source: 'lookup' | 'refresh' = 'lookup'): void {
    if (this.disposed || !documentId) return
    if (!this.isCurrentTarget(documentId, key)) return
    if (error) this.errorMeta.set(documentId, { key, source }); else this.errorMeta.delete(documentId)
    if (this.getSnapshot().errors.get(documentId) === error) return
    const errors = new Map(this.getSnapshot().errors)
    if (error) errors.set(documentId, error); else errors.delete(documentId)
    this.publish({ ...this.getSnapshot(), errors })
  }

  /** Drops the caches of connections gone or reconnected (a new generation), and the errors/refreshes of closed or switched tabs. */
  private reconcile(): void {
    if (this.disposed) return
    const live = new Set(this.connections.getSnapshot().filter(connection => isLiveConnection(connection) && isBigQueryConnection(connection)).map(cacheKey))
    for (const key of [...this.caches.keys()]) if (!live.has(key)) {
      this.caches.delete(key)
      this.cacheEpoch.delete(key)
      this.jumpCaches.delete(key)
      this.hydrateAttempted.delete(key)
      this.externalKnown.delete(key)
      this.hydrateInFlight.delete(key)
      this.batchedJump.delete(key)
      this.ensured.delete(key)
    }
    for (const [id, op] of [...this.refreshOps.entries()]) {
      if (!this.isCurrentTarget(id, op.key)) {
        this.refreshOps.delete(id)
        op.cancel()
      }
    }
    const snapshot = this.getSnapshot()
    const errors = new Map([...snapshot.errors].filter(([id]) => {
      const model = this.documents.modelFor ? this.documents.modelFor(id, 'bigquery') : this.documents.getModel(id)
      const ctx = model ? this.documents.languageContext?.(model, connectionId => this.connections.isLive(connectionId)) : undefined
      const connectionId = ctx ? ctx.connectionId : this.documents.get(id)?.connectionId
      const connection = connectionId ? this.connections.get(connectionId) : undefined
      return !!connection && cacheKey(connection) === this.errorMeta.get(id)?.key
    }))
    for (const id of [...this.errorMeta.keys()]) if (!errors.has(id)) this.errorMeta.delete(id)
    const indexErrors = new Map([...snapshot.indexErrors].filter(([key]) => live.has(key)))
    const indexes = new Map([...snapshot.indexes].filter(([key]) => live.has(key)))
    const refreshing = new Set(this.refreshOps.keys())
    const refreshingChanged = refreshing.size !== snapshot.refreshing.size || [...refreshing].some(id => !snapshot.refreshing.has(id))
    if (errors.size !== snapshot.errors.size || indexErrors.size !== snapshot.indexErrors.size || indexes.size !== snapshot.indexes.size || refreshingChanged) {
      this.publish({ errors, indexErrors, indexes, refreshing })
    }
    this.syncIndexes()
  }

  private syncIndexes(): void {
    if (this.disposed || !this.options.indexState) return
    const raw = this.options.indexState.getSnapshot().indexes
    const snapshot = this.getSnapshot()
    const errors = new Map(snapshot.errors)
    const indexes = new Map(snapshot.indexes)
    const indexErrors = new Map(snapshot.indexErrors)
    let changed = false
    const liveIds = new Set<string>()
    for (const connection of this.connections.getSnapshot()) {
      if (!isLiveConnection(connection) || !isBigQueryConnection(connection)) continue
      liveIds.add(connection.id)
      const entry = raw[connection.id]
      const sig = entry
        ? `${entry.requestId ?? ''}|${entry.status?.state ?? ''}|${entry.status?.builtAt ?? ''}|${entry.status?.objects ?? ''}|${entry.status?.databases ?? ''}|${entry.status?.indexed ?? ''}|${entry.status?.namesOnly?.length ?? 0}|${entry.status?.skipped.length ?? 0}|${entry.error ?? ''}`
        : ''
      const prevSig = this.indexSignatures.get(connection.id) ?? ''
      if (sig !== prevSig) {
        if (sig) this.indexSignatures.set(connection.id, sig); else this.indexSignatures.delete(connection.id)
        this.clearConnectionCaches(cacheKey(connection), true)
      }
      const state: 'none' | 'building' | 'ready' | undefined = entry?.requestId
        ? 'building'
        : entry?.status?.state === 'ready'
          ? 'ready'
          : entry?.status?.state === 'none'
            ? 'none'
            : undefined
      const key = cacheKey(connection)
      if (state) {
        if (indexes.get(key) !== state) { indexes.set(key, state); changed = true }
      } else if (indexes.has(key)) {
        indexes.delete(key); changed = true
      }
      const indexError = entry?.requestId ? undefined : entry?.error
      if (indexError) {
        if (indexErrors.get(key) !== indexError) { indexErrors.set(key, indexError); changed = true }
      } else if (indexErrors.delete(key)) {
        changed = true
      }
      if (sig !== prevSig && !indexError && (state === 'ready' || state === 'building')) {
        for (const [id, meta] of [...this.errorMeta.entries()]) {
          if (meta.key === key && meta.source === 'refresh') {
            this.errorMeta.delete(id)
            if (errors.delete(id)) changed = true
          }
        }
      }
    }
    for (const id of [...this.indexSignatures.keys()]) if (!liveIds.has(id)) this.indexSignatures.delete(id)
    if (changed) this.publish({ ...snapshot, errors, indexes, indexErrors })
  }

  private publishSnapshot(patch: Partial<Pick<Snapshot, 'errors' | 'indexErrors' | 'indexes'>> = {}): void {
    if (this.disposed) return
    const current = this.getSnapshot()
    this.publish({
      errors: patch.errors ?? current.errors,
      indexErrors: patch.indexErrors ?? current.indexErrors,
      indexes: patch.indexes ?? current.indexes,
      refreshing: new Set(this.refreshOps.keys())
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const op of this.refreshOps.values()) op.cancel()
    this.refreshOps.clear()
    this.indexSignatures.clear()
    this.bindings.forEach(binding => binding.dispose())
    this.caches.clear()
    this.cacheEpoch.clear()
    this.jumpCaches.clear()
    this.hydrateAttempted.clear()
    this.externalKnown.clear()
    this.hydrateInFlight.clear()
    for (const slot of this.batchedJump.values()) slot.resolve(undefined)
    this.batchedJump.clear()
    this.clearListeners()
  }
}

const cacheKey = (connection: { readonly id: string; readonly generation: number }) => `${connection.id}:${connection.generation}`

/** Extracts validated `{ project, dataset }` scopes from a query's statements and default dataset. */
export function extractBigQueryRefreshScopes(text: string, billingProject: string, defaultDataset?: string): BigQueryIndexScope[] {
  const scopes: BigQueryIndexScope[] = []
  const seen = new Set<string>()
  const addScope = (project: string, dataset?: string) => {
    if (scopes.length >= indexCompletionLimits.refreshScopes) return
    if (!isBigQueryName('project', project)) return
    if (dataset !== undefined) {
      if (dataset.toUpperCase() === 'INFORMATION_SCHEMA' || !isBigQueryName('dataset', dataset)) return
    }
    const key = `${project}\u0000${dataset ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    scopes.push(dataset !== undefined ? { project, dataset } : { project })
  }
  if (defaultDataset) addScope(billingProject, defaultDataset)
  const dialect = googleSqlDialect({ project: billingProject, dataset: defaultDataset })
  const offsets: number[] = []
  try {
    for (const token of scanGoogleSql(text)) {
      if (token.kind === 'punctuation' && text[token.start] === ';') {
        offsets.push(token.start)
        if (offsets.length >= indexCompletionLimits.refreshStatements) break
      }
    }
  } catch { /* fall through to whole text / billing project */ }
  if (offsets.length < indexCompletionLimits.refreshStatements) offsets.push(text.length)
  for (const offset of offsets) {
    if (scopes.length >= indexCompletionLimits.refreshScopes) break
    let sources: ReturnType<typeof readGoogleSqlStatementSources>
    try { sources = readGoogleSqlStatementSources(text, offset) } catch { continue }
    for (const source of sources) {
      if (source.kind !== 'object') continue
      const path = dialect.objectPath(source.parts)
      if (path && path.length === 3) addScope(path[0], path[1])
    }
    try {
      const read = readGoogleSqlCompletion(text, offset)
      if (read.site.kind === 'object') {
        const { qualifier } = read.site
        if (qualifier.length === 2) addScope(qualifier[0], qualifier[1])
        else if (qualifier.length === 1) {
          if (isBigQueryName('dataset', qualifier[0]) && qualifier[0].toUpperCase() !== 'INFORMATION_SCHEMA') addScope(billingProject, qualifier[0])
          else if (isBigQueryName('project', qualifier[0])) addScope(qualifier[0])
        }
      }
    } catch { /* trailing incomplete qualifier fallback is optional */ }
  }
  if (!scopes.length) addScope(billingProject)
  return scopes
}

function unquoteGoogleSqlName(value: string, quoted = false): string {
  if (!quoted) return value
  const body = value.startsWith('`')
    ? (value.length > 1 && value.endsWith('`') ? value.slice(1, -1) : value.slice(1))
    : value
  return body.replace(/\\(.)/g, '$1')
}

const validLookupSegments = (segments: readonly string[]) =>
  segments.every(segment => segment.length >= 1 && segment.length <= languageLookupLimits.segmentChars)

function resolveMetaFor(
  item: CompletionItem,
  read: ReturnType<typeof readGoogleSqlCompletion>,
  target: Target,
  projectRanks?: ReadonlyMap<string, ProjectRankInfo>
): BigQueryResolveMeta | undefined {
  if (!target.connectionId || !target.key) return undefined
  if (item.kind === 'cte') return { kind: 'cte', target, name: item.label, scope: read.scope }
  if (item.kind === 'alias') {
    const source = read.scope.sources.find(entry => entry.name !== undefined && sameName(entry.name, item.label))
    if (!source) return undefined
    if (source.kind === 'cte') return { kind: 'cte', target, name: source.cte, scope: read.scope }
    if (source.kind === 'object') {
      const path = target.dialect.objectPath(source.parts)
      if (path && path.length === 3 && validLookupSegments(path)) return { kind: 'object', target, path: [path[0], path[1], path[2]] }
    }
    return undefined
  }
  if (read.site.kind !== 'object') return undefined
  const { qualifier } = read.site
  if (item.kind === 'table' || item.kind === 'view' || item.kind === 'routine' || item.kind === 'model') {
    const path = target.dialect.objectPath([...qualifier, item.label])
    if (path && path.length === 3 && validLookupSegments(path)) return { kind: 'object', target, path: [path[0], path[1], path[2]] }
    return undefined
  }
  if (item.kind === 'container') {
    if (qualifier.length === 0) {
      if (projectRanks?.has(item.label) || item.detail?.startsWith('Project')) return validLookupSegments([item.label]) ? { kind: 'project', target, project: item.label } : undefined
      if (target.project && validLookupSegments([target.project, item.label])) return { kind: 'dataset', target, project: target.project, dataset: item.label }
    } else if (qualifier.length === 1 && validLookupSegments([qualifier[0], item.label])) {
      return { kind: 'dataset', target, project: qualifier[0], dataset: item.label }
    }
  }
  return undefined
}

/** Wraps a GoogleSQL dialect so top-level `bqProject` items render PR #738 tier & wave/memory-cap descriptions. */
function wrapProjectTierDialect(dialect: CompletionDialect): CompletionDialect {
  return {
    ...dialect,
    itemDetail(entry: LanguageLookupItem) {
      if (entry.kind === 'bqProject') return formatBigQueryProjectDetail(entry)
      return dialect.itemDetail(entry)
    }
  }
}

const hydrateKey = (item: HydrateTargetRef) => `${item.project}\u0000${item.dataset}\u0000${item.name}`

/** Separates 3-part object lookup answers into auto-hydratable tracked tables (Wave-3 / memory-capped) vs unstarred external projects. */
function classifyLookupTargets(
  lookups: ReadonlyMap<string, { readonly path: readonly string[]; readonly answer: LanguageLookupAnswer }>,
  billingProject?: string,
  externalKnown?: ReadonlySet<string>
): { autoTargets: HydrateTargetRef[]; externalTargets: HydrateTargetRef[] } {
  const autoTargets: HydrateTargetRef[] = []
  const externalTargets: HydrateTargetRef[] = []
  const seenAuto = new Set<string>()
  const seenExternal = new Set<string>()
  for (const { path, answer } of lookups.values()) {
    if (path.length !== 3) continue
    const [project, dataset, name] = path
    if (!isBigQueryName('project', project) || !isBigQueryName('dataset', dataset) || !(isBigQueryName('table', name) || isBigQueryName('routine', name))) continue
    const ref: HydrateTargetRef = { project, dataset, name }
    const key = hydrateKey(ref)
    if (externalKnown?.has(key) && !answer.object && answer.items.length === 0) {
      if (!seenExternal.has(key)) { seenExternal.add(key); externalTargets.push(ref) }
    } else if (answer.object?.detailed === false) {
      if (!seenAuto.has(key)) { seenAuto.add(key); autoTargets.push(ref) }
    } else if ((answer.state === 'building' || answer.state === 'partial') && !answer.object && answer.items.length === 0
      && (!answer.skip || answer.skip === 'CHILDREN_LEFT_OUT' || answer.skip === 'TOO_LARGE')) {
      if (!seenAuto.has(key)) { seenAuto.add(key); autoTargets.push(ref) }
    } else if (answer.state === 'absent' && !answer.object && billingProject && project.toLowerCase() !== billingProject.toLowerCase()) {
      if (!seenExternal.has(key)) { seenExternal.add(key); externalTargets.push(ref) }
    }
  }
  return { autoTargets, externalTargets }
}

/** Chooses the target most relevant to the current caret (`s.|` matches alias `s` first). */
function pickActionTarget(
  read: ReturnType<typeof readGoogleSqlCompletion>,
  dialect: CompletionDialect,
  candidates: readonly HydrateTargetRef[]
): HydrateTargetRef | undefined {
  if (!candidates.length) return undefined
  if (read.site.kind === 'member' && read.site.qualifier.length > 0) {
    const alias = read.site.qualifier[0].toLowerCase()
    for (const source of read.scope.sources) {
      if (source.kind !== 'object' || source.name.toLowerCase() !== alias) continue
      const resolved = dialect.objectPath(source.parts)
      if (!resolved || resolved.length !== 3) continue
      const match = candidates.find(item =>
        item.project.toLowerCase() === resolved[0].toLowerCase()
        && item.dataset.toLowerCase() === resolved[1].toLowerCase()
        && item.name.toLowerCase() === resolved[2].toLowerCase())
      if (match) return match
    }
  }
  return candidates[0]
}

/** One-click completion actions for an unstarred external (or unhydrated) BigQuery table. */
function actionSuggestions(
  monaco: typeof Monaco,
  connectionId: string,
  target: HydrateTargetRef,
  billingProject: string | undefined,
  range: { insert: Monaco.IRange; replace: Monaco.IRange },
  word: Pick<CompletionWord, 'typed'>,
  isMemberSite: boolean
): Monaco.languages.CompletionItem[] {
  const fullPath = `${target.project}.${target.dataset}.${target.name}`
  // Only bind filterText to typed text on empty member sites so expression/join keywords are never hijacked; always preserve typed text on accept.
  const filter = isMemberSite && word.typed ? word.typed : undefined
  const sortPrefix = isMemberSite ? '0:00' : '9:90'
  const items: Monaco.languages.CompletionItem[] = [{
    label: { label: 'Fetch schema (free)', description: `${fullPath} · 0 B billed` },
    kind: monaco.languages.CompletionItemKind[kinds.cte],
    insertText: word.typed,
    detail: `Fetch schema (free) · ${fullPath}`,
    documentation: `Runs one free tables.get metadata call (0 B billed) for \`${fullPath}\` and caches its columns in memory.`,
    sortText: `${sortPrefix}:0:fetch`,
    filterText: filter ?? 'Fetch schema (free)',
    range,
    command: { id: hydrateTableCommandId, title: 'Fetch schema (free)', arguments: [connectionId, target.project, target.dataset, target.name] }
  }]
  if (!billingProject || target.project.toLowerCase() !== billingProject.toLowerCase()) {
    items.push({
      label: { label: `★ Star ${target.project}`, description: 'Add to Starred projects' },
      kind: monaco.languages.CompletionItemKind[kinds.container],
      insertText: word.typed,
      detail: `★ Star ${target.project}`,
      documentation: `Stars \`${target.project}\` for this BigQuery account so Object Explorer and IntelliSense index its datasets automatically.`,
      sortText: `${sortPrefix}:1:star`,
      filterText: filter ?? `Star ${target.project}`,
      range,
      command: { id: starProjectCommandId, title: `★ Star ${target.project}`, arguments: [connectionId, target.project] }
    })
  }
  return items
}

function describeHydrateFailure(project: string, dataset: string, name: string, outcome?: LanguageHydrateOutcome): string {
  const fullPath = `${project}.${dataset}.${name}`
  switch (outcome?.status) {
    case 'notFound':
      return `BigQuery object ${fullPath} was not found.`
    case 'forbidden':
      return `Permission denied while reading metadata for ${fullPath}.`
    case 'budget':
      return `Could not cache metadata for ${fullPath}: the Search Objects RAM cap was reached.`
    case 'throttled':
      return 'BigQuery metadata hydration is temporarily rate-limited. Try again in a moment.'
    default:
      return `Could not fetch metadata for ${fullPath}.`
  }
}

/** Cross-project fuzzy jump item: compact `dataset.table` for billing project or `` `project.dataset.table` `` cross-project. */
function jumpSuggestion(
  monaco: typeof Monaco,
  hit: LanguageLookupItem,
  index: number,
  billingProject: string,
  range: { insert: Monaco.IRange; replace: Monaco.IRange },
  word: Pick<CompletionWord, 'typed' | 'quoted'>,
  canExitBacktick: boolean
): Monaco.languages.CompletionItem {
  const project = hit.project!
  const dataset = hit.dataset!
  const isBilling = project === billingProject
  const kindLabel = (hit.subtype && subtypeLabels[hit.subtype]) || objectLabels[hit.kind] || 'Table'
  const completionKind: CompletionKind = hit.kind === 'bqView' || hit.kind === 'bqMaterializedView' ? 'view'
    : hit.kind === 'bqRoutine' ? 'routine'
    : hit.kind === 'bqModel' ? 'model'
    : 'table'
  const rawInsert = isBilling
    ? (word.quoted ? `${dataset}.${hit.name}` : `${quoteGoogleSqlName(dataset)}.${quoteGoogleSqlName(hit.name)}`)
    : (word.quoted ? `${project}.${dataset}.${hit.name}` : bigQueryPath(project, dataset, hit.name))
  const tierBadge = hit.tier === 'starred' ? '★ Starred' : hit.recent ? 'Recent' : hit.namesOnly ? 'Names only' : 'Discovered'
  const description = isBilling
    ? `${dataset} · ${kindLabel}`
    : `${project}.${dataset} · ${tierBadge} · ${kindLabel}`
  const tierSort = isBilling ? '1' : hit.tier === 'starred' ? '2' : hit.recent ? '3' : '4'
  const typed = word.typed
  const exact = typed.length > 0 && hit.name.toLowerCase() === unquoteGoogleSqlName(typed, word.quoted).toLowerCase()
  const itemRange = canExitBacktick
    ? { insert: { ...range.insert, endColumn: range.insert.endColumn + 1 }, replace: { ...range.replace, endColumn: range.replace.endColumn + 1 } }
    : range
  return {
    label: { label: hit.name, description },
    kind: monaco.languages.CompletionItemKind[kinds[completionKind]],
    insertText: canExitBacktick ? `${rawInsert}\`` : rawInsert,
    detail: description,
    documentation: hit.description,
    sortText: `${exact ? '0' : '1'}:30${tierSort}:${String(index).padStart(3, '0')}:${hit.name.toLowerCase()}`,
    filterText: exact ? typed : word.quoted ? hit.name.replace(/[\\`]/g, '\\$&') : hit.name,
    range: itemRange
  }
}

const escapeSnippet = (value: string) => value.replace(/[\\$}]/g, '\\$&')

/** A pipeline item as Monaco shows it: structured label, icon, exact-match boost, PR #738 tier ordering, typed word ranges, snippets, parameter hints, and backtick exit on leaves. */
function suggestion(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  item: CompletionItem,
  range: { insert: Monaco.IRange; replace: Monaco.IRange },
  word: Pick<CompletionWord, 'typed' | 'quoted' | 'parenAhead'>,
  canExitBacktick: boolean,
  projectRanks?: ReadonlyMap<string, ProjectRankInfo>
): Monaco.languages.CompletionItem {
  const typed = word.typed
  const name = item.filterText ?? item.label
  const exact = typed.length > 0 && name.toLowerCase() === unquoteGoogleSqlName(typed, word.quoted).toLowerCase()
  const description = item.detail?.trim() || undefined
  const exitBacktick = canExitBacktick && leafKinds.has(item.kind)
  const itemRange = exitBacktick
    ? {
        insert: { ...range.insert, endColumn: range.insert.endColumn + 1 },
        replace: { ...range.replace, endColumn: range.replace.endColumn + 1 }
      }
    : range
  let sort = item.sortText
  if (item.kind === 'container' && projectRanks?.has(item.label)) {
    const info = projectRanks.get(item.label)!
    const colon = sort.indexOf(':')
    const head = colon >= 0 ? sort.slice(0, colon + 1) : ''
    const tail = colon >= 0 ? sort.slice(colon + 1) : sort
    sort = `${head}${info.tierRank}:${String(info.order).padStart(4, '0')}:${tail}`
  }
  const routineBacktickCall = exitBacktick && item.kind === 'routine' && !word.parenAhead
  const insertText = routineBacktickCall
    ? `${escapeSnippet(item.insertText)}\`($0)`
    : exitBacktick
      ? `${item.insertText}\``
      : item.insertText
  const isSnippet = item.insertTextIsSnippet === true || routineBacktickCall
  const triggerHints = item.triggerParameterHints === true || routineBacktickCall
  let additionalTextEdits: Monaco.editor.ISingleEditOperation[] | undefined
  if (item.additionalDeleteSpan && item.additionalDeleteSpan.end > item.additionalDeleteSpan.start) {
    const delStart = model.getPositionAt(item.additionalDeleteSpan.start)
    const delEnd = model.getPositionAt(item.additionalDeleteSpan.end)
    additionalTextEdits = [{
      range: {
        startLineNumber: delStart.lineNumber,
        startColumn: delStart.column,
        endLineNumber: delEnd.lineNumber,
        endColumn: delEnd.column
      },
      text: ''
    }]
  }
  return {
    label: description ? { label: item.label, description } : { label: item.label },
    kind: monaco.languages.CompletionItemKind[kinds[item.kind]],
    insertText,
    ...isSnippet ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule?.InsertAsSnippet ?? 4 } : {},
    ...triggerHints ? { command: { id: 'editor.action.triggerParameterHints', title: 'Trigger Parameter Hints' } } : {},
    ...additionalTextEdits ? { additionalTextEdits } : {},
    detail: item.detail,
    documentation: item.documentation,
    sortText: `${exact ? '0' : '1'}:${sort}`,
    filterText: exact ? typed : word.quoted ? name.replace(/[\\`]/g, '\\$&') : item.filterText,
    range: itemRange
  }
}
