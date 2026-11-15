import { describe, expect, it } from 'vitest'
import { buildMenuModel, contextMenuIds } from '../src/shared/commands/menus'
import { fitFold, foldWords, toolbarFolds } from '../src/renderer/src/results/ResultsToolbar'
import { argsFor, menuForTarget } from '../src/renderer/src/menus/targets'

describe('results toolbar in a narrow pane', () => {
  it('folds as little as fits, in a fixed order, and all of it when nothing fits', () => {
    // A toolbar that overflows until three folds are applied settles on three; one that never overflows on none.
    expect(fitFold(fold => fold < 3)).toBe(3)
    expect(fitFold(() => false)).toBe(0)
    expect(fitFold(() => true)).toBe(toolbarFolds.length)
    // Tabs gives way first, being also in the ⋯ and Window menus; the Show group last.
    expect(toolbarFolds).toEqual(['layout', 'tight', 'view', 'sort', 'space', 'show'])
    expect(foldWords(0)).toBe('')
    expect(foldWords(3)).toBe('layout tight view')
  })
  it('keeps every tool in reach from the ⋯ menu, Show Results as Tabs first, acting on the toolbar\'s query', () => {
    expect(contextMenuIds).toContain('output.tools')
    expect(menuForTarget.resultsTools).toBe('output.tools')
    expect(argsFor({ kind: 'resultsTools', tabId: 't1' })).toEqual({ tabId: 't1' })
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const items = buildMenuModel('output.tools', platform).map(entry => entry.kind === 'command' ? entry.id : entry.kind === 'separator' ? '-' : entry.kind)
      expect(items).toEqual([
        'output.toggleResultsTabs', 'output.goToResult', '-', 'output.pivot', 'output.compare', 'output.transpose', 'output.transposeChooseHeaders', '-',
        'output.toggleColumnProfile', 'output.toggleRowSize', '-', 'output.showSpaces', 'output.showAllWhitespace', 'output.sortTextByChars', 'output.sortTextByBytes', '-', 'output.closeResults'
      ])
    }
  })
})
