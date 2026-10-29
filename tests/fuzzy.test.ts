import { describe, expect, it } from 'vitest'
import { commandDescriptor, commandIds, paletteLabel } from '../src/shared/commands/catalog'
import { compareRanked, fuzzyLimits, mergeRanges, prepareQuery, scoreQuery, type RankedItem } from '../src/renderer/src/quickinput/fuzzy'

const labels = ['File: New Query', 'File: Open File…', 'File: Save', 'File: Save As…', 'File: Close Query', 'Edit: Undo', 'Edit: Redo', 'View: Show Object Explorer',
  'View: Save Layout…', 'View: Reset Layout', 'Query: Execute', 'Query: Cancel Executing Query', 'Query: Change Database…', 'Query: Change Connection…', 'Connection: Connect to Server…']
/** Labels that match `query`, best first, as the palette will order them. */
const rank = (query: string, items: readonly (string | Omit<RankedItem, 'score'>)[] = labels) => items
  .map(item => typeof item === 'string' ? { label: item } : item)
  .flatMap(item => { const match = scoreQuery(query, item.label); return match ? [{ ...item, score: match.score }] : [] })
  .sort(compareRanked).map(item => item.label)
/** The command palette's rows for `query`, best first, with its keywords and title offsets; `disabled` labels rank as unavailable. */
const palette = (query: string, disabled: readonly string[] = []) => commandIds.filter(id => commandDescriptor(id).palette !== false)
  .flatMap(id => {
    const command = commandDescriptor(id), label = paletteLabel(id), match = scoreQuery(query, label, command.keywords, label.length - command.title.length)
    return match ? [{ label, score: match.score, disabled: disabled.includes(label) }] : []
  }).sort(compareRanked).map(item => item.label)
const highlight = (query: string, label: string) => {
  const match = scoreQuery(query, label)!
  return match.ranges.map(([start, end]) => label.slice(start, end))
}

describe('fuzzy matching', () => {
  it('ranks whole words before longer labels and initials', () => {
    expect(rank('exe').slice(0, 2)).toEqual(['Query: Execute', 'Query: Cancel Executing Query'])
    expect(rank('save').slice(0, 3)).toEqual(['File: Save', 'File: Save As…', 'View: Save Layout…'])
    expect(rank('fsa')[0]).toBe('File: Save As…')
    expect(rank('cdb')).toContain('Query: Change Database…')
    expect(rank('save file')).toEqual(['File: Save', 'File: Save As…'])
    expect(rank('file save')).toEqual(rank('save file'))
    expect(rank('qcc')[0]).toBe('Query: Change Connection…')
    expect(rank('zzz')).toEqual([])
  })
  it('ranks the palette by title, keywords, and availability', () => {
    // 'use' is Change Database's keyword; scattered letters in "Uncomment Selection" must not beat it.
    expect(palette('use')[0]).toBe('Query: Change Database…')
    expect(palette('run')[0]).toBe('Query: Execute')
    // A category match is no better than the same words in a title, so an available command wins the tie.
    const explorerCommands = commandIds.map(paletteLabel).filter(label => label.startsWith('Object Explorer: '))
    expect(palette('object explorer', explorerCommands)).toEqual(['View: Show Object Explorer', ...palette('object explorer').filter(label => label !== 'View: Show Object Explorer')])
    expect(palette('object explorer', explorerCommands).slice(1).sort()).toEqual(explorerCommands.filter(label => palette('object explorer').includes(label)).sort())
    expect(palette('exe').slice(0, 2)).toEqual(['Query: Execute', 'Query: Cancel Executing Query'])
    // The word in the title outranks the same word in the category, and in another command's title. Reconnect is
    // unavailable until a connection is lost, so it ranks below the commands that tie with it.
    expect(palette('connect', ['Connection: Reconnect…']).slice(0, 2)).toEqual(['Connection: Connect to Server…', 'Query: Change Connection…'])
    expect(palette('restart')[0]).toBe('Connection: Restart SQL Backend…')
    expect(palette('conn')[0]).toBe('Connection: Connect to Server…')
  })
  it('does not match letters scattered from the middle of words', () => {
    for (const [query, label] of [['refresh', 'Preferences: Reload Themes'], ['go to', 'View: Toggle Word Wrap'], ['go to', 'Edit: Toggle Line Comment'], ['next', 'Query: Cancel Executing Query'],
      ['disc', 'Edit: Comment Selection'], ['tree', 'Edit: Replace'], ['exe', 'View: Next Query']]) {
      expect(palette(query), query).not.toContain(label)
    }
    expect(palette('refresh')).toEqual(['Object Explorer: Refresh', 'Database Properties: Refresh', 'Integration Services: Refresh Properties'])
    expect(palette('go to')[0]).toBe('Go to Query…')
    // The last capital of an acronym starts the next word.
    expect(highlight('q1', 'SQLQuery1.sql')).toEqual(['Q', '1'])
    expect(highlight('hr', 'XMLHttpRequest')).toEqual(['H', 'R'])
    expect(scoreQuery('xh', 'XMLHttp')).toEqual({ score: 70, ranges: [[0, 1], [3, 4]] })
    expect(scoreQuery('mh', 'XMLHttp')).toBeUndefined()
  })
  it('scores substrings, then word starts, then subsequences', () => {
    expect(scoreQuery('file', 'File: Save')).toEqual({ score: 175, ranges: [[0, 4]] })
    expect(scoreQuery('save', 'File: Save')).toEqual({ score: 150, ranges: [[6, 10]] })
    expect(scoreQuery('ave', 'File: Save')).toEqual({ score: 100, ranges: [[7, 10]] })
    expect(scoreQuery('fsa', 'File: Save As…')).toEqual({ score: 75, ranges: [[0, 1], [6, 7], [11, 12]] })
    const subsequence = scoreQuery('cdb', 'Query: Change Database…')!
    expect(subsequence.score).toBeGreaterThan(0)
    expect(subsequence.score).toBeLessThan(60)
    expect(highlight('cdb', 'Query: Change Database…')).toEqual(['C', 'D', 'b'])
    expect(scoreQuery('', 'Anything')).toEqual({ score: 0, ranges: [] })
    expect(scoreQuery('   ', 'Anything')).toEqual({ score: 0, ranges: [] })
  })
  it('prefers an occurrence at a word start', () => {
    expect(scoreQuery('ex', 'Index Explorer')).toEqual({ score: 150, ranges: [[6, 8]] })
    expect(scoreQuery('ob', 'ShowObjectExplorer')).toEqual({ score: 150, ranges: [[4, 6]] })
    expect(scoreQuery('ex', 'a_ex')).toMatchObject({ score: 150 })
    expect(scoreQuery('ql', 'sql(ql)')).toMatchObject({ score: 150, ranges: [[4, 6]] })
  })
  it('compacts subsequences toward the end of the match, keeping the first character at a word start', () => {
    expect(scoreQuery('xyz', 'xaa xbybz')!.ranges).toEqual([[4, 5], [6, 7], [8, 9]])
    expect(scoreQuery('xyz', 'xaaxbybz')!.ranges).toEqual([[0, 1], [5, 6], [7, 8]])
    expect(scoreQuery('xyz', 'x--x-y-z')).toEqual({ score: 75, ranges: [[0, 1], [5, 6], [7, 8]] })
  })
  it('requires every word and matches keywords without highlighting them', () => {
    expect(scoreQuery('run', 'Query: Execute')).toBeUndefined()
    expect(scoreQuery('run', 'Query: Execute', ['run', 'go'])).toEqual({ score: 175 * 0.8, ranges: [] })
    expect(scoreQuery('exec run', 'Query: Execute', ['run'])).toEqual({ score: 150 + 175 * 0.8, ranges: [[7, 11]] })
    expect(scoreQuery('exec walk', 'Query: Execute', ['run'])).toBeUndefined()
    expect(scoreQuery('execute', 'Query: Execute', ['execute'])).toEqual({ score: 150, ranges: [[7, 14]] })
    // A keyword match counts when it beats a weak label match, and then highlights nothing.
    expect(scoreQuery('use', 'Edit: Uncomment Selection')!.score).toBeLessThan(60)
    expect(scoreQuery('use', 'Edit: Uncomment Selection', ['use'])).toEqual({ score: 175 * 0.8, ranges: [] })
  })
  it('matches a keyword only from a word start, since nothing on the row shows why it matched', () => {
    expect(scoreQuery('ss', 'View: Show Query Output', ['results', 'messages'])).toBeUndefined()
    expect(scoreQuery('mess', 'View: Show Query Output', ['results', 'messages'])).toEqual({ score: 175 * 0.8, ranges: [] })
    expect(scoreQuery('nw', 'Query: Execute', ['new window'])).toMatchObject({ ranges: [] })
    for (const query of ['sa', 'ss', 'ages']) expect(palette(query), query).not.toContain('View: Show Query Output')
    expect(palette('messages')).toEqual(['View: Show Query Output'])
  })
  it('gives the start bonus at the start of the title, after a category', () => {
    expect(scoreQuery('file', 'File: Save', [], 6)).toEqual({ score: 150, ranges: [[0, 4]] })
    expect(scoreQuery('save', 'File: Save', [], 6)).toEqual({ score: 175, ranges: [[6, 10]] })
    // When the category starts with the same word, the match and its highlight are in the title.
    expect(scoreQuery('connect', 'Connection: Connect to Server…', [], 12)).toEqual({ score: 175, ranges: [[12, 19]] })
    expect(scoreQuery('conn', 'Connection: Disconnect from Server…', [], 12)).toEqual({ score: 150, ranges: [[0, 4]] })
  })
  it('ignores case and keeps offsets for characters whose lowercase is longer', () => {
    expect(scoreQuery('SAVE', 'File: save')).toMatchObject({ ranges: [[6, 10]] })
    expect(highlight('x', 'İİx')).toEqual(['x'])
    expect(scoreQuery('i̇', 'İ')).toBeUndefined()
    expect(highlight('ab', 'ÀÉ ab')).toEqual(['ab'])
  })
  it('returns sorted, disjoint ranges inside the label', () => {
    for (const [query, label] of [['save save', 'File: Save'], ['ex exe', 'Query: Cancel Executing Query'], ['a b c', 'abc cba'], ['qc qce', 'Query: Cancel Executing Query']]) {
      const match = scoreQuery(query, label)!
      match.ranges.forEach(([start, end], index) => {
        expect(start, query).toBeGreaterThanOrEqual(index ? match.ranges[index - 1][1] + 1 : 0)
        expect(end, query).toBeGreaterThan(start)
        expect(end, query).toBeLessThanOrEqual(label.length)
      })
    }
    expect(mergeRanges([[5, 8], [0, 2], [2, 3], [7, 12], [-4, -1], [20, 30]], 10)).toEqual([[0, 3], [5, 10]])
  })
  it('caps the query, its words, labels, and keywords', () => {
    expect(prepareQuery('  a b c d e f g h i j ').words).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    expect(prepareQuery('x'.repeat(1000)).words).toEqual(['x'.repeat(fuzzyLimits.query)])
    const started = performance.now()
    expect(scoreQuery('y'.repeat(1_000_000), 'z'.repeat(1_000_000))).toBeUndefined()
    expect(scoreQuery('z', 'y'.repeat(1_000_000) + 'z')).toBeUndefined()
    expect(scoreQuery('a', 'b', ['b'.repeat(1_000_000) + 'a'])).toBeUndefined()
    expect(scoreQuery('a', 'b', [...Array.from({ length: 16 }, () => 'b'), 'a'])).toBeUndefined()
    expect(scoreQuery('a', 'b', [...Array.from({ length: 15 }, () => 'b'), 'a'])).toMatchObject({ ranges: [] })
    expect(performance.now() - started).toBeLessThan(500)
  })
  it('scores 5,000 labels for a three-word query in under 200 ms', () => {
    const words = ['Execute', 'Database', 'Server', 'Query', 'Layout', 'Change', 'Object', 'Explorer', 'Window', 'Theme', 'Connect', 'Restore', 'Backup', 'Index']
    const items = Array.from({ length: 5000 }, (_, index) => `${words[index % 14]}: ${words[(index * 7) % 14]} ${words[(index * 3) % 14]} ${index} ${'detail '.repeat(index % 40)}`)
    const run = () => {
      const started = performance.now(), prepared = prepareQuery('xpl dtl 9')
      let matches = 0
      for (const label of items) if (scoreQuery(prepared, label, ['keyword', 'other'])) matches++
      return { elapsed: performance.now() - started, matches }
    }
    const runs = [run(), run(), run()]
    expect(runs[0].matches).toBeGreaterThan(100)
    expect(Math.min(...runs.map(result => result.elapsed))).toBeLessThan(200)
  })
})

describe('ranking', () => {
  it('orders by score, enabled, recent use, length, then alphabetically', () => {
    const item = (label: string, score: number, extra: Partial<RankedItem> = {}): RankedItem => ({ label, score, ...extra })
    const sorted = [item('b', 10), item('a', 10), item('long label', 10), item('disabled', 50, { disabled: true }), item('recent', 10, { recentRank: 1 }), item('top', 50), item('recent0', 10, { recentRank: 0 })]
      .sort(compareRanked).map(entry => entry.label)
    expect(sorted).toEqual(['top', 'disabled', 'recent0', 'recent', 'a', 'b', 'long label'])
    expect(rank('save', [{ label: 'File: Save', disabled: true }, { label: 'File: Save As…' }])).toEqual(['File: Save As…', 'File: Save'])
    expect(rank('save', [{ label: 'File: Save' }, { label: 'File: Save As…', recentRank: 0 }])).toEqual(['File: Save As…', 'File: Save'])
  })
})
