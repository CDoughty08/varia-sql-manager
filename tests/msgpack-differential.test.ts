// Differential test against @msgpack/msgpack, an independent implementation (owner decision 5: exact-pinned
// devDependency, used only here; tests/ipc-lint.test.ts keeps it out of src/).
import { describe, expect, it } from 'vitest'
import { decode, encode } from '@msgpack/msgpack'
import { decodeControl, encodeControl, forbiddenKeys } from '../src/shared/ipc/wire/msgpack.ts'
import { fuzzIterations, fuzzSeed, mulberry32, randomInt } from './fuzz/prng.ts'

/** A random JSON-shaped value within the control limits: no lone surrogates, -0, undefined, or prototype keys. */
function randomValue(random: () => number, depth: number): unknown {
  const pick = randomInt(random, depth >= 6 ? 6 : 8)
  switch (pick) {
    case 0: return null
    case 1: return random() < 0.5
    case 2: {
      // Integers across every width, both signs.
      const magnitude = [0x10, 0x80, 0x100, 0x10000, 2 ** 32, 2 ** 53][randomInt(random, 6)]
      const value = Math.floor(random() * magnitude) * (random() < 0.4 ? -1 : 1)
      return value === 0 ? 0 : Math.max(-(2 ** 53 - 1), Math.min(2 ** 53 - 1, value))
    }
    case 3: return (random() - 0.5) * 10 ** randomInt(random, 300) + (random() < 0.5 ? 0.5 : 0)
    case 4: case 5: return randomString(random)
    case 6: return Array.from({ length: randomInt(random, random() < 0.1 ? 40 : 6) }, () => randomValue(random, depth + 1))
    default: {
      const value: Record<string, unknown> = {}
      for (let i = randomInt(random, random() < 0.1 ? 40 : 6); i > 0; i--) {
        // Cut by code point: @msgpack/msgpack writes a lone surrogate as WTF-8, where TextEncoder (and so our encoder) writes U+FFFD.
        const key = [...randomString(random)].slice(0, 30).join('')
        if (!forbiddenKeys.has(key)) value[key] = randomValue(random, depth + 1)
      }
      return value
    }
  }
}

const alphabets = ['abcxyz019 _-', 'éüßñ', '€日本語', '😀🎉𝄞', '\u0000\t\n"\\'].map(alphabet => [...alphabet])

function randomString(random: () => number): string {
  const length = random() < 0.003 ? 65_000 + randomInt(random, 1000) : random() < 0.05 ? 32 + randomInt(random, 300) : randomInt(random, 32)
  const parts: string[] = []
  for (let units = 0; units < length;) {
    const alphabet = alphabets[randomInt(random, alphabets.length)]
    const part = alphabet[randomInt(random, alphabet.length)]
    parts.push(part)
    units += part.length
  }
  return parts.join('')
}

describe('MessagePack differential', () => {
  it('matches @msgpack/msgpack byte for byte in both directions', () => {
    const seed = fuzzSeed()
    const random = mulberry32(seed)
    const iterations = fuzzIterations(10_000)
    for (let i = 0; i < iterations; i++) {
      const value = randomValue(random, 0)
      const ours = encodeControl(value)
      const theirs = encode(value)
      expect(Buffer.from(ours).equals(Buffer.from(theirs)), `seed ${seed}, iteration ${i}`).toBe(true)
      expect(decode(ours), `seed ${seed}, iteration ${i}`).toEqual(value)
      expect(decodeControl(theirs), `seed ${seed}, iteration ${i}`).toEqual(value)
    }
  }, Math.max(20_000, 2 * fuzzIterations(10_000)))
})
