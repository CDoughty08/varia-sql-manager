import type { BigQueryStarredProjectsView } from '../../../shared/bigquery-connections'
import { bigQueryDatasetSchema, bigQueryProjectSchema } from '../../../shared/connections'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { scanGoogleSql, type GoogleSqlToken } from '../../../shared/googlesql/lexer'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

const emptyProjects: readonly string[] = []
/** Bounds for `referencedBigQueryProjects`: scan at most 256 KiB per query tab and extract at most 20 project IDs. */
export const bigQueryReferenceScanLimits = { maxChars: 256 * 1024, maxProjects: 20 } as const

export interface BigQueryStarredServiceOptions {
  readonly api: Pick<VariaApi, 'loadBigQueryStarredProjects' | 'setBigQueryProjectStar'>
}

function copyByPrincipal(source: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  const copy: Record<string, string[]> = Object.create(null)
  for (const [principal, projects] of Object.entries(source)) copy[principal] = [...projects]
  return copy
}

/**
 * Per-principal BigQuery Starred Projects store (mirrors BigQuery Studio's explorer starring UX without altering
 * connection identity). Loads from main (`bigquery-connections.json`) and layers optimistic mutations cleanly on top
 * of the last authoritative snapshot so concurrent mutations never corrupt rollback state.
 */
export class BigQueryStarredService extends SnapshotStore<BigQueryStarredProjectsView> implements Disposable {
  private readonly api: BigQueryStarredServiceOptions['api']
  private disposed = false
  private _loaded = false
  private authoritative: Record<string, string[]> = Object.create(null)
  private authoritativeSeq = 0
  private mutationSeq = 0
  private readonly pending = new Map<string, { readonly principal: string; readonly project: string; readonly starred: boolean; readonly seq: number }>()

  constructor(options: BigQueryStarredServiceOptions) {
    super({ byPrincipal: Object.create(null) })
    this.api = options.api
  }

  /** Whether the initial load from main has settled (used to hold startup tree restore until starred projects arrive). */
  get loaded(): boolean { return this._loaded }

  private compose(): BigQueryStarredProjectsView {
    const byPrincipal = copyByPrincipal(this.authoritative)
    const ordered = [...this.pending.values()].sort((a, b) => a.seq - b.seq)
    for (const op of ordered) {
      const current = byPrincipal[op.principal] ?? []
      if (op.starred) {
        if (!current.includes(op.project)) byPrincipal[op.principal] = [...current, op.project]
      } else {
        const next = current.filter(item => item !== op.project)
        if (next.length) byPrincipal[op.principal] = next
        else delete byPrincipal[op.principal]
      }
    }
    return { byPrincipal }
  }

  /** Loads starred projects from main, updating the authoritative base while preserving any in-flight optimistic edits. */
  async load(): Promise<void> {
    if (this.disposed) return
    const started = ++this.authoritativeSeq
    let result: ApiResult<BigQueryStarredProjectsView>
    try {
      result = await this.api.loadBigQueryStarredProjects()
    } catch {
      this._loaded = true
      return
    }
    if (this.disposed) return
    this._loaded = true
    if (!result.ok || started < this.authoritativeSeq) return
    this.authoritative = copyByPrincipal(result.value.byPrincipal)
    this.publish(this.compose())
  }

  /** Starred project IDs for `principalId`, in saved order. */
  starredFor(principalId: string | undefined): readonly string[] {
    if (!principalId) return emptyProjects
    const byPrincipal = this.getSnapshot().byPrincipal
    return Object.hasOwn(byPrincipal, principalId) ? byPrincipal[principalId]! : emptyProjects
  }

  /** Whether `project` is starred for `principalId`. */
  isStarred(principalId: string | undefined, project: string): boolean {
    if (!principalId) return false
    const byPrincipal = this.getSnapshot().byPrincipal
    return Object.hasOwn(byPrincipal, principalId) ? byPrincipal[principalId]!.includes(project) : false
  }

  /** Optimistically updates starred state for `principalId` and persists through main. */
  async setStarred(principalId: string, project: string, starred: boolean): Promise<ApiResult<BigQueryStarredProjectsView>> {
    if (this.disposed) return { ok: false, error: 'Service is disposed.' }
    const key = `${principalId}\u0000${project}`
    const seq = ++this.mutationSeq
    this.pending.set(key, { principal: principalId, project, starred, seq })
    this.publish(this.compose())
    let result: ApiResult<BigQueryStarredProjectsView>
    try {
      result = await this.api.setBigQueryProjectStar({ principal: principalId, project, starred })
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : 'Could not update starred projects.' }
    }
    if (this.disposed) return result
    if (this.pending.get(key)?.seq === seq) this.pending.delete(key)
    if (result.ok) {
      const auth = ++this.authoritativeSeq
      if (auth === this.authoritativeSeq) this.authoritative = copyByPrincipal(result.value.byPrincipal)
    }
    this.publish(this.compose())
    return result
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pending.clear()
    this.clearListeners()
  }
}

interface ScanTok extends GoogleSqlToken { readonly text: string; readonly upper: string }

/** Keywords immediately preceding a BigQuery table, view, routine or model reference. */
const objectLeadWords = new Set(['FROM', 'JOIN', 'INTO', 'INSERT', 'UPDATE', 'MERGE', 'USING', 'TABLE', 'VIEW', 'FUNCTION', 'PROCEDURE', 'MODEL', 'CALL', 'CLONE', 'COPY', 'LIKE', 'EXISTS'])
/** Keywords that end a FROM clause's comma-separated table list (ON stays inside FROM so `JOIN t2 ON ... , proj.ds.tbl` still parses). */
const fromEndWords = new Set(['WHERE', 'GROUP', 'HAVING', 'QUALIFY', 'WINDOW', 'ORDER', 'LIMIT', 'SET', 'SELECT', 'WHEN', 'OPTIONS', 'UNION', 'INTERSECT', 'EXCEPT', 'USING', 'PIVOT', 'UNPIVOT'])

/** Splits a backtick-quoted identifier into dotted parts while keeping domain-scoped projects (`example.com:proj`) intact. */
function splitQuotedParts(token: ScanTok): string[] {
  if (token.open) return []
  const body = token.text.slice(1, -1).replace(/\\(.)/g, '$1')
  if (!body) return []
  const colon = body.indexOf(':')
  if (colon >= 0) {
    const firstDot = body.indexOf('.', colon + 1)
    if (firstDot < 0) return [body]
    return [body.slice(0, firstDot), ...body.slice(firstDot + 1).split('.')]
  }
  return body.split('.')
}

const isNameTok = (token: ScanTok | undefined): token is ScanTok => !!token && (token.kind === 'word' || token.kind === 'quotedIdentifier')
const isNameOrNumTok = (token: ScanTok | undefined): token is ScanTok => !!token && (token.kind === 'word' || token.kind === 'quotedIdentifier' || token.kind === 'number')
const isPunct = (token: ScanTok | undefined, value: string) => !!token && token.kind === 'punctuation' && token.text === value

/**
 * Pure, bounded scanner that extracts valid BigQuery project IDs explicitly referenced in 3-part object paths
 * (`project.dataset.table`, `` `project.dataset.table` ``, `` `project`.dataset.table ``, `INFORMATION_SCHEMA` paths,
 * or 3-part routine calls including `SAFE.project.dataset.fn(...)`) from GoogleSQL text, skipping comments and string literals.
 */
export function referencedBigQueryProjects(sql: string): string[] {
  if (!sql) return []
  const text = sql.length > bigQueryReferenceScanLimits.maxChars ? sql.slice(0, bigQueryReferenceScanLimits.maxChars) : sql
  const scanned = scanGoogleSql(text)
  // Split dotted number tokens adjacent to names or dashes (`my-proj-2.sales`, `my-proj.2026_sales`, `my-proj-1.2026_sales`).
  const dashedPiece = (index: number) => scanned[index - 1]?.kind === 'punctuation' && text[scanned[index - 1].start] === '-' && scanned[index - 1].end === scanned[index].start
  const touchesPrevName = (index: number) => {
    const before = scanned[index - 1]
    return !!before && before.end === scanned[index].start && (before.kind === 'word' || before.kind === 'quotedIdentifier' || before.kind === 'number')
  }
  const touchesNextName = (index: number) => {
    const after = scanned[index + 1]
    return !!after && scanned[index].end === after.start && (after.kind === 'word' || after.kind === 'quotedIdentifier')
  }
  const toks: ScanTok[] = []
  for (let index = 0; index < scanned.length; index++) {
    const token = scanned[index]
    if (token.kind === 'whitespace' || token.kind === 'comment' || token.kind === 'string') continue
    const raw = text.slice(token.start, token.end)
    if (token.kind === 'number' && raw.includes('.') && (touchesPrevName(index) || touchesNextName(index) || dashedPiece(index))) {
      const dot = raw.indexOf('.')
      if (dot > 0) toks.push({ kind: 'number', start: token.start, end: token.start + dot, text: raw.slice(0, dot), upper: '' })
      toks.push({ kind: 'punctuation', start: token.start + dot, end: token.start + dot + 1, text: '.', upper: '' })
      if (dot + 1 < raw.length) toks.push({ kind: 'number', start: token.start + dot + 1, end: token.end, text: raw.slice(dot + 1), upper: '' })
      continue
    }
    toks.push({ ...token, text: raw, upper: token.kind === 'word' ? raw.toUpperCase() : '' })
  }

  const projects: string[] = []
  const record = (parts: readonly string[]) => {
    if (parts.length < 3) return
    const [project, dataset, third] = parts
    if (!project || !dataset || !third) return
    const isInfoSchema = third.toUpperCase() === 'INFORMATION_SCHEMA' && (bigQueryDatasetSchema.safeParse(dataset).success || /^region-[a-z0-9-]+$/i.test(dataset))
    if (!isInfoSchema && !bigQueryDatasetSchema.safeParse(dataset).success) return
    if (!bigQueryProjectSchema.safeParse(project).success) return
    if (!projects.includes(project)) projects.push(project)
  }

  let inFrom = false
  // Per-paren-depth stack for `inFrom` and whether `(` belongs to EXTRACT(...), so `FROM UNNEST(a) x, proj.ds.tbl` and `FROM (SELECT 1) a, proj.ds.tbl` work.
  const fromStack: boolean[] = []
  const parenExtract: boolean[] = []

  for (let index = 0; index < toks.length && projects.length < bigQueryReferenceScanLimits.maxProjects; index++) {
    const token = toks[index]
    const prev = toks[index - 1]

    if (isPunct(token, '(')) {
      fromStack.push(inFrom)
      parenExtract.push(prev?.kind === 'word' && prev.upper === 'EXTRACT')
      inFrom = false
      continue
    }
    if (isPunct(token, ')')) {
      parenExtract.pop()
      inFrom = fromStack.pop() ?? false
      continue
    }
    if (isPunct(token, ';')) {
      inFrom = false
      fromStack.length = 0
      parenExtract.length = 0
      continue
    }

    if (token.kind === 'word') {
      if (token.upper === 'FROM' && !parenExtract.at(-1)) { inFrom = true; continue }
      if (token.upper === 'JOIN') { inFrom = true; continue }
      if (fromEndWords.has(token.upper)) { inFrom = false; continue }
    }

    if (!isNameTok(token)) continue
    // Do not start mid-chain after a dot (already consumed as part of the preceding chain).
    if (isPunct(prev, '.')) continue

    const isObjectPos = (prev?.kind === 'word' && objectLeadWords.has(prev.upper) && !(prev.upper === 'FROM' && parenExtract.at(-1)))
      || (inFrom && isPunct(prev, ','))

    // Read a possibly dashed segment (`my-proj-2`, `region-us`), digit-leading segment (`2026_sales`), or backtick-quoted token.
    const readSegment = (at: number): { parts: string[]; next: number; singleMultiPart: boolean } => {
      const current = toks[at]
      if (current.kind === 'quotedIdentifier') {
        const quoted = splitQuotedParts(current)
        return { parts: quoted, next: at + 1, singleMultiPart: quoted.length >= 3 }
      }
      let textPart = current.text, end = current.end, next = at + 1
      // Glue adjacent number + word (`2026` + `_sales`) for digit-leading BigQuery datasets/tables.
      while (toks[next] && toks[next].start === end && (toks[next].kind === 'word' || toks[next].kind === 'number')) {
        textPart += toks[next].text
        end = toks[next].end
        next++
      }
      while (isPunct(toks[next], '-') && toks[next].start === end
        && (toks[next + 1]?.kind === 'word' || toks[next + 1]?.kind === 'number')
        && toks[next + 1].start === toks[next].end) {
        textPart += '-' + toks[next + 1].text
        end = toks[next + 1].end
        next += 2
        while (toks[next] && toks[next].start === end && (toks[next].kind === 'word' || toks[next].kind === 'number')) {
          textPart += toks[next].text
          end = toks[next].end
          next++
        }
      }
      return { parts: [textPart], next, singleMultiPart: false }
    }

    const first = readSegment(index)
    const parts: string[] = [...first.parts]
    const singleBacktickMultiPart = first.singleMultiPart
    let cursor = first.next

    while (isPunct(toks[cursor], '.') && isNameOrNumTok(toks[cursor + 1])) {
      const seg = readSegment(cursor + 1)
      parts.push(...seg.parts)
      cursor = seg.next
    }

    const followedByCall = isPunct(toks[cursor], '(')
    if (followedByCall && parts.length >= 4 && parts[0].toUpperCase() === 'SAFE') {
      record(parts.slice(1))
    } else if (parts.length >= 3 && (singleBacktickMultiPart || isObjectPos || followedByCall)) {
      record(parts)
    }
    index = cursor - 1
  }

  return projects
}
