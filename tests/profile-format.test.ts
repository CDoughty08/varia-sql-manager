import { describe, expect, it } from 'vitest'
import type { ColumnProfile } from '../src/shared/contracts'
import { chunked, formatSize, histogramHeights, lengthText, profileLines, rowSizeText } from '../src/renderer/src/results/profile-format'

const profile = (over: Partial<ColumnProfile> = {}): ColumnProfile => ({ column: 0, values: 80, nulls: 20, distinct: 80, distinctExact: true, approximate: false, ...over })

describe('profile format', () => {
  it('sizes bytes in B, then KB and MB with one decimal', () => {
    expect([formatSize(0), formatSize(1023), formatSize(1024), formatSize(1536), formatSize(5 * 1024 * 1024)]).toEqual(['0 B', '1,023 B', '1.0 KB', '1.5 KB', '5.0 MB'])
  })

  it('lists NULLs with their share, distinct values (≈ when estimated, unique when every value differs) and the ranges', () => {
    expect(profileLines(profile({ min: 'a', max: 'z', chars: { min: 1, max: 30, average: 12.25, exact: true }, bytes: { min: 2, max: 60, average: 24.5, exact: false } }), 100)).toEqual([
      ['NULLs', '20 (20%)'], ['Distinct', '80 · unique'], ['Min', 'a'], ['Max', 'z'], ['Length', '1 – 30 · avg 12.3'], ['Bytes', '2 – 60 · avg 24.5 (estimated)']
    ])
    expect(profileLines(profile({ nulls: 0, values: 100, distinct: 60_000, distinctExact: false, approximate: true }), 100)).toEqual([
      ['NULLs', '0'], ['Distinct', '≈ 60,000'], ['Note', 'Truncated values counted by their stored prefix']
    ])
    expect(profileLines(profile({ values: 1, distinct: 1 }), 21)[1]).toEqual(['Distinct', '1'])
    expect(lengthText({ min: 4, max: 4, average: 4, exact: true }, true)).toBe('4 B · avg 4 B')
  })

  it('draws every non-empty bucket at least 6 % tall, scaled to the tallest', () => {
    expect(histogramHeights([0, 1, 50, 100])).toEqual([0, 6, 50, 100])
    expect(histogramHeights([0, 0])).toEqual([0, 0])
  })

  it('says the rows\' sizes, and splits columns into requests of at most the limit', () => {
    expect(rowSizeText(undefined)).toBeUndefined()
    expect(rowSizeText({ min: 10, max: 2048, average: 311.6, exact: false })).toBe('Row size: largest 2.0 KB · average 312 B (estimated)')
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunked([], 32)).toEqual([])
  })
})
