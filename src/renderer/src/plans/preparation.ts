import type { ApiResult } from '../../../shared/contracts'
import type { ResultKey } from '../results/worker-protocol'
import { planLimits, type PlanDocument } from '../../../shared/plans'
import type { Disposable } from '../core/types'
import type { Camera, PlanLayout } from './geometry'
import { parseSourceXml, PlanInputBudgetError, PlanSourceParseError, type PlanSource, type SourceStatement } from './sources'

export const preparationLimits = { entries: 64, nodes: 20_000, units: 16 * 1024 * 1024, layouts: 32, layoutNodes: 20_000, layoutUnits: 4 * 1024 * 1024 } as const
export interface PreparedSource { document: PlanDocument; characters: number }
export interface SavedPlanView { camera?: Camera; selected: string; statement?: Pick<SourceStatement, 'id' | 'sourceKey'>; xmlSource?: string; query: string }
interface Cached<T> { scope: string; value: T; nodes: number; units: number; results: string[] }
const resultKey = (key: ResultKey) => `${key.generation}:${key.resultId}`
const abort = () => new DOMException('Plan preparation was cancelled.', 'AbortError')

class Budget<T> {
  private readonly entries = new Map<string, Cached<T>>()
  private nodes = 0
  private units = 0
  constructor(private readonly limit: { entries: number; nodes: number; units: number }) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (entry) { this.entries.delete(key); this.entries.set(key, entry) }
    return entry?.value
  }
  set(key: string, entry: Cached<T>): void {
    this.drop((_, id) => id === key)
    if (entry.nodes > this.limit.nodes || entry.units > this.limit.units) return
    this.entries.set(key, entry); this.nodes += entry.nodes; this.units += entry.units
    while (this.entries.size > this.limit.entries || this.nodes > this.limit.nodes || this.units > this.limit.units) {
      const oldest = this.entries.keys().next().value
      this.drop((_, id) => id === oldest)
    }
  }
  drop(matches: (entry: Cached<T>, key: string) => boolean): void {
    for (const [key, entry] of this.entries) if (matches(entry, key)) {
      this.entries.delete(key); this.nodes -= entry.nodes; this.units -= entry.units
    }
  }
  get stats() { return { entries: this.entries.size, nodes: this.nodes, units: this.units } }
}
interface Pending { scope: string; results: string[]; stop: AbortController; promise: Promise<PreparedSource>; users: number; remaining: number; parsing: boolean; complete: boolean }

/** Rendering preparation has its own budgets and lifetime, independent of saved/retained snapshots. No XML is retained. */
export class PlanPreparationCache implements Disposable {
  private readonly parsed = new Budget<PreparedSource>(preparationLimits)
  private readonly layouts = new Budget<PlanLayout>({ entries: preparationLimits.layouts, nodes: preparationLimits.layoutNodes, units: preparationLimits.layoutUnits })
  private readonly pending = new Map<string, Pending>()
  private readonly producers = new Set<Pending>()
  private readonly views = new Map<string, { scope: string; view: SavedPlanView }>()
  private readonly documents = new Map<string, Disposable>()
  private disposed = false
  epoch = 0
  private sourceId(scope: string, source: PlanSource): string { return JSON.stringify([scope, source.key, source.revision]) }
  async prepare(scope: string, source: PlanSource, parse: (xml: string) => Promise<ApiResult<PlanDocument>>, signal: AbortSignal, remaining = planLimits.characters * 2): Promise<PreparedSource> {
    signal.throwIfAborted()
    if (this.disposed) throw abort()
    const key = this.sourceId(scope, source), cached = this.parsed.get(key)
    if (cached) { if (cached.characters > remaining) throw new PlanInputBudgetError(); return cached }
    let pending = this.pending.get(key)
    if (!pending) {
      if (this.producers.size >= preparationLimits.entries) throw new Error('Too many execution plan preparations are already in progress. Retry when the current plans finish.')
      const stop = new AbortController(), results = source.result ? [resultKey(source.result)] : []
      pending = { scope, results, stop, users: 0, remaining, parsing: false, complete: false, promise: undefined! }
      const entry = pending
      this.pending.set(key, entry)
      this.producers.add(entry)
      entry.promise = (async () => {
        const xml = await source.read(stop.signal)
        stop.signal.throwIfAborted()
        if (xml.length > entry.remaining) throw new PlanInputBudgetError()
        entry.parsing = true
        const document = await parseSourceXml(xml, parse, stop.signal)
        stop.signal.throwIfAborted()
        const value = { document, characters: xml.length }
        if (this.pending.get(key) === entry) this.parsed.set(key, { scope, value, results,
          nodes: document.statements.reduce((sum, s) => sum + s.nodes.length, 0), units: JSON.stringify(document).length + key.length })
        return value
      })().finally(() => {
        entry.complete = true; this.producers.delete(entry)
        if (!entry.users && this.pending.get(key) === entry) this.pending.delete(key)
      })
    }
    const entry = pending
    entry.remaining = Math.max(entry.remaining, remaining)
    entry.users++
    return new Promise<PreparedSource>((resolve, reject) => {
      let done = false
      const finish = (value?: PreparedSource, error?: unknown) => {
        if (done) return
        done = true; signal.removeEventListener('abort', cancelled); entry.users--
        // Reads can be cancelled; the unary backend parse cannot. Keep that producer shared until
        // it settles, including across a hide/show, and count invalidated producers against the bound.
        if (!entry.users && this.pending.get(key) === entry && (entry.complete || !entry.parsing)) {
          this.pending.delete(key)
          if (!entry.complete) entry.stop.abort()
        }
        if (error) reject(error); else resolve(value!)
      }
      const cancelled = () => finish(undefined, abort())
      signal.addEventListener('abort', cancelled, { once: true })
      entry.promise.then(value => entry.stop.signal.aborted ? finish(undefined, abort()) : value.characters > remaining ? finish(undefined, new PlanInputBudgetError()) : finish(value),
        error => finish(undefined, entry.stop.signal.aborted ? abort() : error instanceof PlanSourceParseError && error.characters > remaining ? new PlanInputBudgetError() : error))
      if (signal.aborted) cancelled()
    })
  }
  layout(scope: string, topology: string): PlanLayout | undefined { return this.layouts.get(JSON.stringify([scope, topology])) }
  rememberLayout(scope: string, topology: string, value: PlanLayout, sources: readonly PlanSource[], epoch = this.epoch): void {
    if (this.disposed || epoch !== this.epoch) return
    const key = JSON.stringify([scope, topology])
    this.layouts.set(key, { scope, value, nodes: value.nodes.length, units: key.length + value.nodes.length * 80 + value.edges.length * 160,
      results: sources.flatMap(source => source.result ? [resultKey(source.result)] : []) })
  }
  view(identity: string): SavedPlanView | undefined { return this.views.get(identity)?.view }
  rememberView(scope: string, identity: string, view: SavedPlanView): void {
    if (this.disposed) return
    this.views.delete(identity); this.views.set(identity, { scope, view })
    if (this.views.size > 64) this.views.delete(this.views.keys().next().value!)
  }
  watchDocument(scope: string, watch: (changed: () => void) => Disposable): void {
    if (!this.documents.has(scope)) this.documents.set(scope, watch(() => this.forgetScope(scope)))
  }
  forgetScope(scope: string): void {
    this.epoch++
    this.parsed.drop(entry => entry.scope === scope); this.layouts.drop(entry => entry.scope === scope)
    for (const [key, entry] of this.pending) if (entry.scope === scope) { this.pending.delete(key); entry.stop.abort() }
  }
  close(scope: string): void {
    this.forgetScope(scope)
    this.documents.get(scope)?.dispose(); this.documents.delete(scope)
    for (const [key, entry] of this.views) if (entry.scope === scope) this.views.delete(key)
  }
  release(keys: readonly ResultKey[]): void {
    this.epoch++
    const released = new Set(keys.map(resultKey)), matches = (entry: { results: string[] }) => entry.results.some(key => released.has(key))
    this.parsed.drop(matches); this.layouts.drop(matches)
    for (const [key, entry] of this.pending) if (matches(entry)) { this.pending.delete(key); entry.stop.abort() }
  }
  clear(): void {
    this.epoch++
    this.parsed.drop(() => true); this.layouts.drop(() => true)
    for (const entry of this.pending.values()) entry.stop.abort()
    this.pending.clear()
  }
  get stats() { return { parsed: this.parsed.stats, layouts: this.layouts.stats, pending: this.producers.size } }
  dispose(): void { this.disposed = true; this.clear(); this.views.clear(); for (const watcher of this.documents.values()) watcher.dispose(); this.documents.clear() }
}
