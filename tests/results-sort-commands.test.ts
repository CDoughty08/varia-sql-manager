import { afterEach, describe, expect, it } from 'vitest'
import { workbenchFixture } from './fixtures/workbench'

describe('results sort text commands', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => { while (cleanups.length) cleanups.pop()!() })
  const setup = () => { const fixture = workbenchFixture(); cleanups.push(fixture.dispose); return fixture }

  it('choose a mode through settings, go back to Value when chosen again, and check the choice that is on', async () => {
    const { commands, api, context, settings } = setup()
    expect([commands.isToggled('output.sortTextByChars'), commands.isToggled('output.sortTextByBytes')]).toEqual([false, false])
    await commands.execute('output.sortTextByChars', undefined, 'toolbar')
    expect(settings.getSnapshot().values['queryResults.grid.sortText']).toBe('chars')
    expect([context.getState().resultsSortTextChars, context.getState().resultsSortTextBytes]).toEqual([true, false])
    await commands.execute('output.sortTextByBytes', undefined, 'palette')
    expect([commands.isToggled('output.sortTextByChars'), commands.isToggled('output.sortTextByBytes')]).toEqual([false, true])
    await commands.execute('output.sortTextByBytes', undefined, 'toolbar')
    expect(settings.getSnapshot().values['queryResults.grid.sortText']).toBe('value')
    expect(api.updateSettings.mock.calls).toEqual([[{ 'queryResults.grid.sortText': 'chars' }], [{ 'queryResults.grid.sortText': 'bytes' }], [{ 'queryResults.grid.sortText': 'value' }]])
  })
  it('offer the grid\'s sort commands only where there is a column to sort', () => {
    const { commands } = setup()
    // No results tab, no active cell: nothing to sort or clear.
    for (const id of ['output.sortAscending', 'output.sortDescending', 'output.thenSortAscending', 'output.thenSortDescending', 'output.clearSort'] as const) expect(commands.isEnabled(id), id).toBe(false)
  })
})
