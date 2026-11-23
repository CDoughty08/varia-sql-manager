import { z } from 'zod'
import type { ObjectRef } from '../explorer/refs'
import { boundedRecord } from '../zod-bounds.ts'

/**
 * Hot exit and AutoRecover for SQL Server Agent documents (AG-6g, docs/hot-exit.md › SQL Server Agent documents): a document with unsaved
 * changes is kept as one bounded JSON state (what it targets, the model its draft began from, and the draft), in the same session and
 * AutoRecover records as a query's text, and reopens disconnected on its connection target. Once that target connects, the document reads
 * its object again and puts the user's changes on top (a job changed since opens its compare). Secrets are never part of the state: they
 * live only in the documents' secret slots (SecretSlot), so a restored proxy or credential asks for its password again.
 */
export const keptAgentKinds = ['agentJob', 'agentAlert', 'agentOperator', 'agentOperators', 'agentSchedules', 'agentProxy', 'credential'] as const
export type KeptAgentKind = typeof keptAgentKinds[number]
export const isKeptAgentKind = (kind: string | undefined): kind is KeptAgentKind => !!kind && (keptAgentKinds as readonly string[]).includes(kind)

export const keptAgentLimits = {
  /** One document's state as JSON text: a job's model and draft each hold its steps (at most 1,000,000 command characters). */
  stateChars: 4_194_304,
  nameChars: 128,
  serverChars: 256,
  loginChars: 256
} as const

/** The targets each kind opens on: its object, or the node New (and the Schedules document and the grid) open on. */
const targetKinds: { readonly [K in KeptAgentKind]: readonly string[] } = {
  agentJob: ['agentJob', 'agent'], agentAlert: ['agentAlert', 'agent'], agentOperator: ['agentOperator', 'agent'], agentOperators: ['agent'],
  agentSchedules: ['agent'], agentProxy: ['agentProxy', 'agent'], credential: ['credential', 'server']
}

/** What a document keeps. `model` is the read its draft began from (absent before the first read landed); `draft` is the kind's own. */
export interface KeptAgentState<Model = unknown, Draft = unknown, Extra = unknown> {
  readonly version: 1
  readonly kind: KeptAgentKind
  readonly target: ObjectRef
  readonly server: string
  readonly login?: string
  readonly model: Model
  readonly draft: Draft
  /** The kind's other fields (the grid's base, New Proxy's subsystem, the Schedules document's view and selection). */
  readonly extra?: Extra
}

const envelope = z.object({
  version: z.literal(1),
  kind: z.enum(keptAgentKinds),
  target: z.object({ kind: z.string().min(1).max(64), name: z.string().max(keptAgentLimits.nameChars).optional() }).strict(),
  server: z.string().max(keptAgentLimits.serverChars),
  login: z.string().max(keptAgentLimits.loginChars).optional(),
  model: boundedRecord(z.record(z.string(), z.unknown()), 256),
  draft: z.unknown().refine(value => value !== undefined && value !== null, 'A kept document has a draft.'),
  extra: boundedRecord(z.record(z.string(), z.unknown()), 64).optional()
}).strict()

// Maps (the Operators and notifications grid's matrix) travel as tagged entry lists.
const mapTag = '$map'
const replacer = (_key: string, value: unknown) => value instanceof Map ? { [mapTag]: [...value.entries()] } : value
const reviver = (_key: string, value: unknown) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value)
    const entries = (value as Record<string, unknown>)[mapTag]
    if (keys.length === 1 && keys[0] === mapTag && Array.isArray(entries) && entries.every(entry => Array.isArray(entry) && entry.length === 2)) return new Map(entries as [unknown, unknown][])
  }
  return value
}
/** The JSON that compares two values, Maps included. */
export const keptJson = (value: unknown): string => JSON.stringify(value, replacer) ?? 'undefined'

/** A state as the records keep it, or undefined when it is past `stateChars` (the tab is then asked about on close, as before hot exit). */
export function encodeKeptState(state: KeptAgentState): string | undefined {
  const target: ObjectRef = { kind: state.target.kind, ...state.target.name !== undefined ? { name: state.target.name } : {} }
  const text = JSON.stringify({ ...state, target }, replacer)
  return text.length <= keptAgentLimits.stateChars ? text : undefined
}
/** A kept state read back, checked against its envelope and kind; undefined when it is not one (the tab is then not reopened). */
export function decodeKeptState(text: string, kind: KeptAgentKind): KeptAgentState<Record<string, unknown>, unknown, Record<string, unknown>> | undefined {
  if (text.length > keptAgentLimits.stateChars) return undefined
  let value: unknown
  try { value = JSON.parse(text, reviver) } catch { return undefined }
  const parsed = envelope.safeParse(value)
  if (!parsed.success || parsed.data.kind !== kind || !targetKinds[kind].includes(parsed.data.target.kind)) return undefined
  return parsed.data as KeptAgentState<Record<string, unknown>, unknown, Record<string, unknown>>
}

/** Whether a kept draft has the shape of a draft the document makes itself (`like`): the same keys, each of the same JSON type. */
export function sameShape(like: unknown, value: unknown): boolean {
  const type = (item: unknown) => item instanceof Map ? 'map' : Array.isArray(item) ? 'array' : item === null ? 'null' : typeof item
  if (type(like) !== type(value)) return false
  if (type(like) !== 'object') return true
  const a = like as Record<string, unknown>, b = value as Record<string, unknown>
  // Optional keys (a base the draft began from, say) may be absent on either side; each present one keeps its type.
  return Object.keys(b).every(key => !(key in a) || a[key] === undefined || b[key] === undefined || type(a[key]) === type(b[key]))
    && Object.keys(a).every(key => a[key] === undefined || key in b)
}

/**
 * The user's changes put on the object as read now: each top-level field (or Map entry) the draft changed from `base` (the read it began
 * from) takes the draft's value; every other field takes `current`'s (the read now). A field both changed keeps the user's value, which is
 * what Save then sends; `conflicts` names those whose values differ.
 */
export function rebaseKeptDraft<D>(base: D, current: D, draft: D): { readonly draft: D; readonly conflicts: readonly string[] } {
  const conflicts: string[] = []
  if (current instanceof Map && base instanceof Map && draft instanceof Map) {
    const next = new Map(current)
    for (const key of new Set([...base.keys(), ...draft.keys()])) {
      if (keptJson(base.get(key)) === keptJson(draft.get(key))) continue
      if (keptJson(base.get(key)) !== keptJson(current.get(key)) && keptJson(current.get(key)) !== keptJson(draft.get(key))) conflicts.push(String(key))
      if (draft.has(key)) next.set(key, draft.get(key))
      else next.delete(key)
    }
    return { draft: next as D, conflicts }
  }
  if (!current || typeof current !== 'object' || !base || typeof base !== 'object' || !draft || typeof draft !== 'object') return { draft, conflicts }
  const next: Record<string, unknown> = { ...current as Record<string, unknown> }
  const was = base as Record<string, unknown>, now = current as Record<string, unknown>, mine = draft as Record<string, unknown>
  for (const key of Object.keys(mine)) {
    if (keptJson(was[key]) === keptJson(mine[key])) continue
    if (keptJson(was[key]) !== keptJson(now[key]) && keptJson(now[key]) !== keptJson(mine[key])) conflicts.push(key)
    next[key] = mine[key]
  }
  return { draft: next as D, conflicts }
}

/** The words a restored Agent document shows. */
export const keptAgentText = {
  restored: (noun: string, server: string) => `Your unsaved changes were kept from the last session. Connect to ${server} to read the ${noun} again and save them.`,
  reread: (noun: string) => `Your unsaved changes were restored on the ${noun} as read now.`,
  conflicts: (noun: string) => `Your unsaved changes were restored on the ${noun} as read now. It was also changed on the server since, and where you both changed a value yours is kept: check it before saving.`,
  jobChanged: 'Your unsaved changes were kept from the last session, and the job was changed on the server since. Compare them, then reload keeping your changes or discard them.',
  notReread: (noun: string) => `Your unsaved changes are still on the ${noun} as it was last session. Connect again to read it now before saving.`,
  schedulesGone: (count: number) => `Your unsaved changes were restored on the schedules as read now, except ${count === 1 ? 'one schedule that was' : `${count} schedules that were`} deleted on the server since.`,
  unavailable: 'SQL Server Agent documents kept from the last session are not reopened while SQL Server Agent support is off.',
  unreadable: (name: string) => `${name} could not be reopened: what was kept of it is not a document this version can read.`
} as const
