import { describe, expect, it } from 'vitest'
import { shardSuites, smokeSuites, suiteSeconds } from '../scripts/smoke-shards.mjs'

describe('smoke shards', () => {
  it('weighs every suite in test:smoke, and only those', () => {
    expect(Object.keys(suiteSeconds).sort()).toEqual([...smokeSuites()].sort())
  })
  it('splits the suites into shards of similar time, each in test:smoke order', () => {
    const suites = smokeSuites(), total = suites.reduce((sum, suite) => sum + suiteSeconds[suite], 0)
    for (const count of [1, 2, 3, 4]) {
      const shards = shardSuites(suites, count)
      expect(shards).toHaveLength(count)
      expect(shards.flat().sort()).toEqual([...suites].sort())
      for (const shard of shards) {
        expect(shard).toEqual(suites.filter(suite => shard.includes(suite)))
        // Longest first to the lightest shard stays within the longest suite of an even split.
        expect(shard.reduce((sum, suite) => sum + suiteSeconds[suite], 0)).toBeLessThanOrEqual(total / count + Math.max(...Object.values(suiteSeconds)))
      }
    }
    expect(shardSuites(['b', 'a', 'c'], 2, { a: 5, b: 5, c: 9 })).toEqual([['c'], ['b', 'a']])
    expect(shardSuites(['new'], 1, {})).toEqual([['new']])
  })
})
