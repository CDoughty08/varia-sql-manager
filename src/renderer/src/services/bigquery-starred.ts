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

/**
 * Per-principal BigQuery Starred Projects store (mirrors BigQuery Studio's explorer starring UX without altering
 * connection identity). Loads from main (`bigquery-connections.json`) and applies optimistic updates on star/unstar.
 */
export class BigQueryStarredService extends SnapshotStore<BigQueryStarredProjectsView> implements Disposable {
  private readonly api: BigQueryStarredServiceOptions['api']
  private disposed = false
  private version = 0

  constructor(options: BigQueryStarredServiceOptions) {
    super({ byPrincipal: {} })
    this.api = options.api
  }

  /** Loads starred projects from main; ignores stale answers if a newer mutation ran while loading. */
  async load(): Promise<void> {
    if (this.disposed) return
    const started = this.version
    const result = await this.api.loadBigQueryStarredProjects()
    if (this.disposed || started !== this.version || !result.ok) return
    this.publish(result.value)
  }

  /** Starred project IDs for `principalId`, in saved order. */
  starredFor(principalId: string | undefined): readonly string[] {
    if (!principalId) return emptyProjects
    return this.getSnapshot().byPrincipal[principalId] ?? emptyProjects
  }

  /** Whether `project` is starred for `principalId`. */
  isStarred(principalId: string | undefined, project: string): boolean {
    if (!principalId) return false
    return this.getSnapshot().byPrincipal[principalId]?.includes(project) ?? false
  }

  /** Optimistically updates starred state for `principalId` and persists through main. */
  async setStarred(principalId: string, project: string, starred: boolean): Promise<ApiResult<BigQueryStarredProjectsView>> {
    if (this.disposed) return { ok: false, error: 'Service is disposed.' }
    const previous = this.getSnapshot()
    const current = previous.byPrincipal[principalId] ?? []
    const already = current.includes(project)
    const mutation = ++this.version
    if (starred !== already) {
      const nextList = starred ? [...current, project] : current.filter(item => item !== project)
      const nextByPrincipal: Record<string, readonly string[]> = { ...previous.byPrincipal }
      if (nextList.length) nextByPrincipal[principalId] = nextList
      else delete nextByPrincipal[principalId]
      this.publish({ byPrincipal: nextByPrincipal })
    }
    const result = await this.api.setBigQueryProjectStar({ principal: principalId, project, starred })
    if (this.disposed) return result
    if (result.ok) {
      if (mutation === this.version) this.publish(result.value)
    } else if (mutation === this.version) {
      this.publish(previous)
    }
    return result
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearListeners()
  }
}

interface ScanTok extends GoogleSqlToken { readonly text: string; readonly upper: string }

/** Keywords immediately preceding a BigQuery table, view, routine or model reference. */
const objectLeadWords = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'MERGE', 'USING', 'TABLE', 'VIEW', 'FUNCTION', 'PROCEDURE', 'MODEL', 'CALL', 'CLONE', 'COPY', 'LIKE', 'EXISTS'])
/** Keywords that end a FROM clause's comma-separated table list. */
const fromEndWords = new Set(['WHERE', 'GROUP', 'HAVING', 'QUALIFY', 'WINDOW', 'ORDER', 'LIMIT', 'SET', 'SELECT', 'WHEN', 'OPTIONS', 'UNION', 'INTERSECT', 'EXCEPT', 'ON', 'USING', 'PIVOT', 'UNPIVOT'])

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
const isPunct = (token: ScanTok | undefined, value: string) => !!token && token.kind === 'punctuation' && token.text === value

/**
 * Pure, bounded scanner that extracts valid BigQuery project IDs explicitly referenced in 3-part object paths
 * (`project.dataset.table`, `` `project.dataset.table` ``, `` `project`.dataset.table ``, `INFORMATION_SCHEMA` paths,
 * or 3-part routine calls) from GoogleSQL text, skipping comments and string literals.
 */
export function referencedBigQueryProjects(sql: string): string[] {
  if (!sql) return []
  const text = sql.length > bigQueryReferenceScanLimits.maxChars ? sql.slice(0, bigQueryReferenceScanLimits.maxChars) : sql
  const scanned = scanGoogleSql(text)
  // Split `2.` in unquoted dashed project names (`my-proj-2.sales.orders`) into `2` and `.`, matching scope.ts.
  const dashedPiece = (index: number) => scanned[index - 1]?.kind === 'punctuation' && text[scanned[index - 1].start] === '-' && scanned[index - 1].end === scanned[index].start
  const toks: ScanTok[] = []
  for (let index = 0; index < scanned.length; index++) {
    const token = scanned[index]
    if (token.kind === 'whitespace' || token.kind === 'comment' || token.kind === 'string') continue
    if (token.kind === 'number' && /^\d+\.$/.test(text.slice(token.start, token.end)) && ((scanned[index + 1]?.kind === 'word' && scanned[index + 1].start === token.end) || dashedPiece(index))) {
      const numText = text.slice(token.start, token.end - 1)
      toks.push({ kind: 'number', start: token.start, end: token.end - 1, text: numText, upper: '' })
      toks.push({ kind: 'punctuation', start: token.end - 1, end: token.end, text: '.', upper: '' })
      continue
    }
    const raw = text.slice(token.start, token.end)
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
  // Track whether an open parenthesis belongs to EXTRACT(...) so `EXTRACT(YEAR FROM a.b.c)` is not treated as a table FROM.
  const parenExtract: boolean[] = []

  for (let index = 0; index < toks.length && projects.length < bigQueryReferenceScanLimits.maxProjects; index++) {
    const token = toks[index]
    const prev = toks[index - 1]

    if (isPunct(token, '(')) {
      parenExtract.push(prev?.kind === 'word' && prev.upper === 'EXTRACT')
      inFrom = false
      continue
    }
    if (isPunct(token, ')')) {
      parenExtract.pop()
      inFrom = false
      continue
    }
    if (isPunct(token, ';')) {
      inFrom = false
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

    // Read a possibly dashed segment (`my-proj-2`, `region-us`) or backtick-quoted token, then any `.segment` chain.
    const readSegment = (at: number): { parts: string[]; next: number; singleMultiPart: boolean } => {
      const current = toks[at]
      if (current.kind === 'quotedIdentifier') {
        const quoted = splitQuotedParts(current)
        return { parts: quoted, next: at + 1, singleMultiPart: quoted.length >= 3 }
      }
      let textPart = current.text, end = current.end, next = at + 1
      while (isPunct(toks[next], '-') && toks[next].start === end
        && (toks[next + 1]?.kind === 'word' || toks[next + 1]?.kind === 'number')
        && toks[next + 1].start === toks[next].end) {
        textPart += '-' + toks[next + 1].text
        end = toks[next + 1].end
        next += 2
      }
      return { parts: [textPart], next, singleMultiPart: false }
    }

    const first = readSegment(index)
    const parts: string[] = [...first.parts]
    const singleBacktickMultiPart = first.singleMultiPart
    let cursor = first.next

    while (isPunct(toks[cursor], '.') && isNameTok(toks[cursor + 1])) {
      const seg = readSegment(cursor + 1)
      parts.push(...seg.parts)
      cursor = seg.next
    }

    const followedByCall = isPunct(toks[cursor], '(')
    if (parts.length >= 3 && (singleBacktickMultiPart || isObjectPos || followedByCall)) {
      record(parts)
    }
    index = cursor - 1
  }

  return projects
}
