import type { IndexMemoryDetail, ResultMemoryDetail, ResultMemoryEntry } from '../../../shared/contracts'
import { formatCount } from './status'
import { numberedName } from './ResultsService'

const GiB = 1073741824, MiB = 1048576
export type BytesFormat = (value: number) => string
/** Bytes as the Memory panel shows them, in one unit for everything in a row or section, chosen by its largest figure
 *  (`scale`): gigabytes with two decimals from 1 GB ("2.31 GB / 8.00 GB", "0.21 GB"), whole megabytes below it ("92 MB
 *  / 512 MB"), so figures side by side read alike. */
export function panelBytes(scale: number): BytesFormat {
  if (scale >= GiB) return value => value <= 0 ? '0.00 GB' : value < GiB / 200 ? '<0.01 GB' : `${(value / GiB).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GB`
  return value => value <= 0 ? '0 MB' : value < MiB ? '<1 MB' : `${formatCount(Math.round(value / MiB))} MB`
}
const dash = '—'
/** A whole percentage, rounded; never 100 while some part is missing, nor 0 while there is some. */
const percent = (part: number, whole: number) => {
  const value = whole > 0 ? 100 * part / whole : 0
  if (value > 0 && value < 1) return '<1'
  return formatCount(part < whole ? Math.min(99, Math.round(value)) : Math.min(100, Math.round(value)))
}
/** "2.1 GB" as its number and unit, for a tile's large figure. */
const split = (text: string) => { const at = text.lastIndexOf(' '); return { value: text.slice(0, at), unit: text.slice(at + 1) } }
/** A rate in bytes a second from bytes and microseconds; a dash until something was timed. */
function speed(bytes: number, microseconds: number): string {
  if (bytes <= 0 || microseconds <= 0) return dash
  const perSecond = bytes * 1e6 / microseconds, mb = perSecond / 1048576
  return mb < 1000 ? `${formatCount(mb)} MB/s` : `${(perSecond / 1073741824).toLocaleString('en-US', { maximumFractionDigits: 1 })} GB/s`
}
function duration(microseconds: number): string {
  if (microseconds <= 0) return dash
  const ms = microseconds / 1000
  if (ms < 1) return `${ms.toLocaleString('en-US', { maximumFractionDigits: 2 })} ms`
  // From a tenth of a second up, seconds read more easily than three-digit milliseconds ("0.38 s", as the mock has it).
  return ms < 100 ? `${formatCount(ms)} ms` : `${(ms / 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s`
}

export interface Tile { readonly label: string; readonly value: string; readonly unit?: string; readonly note: string; readonly tone?: 'saved' }
export interface Segment { readonly part: 'raw' | 'packed' | 'cache' | 'returned' | 'records' | 'names' | 'definitions' | 'reading'; readonly label: string; readonly bytes: number; readonly share: number }
export interface Bar { readonly label: string; readonly total: number; readonly segments: readonly Segment[] }
/** A result's name in Biggest results in its two parts: its query tab's, which gives way first, and the Results part. */
export interface ResultLabel { readonly tab?: string; readonly result: string }
export interface BiggestRow { readonly resultId: number; readonly name: string; readonly label: ResultLabel; readonly logical: string; readonly stored: string; readonly state: ResultMemoryEntry['state']; readonly stateLabel: string; readonly logicalShare: number; readonly storedShare: number }
export interface Counter { readonly label: string; readonly value: string }
export interface NerdMetricsModel {
  /** Whether any page is compressed: the ring's second tone, the packed chip and the ratio only show then. */
  readonly compressed: boolean
  readonly codecOn: boolean
  /** Rows as read, what holds them now (stored pages and the decompressed cache), and what compression gave back. */
  readonly logicalBytes: number; readonly memoryBytes: number; readonly givenBack: number
  readonly tiles: readonly Tile[]
  readonly bars: readonly Bar[]
  readonly legend: readonly Segment[]
  readonly biggest: readonly BiggestRow[]
  readonly counters: readonly Counter[]
  readonly heap: string
  /** The unit the section's byte figures share. */
  readonly bytes: BytesFormat
  /** The footer's light line, with the part the panel stresses. */
  readonly cozy: { readonly lead: string; readonly accent?: string }
}

const stateLabels: Readonly<Record<ResultMemoryEntry['state'], string>> = { raw: 'Raw', partial: 'Partly packed', packed: 'Packed', unpacking: 'Unpacking' }
const partLabels: Readonly<Record<Segment['part'], string>> = { raw: 'Raw pages', packed: 'Packed pages', cache: 'Unpacked cache', returned: 'Given back', records: 'Records', names: 'Names', definitions: 'Definitions', reading: 'Being read' }

/** Whether any page is compressed: what the ring's second tone, the packed chip, the ratio and the trend wait for. */
export const anyCompressed = (detail: ResultMemoryDetail | undefined): boolean => !!detail && detail.compressedBytes > 0 && detail.packedLogicalBytes > 0

/** The Nerd metrics section from a results.memory event's detail. Nothing is invented: a figure compression has not
 *  produced yet shows a dash, and the parts that only compression fills are left out until a page is packed. */
export function nerdMetrics(detail: ResultMemoryDetail, name: (entry: ResultMemoryEntry) => ResultLabel): NerdMetricsModel {
  const { logicalBytes: logical, storedBytes: stored, compressedBytes: compressed, packedLogicalBytes: packedLogical, cacheBytes: cache, codec, heap } = detail
  const isCompressed = anyCompressed(detail)
  const codecOn = codec.name !== undefined
  const memory = stored + cache
  const givenBack = Math.max(0, logical - memory)
  const rawBytes = Math.max(0, stored - compressed)
  const ratio = isCompressed ? packedLogical / compressed : 0
  const codecNote = codecOn ? `${codec.name}${codec.level === undefined ? '' : ` · level ${codec.level}`}` : 'Compression off'
  // One unit for the whole section, the managed heap included.
  const bytes = panelBytes(Math.max(logical, memory, heap.committedBytes))
  const saved = split(bytes(givenBack))
  const tiles: Tile[] = [
    { label: 'Compressed', ...logical > 0 ? { value: percent(packedLogical, logical), unit: '%' } : { value: dash }, note: 'of rows, by size' },
    { label: 'Ratio', ...isCompressed ? { value: ratio.toFixed(2), unit: '×' } : { value: dash }, note: codecNote },
    { label: 'Saved', value: saved.value, unit: saved.unit, note: logical > 0 ? `${percent(givenBack, logical)}% of ${bytes(logical)}` : 'No rows held', ...givenBack > 0 ? { tone: 'saved' as const } : {} }
  ]
  // Both bars share one scale, so the lower one's shortfall is what compression gave back.
  const scale = Math.max(logical, memory, 1)
  const segment = (part: Segment['part'], bytes: number): Segment => ({ part, label: partLabels[part], bytes, share: bytes / scale })
  const asRead = [segment('raw', Math.max(0, logical - packedLogical)), segment('packed', packedLogical)].filter(part => part.bytes > 0)
  const now = [segment('raw', rawBytes), segment('packed', compressed), segment('cache', cache), segment('returned', givenBack)].filter(part => part.bytes > 0)
  const legend = [segment('raw', rawBytes), ...[segment('packed', compressed), segment('cache', cache), segment('returned', givenBack)].filter(part => part.bytes > 0)]
  const widest = Math.max(1, ...detail.largest.map(entry => entry.logicalBytes))
  const biggest = detail.largest.map(entry => ({
    resultId: entry.resultId, label: name(entry), name: labelText(name(entry)), logical: bytes(entry.logicalBytes), stored: bytes(entry.storedBytes), state: entry.state,
    stateLabel: entry.state === 'unpacking' && entry.progress !== undefined ? `Unpacking ${entry.progress}%` : stateLabels[entry.state],
    logicalShare: entry.logicalBytes / widest, storedShare: Math.min(entry.storedBytes, entry.logicalBytes) / widest
  }))
  const counters: Counter[] = [
    { label: 'Pages packed', value: formatCount(codec.pagesPacked) },
    { label: 'Pack speed', value: speed(codec.packInputBytes, codec.packMicroseconds) },
    { label: 'Cache hits', value: codec.cacheLookups > 0 ? `${(100 * codec.cacheHits / codec.cacheLookups).toLocaleString('en-US', { maximumFractionDigits: 1 })}%` : dash },
    { label: 'Unpack speed', value: speed(codec.unpackOutputBytes, codec.unpackMicroseconds) },
    { label: 'Last unpack', value: duration(codec.lastUnpackMicroseconds) },
    { label: 'Per page', value: codec.pagesUnpacked > 0 ? duration(codec.unpackMicroseconds / codec.pagesUnpacked) : dash }
  ]
  // The packed pages' ratio, as the Ratio tile: how much tighter compressed rows sit.
  const cozy = isCompressed && ratio >= 1.05 ? { lead: 'Your rows are', accent: `${ratio.toFixed(1)}× cozier` }
    : logical > 0 ? { lead: 'Your rows are', accent: 'stretching out' } : { lead: 'Nothing to tuck in yet' }
  return {
    compressed: isCompressed, codecOn, logicalBytes: logical, memoryBytes: memory, givenBack, tiles,
    bars: [{ label: 'Rows as read', total: logical, segments: asRead }, { label: 'In memory now', total: memory, segments: now }],
    legend, biggest, counters, bytes, cozy,
    // The runtime reports nothing before its first collection: a new backend's heap is unmeasured, not empty.
    heap: heap.committedBytes > 0 ? `Heap ${bytes(heap.committedBytes)} · ${bytes(heap.freeBytes)} free for reuse` : 'Heap not measured yet'
  }
}

export const labelText = (label: ResultLabel): string => label.tab ? `${label.tab} · ${label.result}` : label.result

/** A result's name in Biggest results: its query tab and Results caption ("Query 3 · Result 1", "Query 3 · Open orders")
 *  when a tab shows it; a named one with its number, so two of one name are told apart ("Query 3 · Totals · Result 2"). */
export function resultNames(tabs: Readonly<Record<string, { readonly sets: readonly { readonly descriptor: { readonly generation: number; readonly resultId: number; readonly name?: string }; readonly label?: string; readonly number: number }[] }>>,
  documentName: (tabId: string) => string | undefined, generation: number | undefined): (entry: ResultMemoryEntry) => ResultLabel {
  const names = new Map<number, ResultLabel>()
  for (const [tabId, tab] of Object.entries(tabs)) {
    const document = documentName(tabId)
    for (const set of tab.sets) if (set.descriptor.generation === generation) names.set(set.descriptor.resultId, { ...document ? { tab: document } : {}, result: numberedName(set) })
  }
  return entry => names.get(entry.resultId) ?? { result: entry.live ? 'Live view table' : 'Unlisted result' }
}

/** The Search Indexer part of Nerd metrics, from an explorer.index.memory event's detail. */
export interface IndexNerdModel {
  /** "2 connections · 48,210 objects". */
  readonly aside: string
  readonly tiles: readonly Tile[]
  /** The budget's use by what holds it: records, names, definitions and reads still running. */
  readonly bar: Bar
  readonly counters: readonly Counter[]
  readonly bytes: BytesFormat
}

const plural = (count: number, one: string, many: string) => `${formatCount(count)} ${count === 1 ? one : many}`

/** What the index holds: how much of its definitions is packed and what that saved, where its budget goes, and how much the
 *  shared pool shares. As with results, nothing is invented: a figure with nothing behind it yet shows a dash. */
export function indexNerdMetrics(detail: IndexMemoryDetail): IndexNerdModel {
  const { packedBytes, packedTextBytes, definitionTexts, packedTexts, texts, references } = detail
  const saved = Math.max(0, packedTextBytes - packedBytes)
  const parts = [['records', detail.recordBytes], ['names', detail.nameBytes], ['definitions', detail.definitionBytes], ['reading', detail.readingBytes]] as const
  const total = parts.reduce((sum, [, bytes]) => sum + bytes, 0)
  const bytes = panelBytes(Math.max(total, packedTextBytes))
  const shown = split(bytes(saved))
  const tiles: Tile[] = [
    { label: 'Packed', ...definitionTexts > 0 ? { value: percent(packedTexts, definitionTexts), unit: '%' } : { value: dash }, note: definitionTexts > 0 ? `of ${plural(definitionTexts, 'definition', 'definitions')}` : 'No definitions held' },
    { label: 'Ratio', ...packedBytes > 0 ? { value: (packedTextBytes / packedBytes).toFixed(2), unit: '×' } : { value: dash }, note: 'zstd frames' },
    { label: 'Saved', value: shown.value, unit: shown.unit, note: packedTextBytes > 0 ? `${percent(saved, packedTextBytes)}% of ${bytes(packedTextBytes)}` : 'Nothing packed yet', ...saved > 0 ? { tone: 'saved' as const } : {} }
  ]
  const scale = Math.max(total, 1)
  // Reads still running show only while there are some; the three parts that hold the index always do.
  const segments = parts.filter(([part, value]) => value > 0 || part !== 'reading').map(([part, value]): Segment => ({ part, label: partLabels[part], bytes: value, share: value / scale }))
  const ms = (value: number | undefined) => value === undefined ? dash : duration(value * 1000)
  const counters: Counter[] = [
    { label: 'Pooled texts', value: formatCount(texts) },
    { label: 'Refs per text', value: texts > 0 ? (references / texts).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : dash },
    { label: 'Definitions', value: formatCount(detail.definitions) },
    { label: 'Left out', value: formatCount(detail.cut) },
    { label: 'Without children', value: plural(detail.childrenLeftOut, 'database', 'databases') },
    { label: 'Being read', value: detail.readingBytes > 0 ? bytes(detail.readingBytes) : dash },
    { label: 'Last build', value: ms(detail.lastBuildMs) },
    { label: 'Last search', value: ms(detail.lastSearchMs) }
  ]
  return { aside: `${plural(detail.connections, 'connection', 'connections')} · ${plural(detail.objects, 'object', 'objects')}`, tiles, bar: { label: 'Budget used', total, segments }, counters, bytes }
}
