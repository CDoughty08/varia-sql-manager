/** mulberry32: a tiny seeded generator, so a failing fuzz input can be replayed from its printed seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** VARIA_FUZZ_SEED replays a run; otherwise every run explores a new seed. */
export function fuzzSeed(): number {
  const fixed = Number(process.env.VARIA_FUZZ_SEED)
  return Number.isInteger(fixed) ? fixed >>> 0 : Math.floor(Math.random() * 4294967296)
}

/** VARIA_FUZZ_ITERATIONS raises (never lowers) the iteration count. */
export function fuzzIterations(defaultCount: number): number {
  const requested = Number(process.env.VARIA_FUZZ_ITERATIONS)
  return Number.isInteger(requested) && requested > defaultCount ? requested : defaultCount
}

export function randomInt(random: () => number, below: number): number { return Math.floor(random() * below) }

/** Mutates a copy of `input`: bit flips, byte insertions and deletions, inflated lengths, or truncation. */
export function mutate(random: () => number, input: Uint8Array): Uint8Array {
  const bytes = Array.from(input)
  const edits = 1 + randomInt(random, 4)
  for (let i = 0; i < edits; i++) {
    const at = randomInt(random, bytes.length + 1)
    switch (randomInt(random, 6)) {
      case 0: if (bytes.length > 0) bytes[Math.min(at, bytes.length - 1)] ^= 1 << randomInt(random, 8); break
      case 1: bytes.splice(at, 0, randomInt(random, 256)); break
      case 2: bytes.splice(at, 1 + randomInt(random, 4)); break
      // A length or count field set to its maximum (or a byte that starts one).
      case 3: bytes.splice(at, 0, ...[[0xdb, 0xff, 0xff, 0xff, 0xff], [0xdd, 0xff, 0xff, 0xff, 0xff], [0xdf, 0xff, 0xff, 0xff, 0xff], [0xc6, 0xff, 0xff, 0xff, 0xff], [0xdd, 0x00, 0x10, 0x00, 0x01]][randomInt(random, 5)]); break
      case 4: bytes.length = Math.min(bytes.length, at); break
      default: bytes.splice(at, 0, ...new Array<number>(1 + randomInt(random, 8)).fill([0x91, 0x81, 0xdc, 0xa1][randomInt(random, 4)])); break
    }
  }
  return new Uint8Array(bytes)
}
