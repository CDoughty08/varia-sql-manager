import { afterEach, describe, expect, it } from 'vitest'
import { whitespaceMarkLimit, whitespaceRuns } from '../src/renderer/src/grid/whitespace'
import { workbenchFixture } from './fixtures/workbench'

const shown = (text: string, mode: 'none' | 'spaces' | 'all') => whitespaceRuns(text, mode)?.map(run => run.kind === 'text' ? run.text : run.kind === 'mark' ? `[${run.text}]` : `<${run.text}>`).join('')

describe('results white space', () => {
  it('leaves values alone when off, or when there is nothing to mark', () => {
    expect(whitespaceRuns('a b\tc', 'none')).toBeUndefined()
    expect(whitespaceRuns('abc', 'spaces')).toBeUndefined()
    expect(whitespaceRuns('abc', 'all')).toBeUndefined()
    // Spaces and tabs only: a line break is not theirs to mark.
    expect(whitespaceRuns('a\nb', 'spaces')).toBeUndefined()
    expect(whitespaceRuns('', 'all')).toBeUndefined()
  })
  it('marks each stretch of spaces and tabs as one run, and shows the text between as display text', () => {
    expect(shown('a b', 'spaces')).toBe('a[·]b')
    expect(shown('  lead and trail  ', 'spaces')).toBe('[··]lead[·]and[·]trail[··]')
    expect(shown('a\t b', 'spaces')).toBe('a[→·]b')
    // A line break spaces does not mark stays one line, as the grid shows it when off; control characters stay replaced.
    expect(shown('tab\tline\nquote', 'spaces')).toBe('tab[→]line quote')
    expect(shown('bell\u0007 x', 'spaces')).toBe('bell�[·]x')
  })
  it('names line breaks and invisible characters in all, CR LF as one', () => {
    expect(shown('a\r\nb\nc\rd', 'all')).toBe('a<CRLF>b<LF>c<CR>d')
    expect(shown('\ufeffbom', 'all')).toBe('<BOM>bom')
    expect(shown('no\u00a0break zero\u200bwidth', 'all')).toBe('no<NBSP>break[·]zero<ZWSP>width')
    expect(shown('em\u2003space\u3000ideo', 'all')).toBe('em<U+2003>space<U+3000>ideo')
    expect(shown('\v\f\u0085\u2028\u2029\u2060', 'all')).toBe('<VT><FF><NEL><LS><PS><WJ>')
    // Joiners shape emoji and scripts; they are not white space and stay as they are.
    expect(whitespaceRuns('👩\u200d💻', 'all')).toBeUndefined()
  })
  it('marks only the start of a long value and keeps the rest as text', () => {
    const value = 'x '.repeat(whitespaceMarkLimit)
    const runs = whitespaceRuns(value, 'spaces')!
    expect(runs.map(run => run.text.replace(/·/g, ' ')).join('')).toBe(value)
    expect(runs.at(-1)).toEqual({ kind: 'text', text: value.slice(whitespaceMarkLimit) })
    // White space only past the limit is not looked for.
    expect(whitespaceRuns('x'.repeat(whitespaceMarkLimit) + ' tail', 'all')).toBeUndefined()
  })
})

describe('results white space commands', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => { while (cleanups.length) cleanups.pop()!() })
  const setup = () => { const fixture = workbenchFixture(); cleanups.push(fixture.dispose); return fixture }

  it('choose a mode through settings, turn it off when chosen again, and check the choice that is on', async () => {
    const { commands, api, context, settings } = setup()
    expect([commands.isToggled('output.showSpaces'), commands.isToggled('output.showAllWhitespace')]).toEqual([false, false])
    await commands.execute('output.showSpaces', undefined, 'toolbar')
    expect(settings.getSnapshot().values['queryResults.grid.whitespace']).toBe('spaces')
    expect([context.getState().resultsWhitespaceSpaces, context.getState().resultsWhitespaceAll]).toEqual([true, false])
    await commands.execute('output.showAllWhitespace', undefined, 'menu')
    expect([commands.isToggled('output.showSpaces'), commands.isToggled('output.showAllWhitespace')]).toEqual([false, true])
    await commands.execute('output.showAllWhitespace', undefined, 'palette')
    expect(settings.getSnapshot().values['queryResults.grid.whitespace']).toBe('none')
    expect(api.updateSettings.mock.calls).toEqual([[{ 'queryResults.grid.whitespace': 'spaces' }], [{ 'queryResults.grid.whitespace': 'all' }], [{ 'queryResults.grid.whitespace': 'none' }]])
  })
  it('keep the choice for the session with one warning when settings cannot be saved', async () => {
    const { commands, api, context } = setup()
    api.updateSettings.mockResolvedValue({ ok: false, error: 'The disk is full.' })
    await expect(commands.execute('output.showSpaces', undefined, 'toolbar')).resolves.toBe(true)
    expect(context.getState().resultsWhitespaceSpaces).toBe(true)
    expect(commands.getSnapshot()).toEqual({ error: 'Settings could not be saved: The disk is full. The change applies until you close Varia SQL Manager.', kind: 'warning' })
  })
})
