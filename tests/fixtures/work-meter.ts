/**
 * Counts the work built-in array, typed-array and string methods do while a function runs: the elements and characters
 * they visit or copy, and the typed-array elements allocated. It measures how much work an algorithm does, whatever the
 * runner's speed, garbage collector or scheduler, so a check can bound it by its input's size: growing a buffer by a fixed
 * step, copying an array on every push, sorting, or flattening twice shows as more work, never as a slower clock.
 *
 * Plain loops and property reads cost nothing here, so a check pairs the meter with counts of what it reads (getters on
 * the objects it hands in). The meter patches globals while it runs, so it measures one function at a time.
 */
export interface Work {
  /** Array and typed-array elements visited, copied or sorted (a sort of n counts n·⌈log₂ n⌉). */
  elements: number
  /** Typed-array elements allocated, not counting views of an existing buffer. */
  allocated: number
  /** Typed arrays allocated. */
  allocations: number
  /** String characters scanned, copied or compared. */
  characters: number
  /** Calls of locale-aware, Unicode or regular-expression methods, which cost far more than their length. */
  costly: number
}

type Method = (this: unknown, ...args: unknown[]) => unknown
const sortCost = (length: number) => length * Math.max(1, Math.ceil(Math.log2(Math.max(2, length))))
const lengthOf = (value: unknown): number => {
  if (typeof value === 'string') return value.length
  if (value && typeof value === 'object') {
    const sized = value as { length?: unknown; size?: unknown }
    if (typeof sized.length === 'number') return sized.length
    if (typeof sized.size === 'number') return sized.size
  }
  return 0
}

const arrayScans = ['filter', 'map', 'forEach', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'indexOf', 'lastIndexOf', 'includes', 'reduce', 'reduceRight',
  'join', 'fill', 'reverse', 'flat', 'flatMap', 'copyWithin', 'splice', 'toReversed', 'toSpliced', 'with', 'keys', 'values', 'entries'] as const
const typedScans = ['filter', 'map', 'forEach', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'indexOf', 'lastIndexOf', 'includes', 'reduce', 'reduceRight',
  'join', 'fill', 'reverse', 'copyWithin', 'toReversed', 'with', 'keys', 'values', 'entries'] as const
const stringScans = ['indexOf', 'lastIndexOf', 'includes', 'slice', 'substring', 'substr', 'split', 'toLowerCase', 'toUpperCase', 'trim', 'trimStart', 'trimEnd', 'padStart', 'padEnd',
  'replace', 'replaceAll', 'concat', 'repeat'] as const
const stringCostly = ['toLocaleLowerCase', 'toLocaleUpperCase', 'localeCompare', 'normalize', 'match', 'matchAll', 'search'] as const
const typedConstructors = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'] as const

/** Runs `run` with the meter on and returns its result and the work it did; a promise is metered until it settles. */
export function meterWork<T>(run: () => T): { result: T; work: Work }
export function meterWork<T>(run: () => Promise<T>): Promise<{ result: T; work: Work }>
export function meterWork<T>(run: () => T | Promise<T>): { result: T; work: Work } | Promise<{ result: T; work: Work }> {
  const work: Work = { elements: 0, allocated: 0, allocations: 0, characters: 0, costly: 0 }
  const restores: (() => void)[] = []
  const patch = (owner: object, name: PropertyKey, cost: (self: unknown, args: unknown[]) => void) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name)
    const original = descriptor?.value as Method | undefined
    if (typeof original !== 'function') return
    Object.defineProperty(owner, name, { ...descriptor, value: function (this: unknown, ...args: unknown[]) { cost(this, args); return Reflect.apply(original, this, args) } })
    restores.push(() => Object.defineProperty(owner, name, descriptor!))
  }
  // Off while the meter patches and unpatches, so its own loops are not metered.
  let on = false
  const elements = (count: number) => { if (on) work.elements += count }
  const characters = (count: number) => { if (on) work.characters += count }
  const costly = () => { if (on) work.costly++ }

  const array = Array.prototype as unknown as object
  for (const name of arrayScans) patch(array, name, self => elements(lengthOf(self)))
  patch(array, Symbol.iterator, self => elements(lengthOf(self)))
  patch(array, 'slice', (self, args) => {
    const start = args[0], end = args[1]
    const length = lengthOf(self), from = start === undefined ? 0 : Number(start), to = end === undefined ? length : Number(end)
    const begin = from < 0 ? Math.max(0, length + from) : Math.min(from, length), stop = to < 0 ? Math.max(0, length + to) : Math.min(to, length)
    elements(Math.max(0, stop - begin))
  })
  patch(array, 'concat', (self, args) => {
    let count = lengthOf(self)
    for (let index = 0; index < args.length; index++) count += Array.isArray(args[index]) ? (args[index] as unknown[]).length : 1
    elements(count)
  })
  patch(array, 'sort', self => elements(sortCost(lengthOf(self))))
  patch(array, 'toSorted', self => elements(sortCost(lengthOf(self))))
  patch(Array, 'from', (_, args) => elements(lengthOf(args[0])))

  const typed = Object.getPrototypeOf(Int32Array.prototype) as object
  for (const name of typedScans) patch(typed, name, self => elements(lengthOf(self)))
  patch(typed, Symbol.iterator, self => elements(lengthOf(self)))
  patch(typed, 'set', (_, args) => elements(lengthOf(args[0])))
  patch(typed, 'slice', self => elements(lengthOf(self)))
  patch(typed, 'sort', self => elements(sortCost(lengthOf(self))))
  patch(typed, 'toSorted', self => elements(sortCost(lengthOf(self))))
  const globals = globalThis as unknown as Record<string, unknown>
  for (const name of typedConstructors) {
    const Original = globals[name] as (new (...args: unknown[]) => { length: number }) | undefined
    if (!Original) continue
    const Metered = class extends Original {
      constructor(...args: unknown[]) {
        // Spread would meter itself through the patched array iterator.
        super(args[0], args[1], args[2])
        // A view of an existing buffer (subarray) allocates nothing.
        if (on && !(args[0] instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && args[0] instanceof SharedArrayBuffer))) {
          work.allocations++
          work.allocated += this.length
        }
      }
    }
    globals[name] = Metered
    restores.push(() => { globals[name] = Original })
  }

  const string = String.prototype as unknown as object
  for (const name of stringScans) patch(string, name, self => characters(String(self).length))
  for (const name of ['startsWith', 'endsWith'] as const) patch(string, name, (_, args) => characters(String(args[0]).length))
  for (const name of stringCostly) patch(string, name, self => { costly(); characters(String(self).length) })
  for (const name of ['exec', 'test'] as const) patch(RegExp.prototype, name, (_, args) => { costly(); characters(String(args[0]).length) })

  // A plain loop: the patched methods would meter their own removal.
  const stop = () => { on = false; for (let index = restores.length - 1; index >= 0; index--) restores[index]() }
  let result: T | Promise<T>
  on = true
  try { result = run() } catch (error) { stop(); throw error }
  if (result instanceof Promise) return result.then(value => { stop(); return { result: value, work } }, error => { stop(); throw error })
  stop()
  return { result, work }
}
