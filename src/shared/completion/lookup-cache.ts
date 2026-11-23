// language.lookup's answers kept briefly for one connection, so completion as the user types asks the backend once per word:
// an answer that came back whole for a prefix answers every longer prefix of the same path. Answers from an index that is still
// building are not kept (more names are on their way). Nothing here knows an engine.
import type { LanguageLookupAnswer, LanguageLookupPath, LanguageLookupResult } from '../language-lookup'
import { languageLookupLimits } from '../language-lookup'

interface Entry { readonly request: LanguageLookupPath; readonly answer: LanguageLookupAnswer; readonly at: number }
export const lookupCacheLimits = { entries: 256, ttlMs: 15_000 } as const

const pathKey = (path: readonly string[]) => JSON.stringify(path)
const lower = (text: string | undefined) => (text ?? '').toLowerCase()

/** The answer `entry` gives `request` without asking again, or undefined when it cannot. */
export function answerFrom(entry: Entry, request: LanguageLookupPath): LanguageLookupAnswer | undefined {
  const asked = entry.request
  if (request.details && !asked.details) return
  if (request.exact || asked.exact) {
    return request.exact && asked.exact && request.prefix === asked.prefix && !!request.details === !!asked.details ? entry.answer : undefined
  }
  if (!lower(request.prefix).startsWith(lower(asked.prefix))) return
  const limit = request.limit ?? languageLookupLimits.defaultItems
  const same = lower(request.prefix) === lower(asked.prefix) && limit === (asked.limit ?? languageLookupLimits.defaultItems)
  if (same) return entry.answer
  if (entry.answer.truncated) return
  const prefix = lower(request.prefix)
  const items = entry.answer.items.filter(item => item.name.toLowerCase().startsWith(prefix))
  return { ...entry.answer, items: items.slice(0, limit), truncated: items.length > limit }
}

export class LookupCache {
  private readonly entries = new Map<string, Entry[]>()
  private count = 0
  /** The index's state in the last answer: none, building or ready. */
  index?: LanguageLookupResult['index']

  constructor(private readonly ask: (requests: LanguageLookupPath[], caller?: string) => Promise<LanguageLookupResult | undefined>, private readonly now: () => number = Date.now) {}

  /** One answer per request: the kept ones where they answer it, the backend's for the rest (one call, which gets `caller`, the
   *  editor that asked). Undefined when it failed. */
  async lookup(requests: readonly LanguageLookupPath[], caller?: string): Promise<LanguageLookupAnswer[] | undefined> {
    const now = this.now()
    const answers: (LanguageLookupAnswer | undefined)[] = requests.map(request => this.find(request, now))
    const missing = requests.filter((_, index) => !answers[index])
    if (!missing.length) return answers as LanguageLookupAnswer[]
    const result = await this.ask(missing, caller)
    if (!result) return undefined
    this.index = result.index
    let next = 0
    for (let index = 0; index < requests.length; index++) {
      if (answers[index]) continue
      const answer = result.answers[next++]
      if (!answer) return undefined
      answers[index] = answer
      if (result.index === 'ready' && answer.state !== 'building') this.keep(requests[index], answer, this.now())
    }
    return answers as LanguageLookupAnswer[]
  }

  clear(): void { this.entries.clear(); this.count = 0; this.index = undefined }

  private find(request: LanguageLookupPath, now: number): LanguageLookupAnswer | undefined {
    const kept = this.entries.get(pathKey(request.path))
    if (!kept) return
    for (const entry of kept) {
      if (now - entry.at > lookupCacheLimits.ttlMs || now < entry.at) continue
      const answer = answerFrom(entry, request)
      if (answer) return answer
    }
  }

  private keep(request: LanguageLookupPath, answer: LanguageLookupAnswer, at: number): void {
    const key = pathKey(request.path)
    const kept = (this.entries.get(key) ?? []).filter(entry => at - entry.at <= lookupCacheLimits.ttlMs)
    this.count -= (this.entries.get(key)?.length ?? 0) - kept.length
    kept.unshift({ request, answer, at })
    this.entries.set(key, kept)
    this.count++
    // Past the cap, the oldest path's answers go first (a Map keeps insertion order; re-setting a path keeps its place).
    while (this.count > lookupCacheLimits.entries) {
      const [oldest, list] = this.entries.entries().next().value as [string, Entry[]]
      this.entries.delete(oldest)
      this.count -= list.length
    }
  }
}
