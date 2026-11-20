// @vitest-environment happy-dom
// The execution plan viewer's copies: an outline row as Operator, Object, Estimated subtree cost and Rows, and the Properties
// pane's facts as Name<TAB>Value or values, all formatted by the results text writer.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlanNode } from '../src/shared/plans'
import { CommandService } from '../src/renderer/src/core/commands'
import { plansContribution } from '../src/renderer/src/contributions/plans'
import { outlineCopyText, propertiesCopyText } from '../src/renderer/src/plans/plan-copy'
import { planPropertiesMenu } from '../src/renderer/src/plans/PlanProperties'
import type { MenuTarget } from '../src/renderer/src/menus/targets'
import { defaultSettings } from '../src/shared/settings/catalog'
import type { Workbench } from '../src/renderer/src/core/workbench'

const node = (patch: Partial<PlanNode> = {}): PlanNode => ({ id: 'n1', parentId: null, nodeId: '3', physicalOp: 'Clustered Index Seek', logicalOp: 'Clustered Index Seek', object: '[Sales].[dbo].[Orders].[PK_Orders]',
  estimatedRows: 12, estimatedCost: 0.0032831, actualRows: 1200, elapsedMs: null, cpuMs: null, executions: null, warnings: [], properties: [], ...patch }) as PlanNode

afterEach(() => { getSelection()?.removeAllRanges(); document.body.replaceChildren() })

describe('plan outline copy', () => {
  it('copies an operator as one tab-separated row, after a header line when asked', async () => {
    expect(await outlineCopyText([{ node: node(), partial: false }], { headers: false, crlf: false })).toBe('Clustered Index Seek\t[Sales].[dbo].[Orders].[PK_Orders]\t0.0033\tActual 1,200 rows')
    expect(await outlineCopyText([{ node: node(), partial: false }], { headers: true, crlf: true }))
      .toBe('Operator\tObject\tEstimated subtree cost\tRows\r\nClustered Index Seek\t[Sales].[dbo].[Orders].[PK_Orders]\t0.0033\tActual 1,200 rows')
    // Without actual rows it says what the row flow says; a cost the plan lacks is Unavailable, as Properties shows it.
    expect(await outlineCopyText([{ node: node({ actualRows: null, estimatedCost: null, object: '' }), partial: false }], { headers: false, crlf: false })).toBe('Clustered Index Seek\t\tUnavailable\tEst. 12 rows/exec')
    expect(await outlineCopyText([{ node: node(), partial: true }], { headers: false, crlf: false })).toBe('Clustered Index Seek\t[Sales].[dbo].[Orders].[PK_Orders]\t0.0033\tLive partial 1,200 rows')
  })
})

describe('plan properties copy', () => {
  it('copies Name<TAB>Value lines or the values alone, a tab or line break in a value turned to a space', async () => {
    const facts = [['Node ID', '3'], ['Object', 'a\tb\r\nc']] as const
    expect(await propertiesCopyText(facts, { values: false, crlf: false })).toBe('Node ID\t3\nObject\ta b c')
    expect(await propertiesCopyText(facts, { values: true, crlf: true })).toBe('3\r\na b c')
  })

  function pane() {
    const element = document.createElement('div')
    element.innerHTML = '<h3>Clustered Index Seek</h3><dl><div class="plan-fact"><dt>Node ID</dt><dd>3</dd></div><div class="plan-fact"><dt>Logical operation</dt><dd>Seek</dd></div></dl>'
      + '<details><summary>Memory grant</summary><dl><div class="plan-fact"><dt>GrantedMemory</dt><dd>1024</dd></div></dl></details>'
      + '<details open><summary>Operator properties</summary><dl><div class="plan-fact"><dt>Ordered</dt><dd>True</dd></div></dl></details>'
    document.body.append(element)
    return element
  }
  const fact = (element: HTMLElement, label: string) => [...element.querySelectorAll<HTMLElement>('.plan-fact')].find(item => item.querySelector('dt')?.textContent === label)!

  it('takes the selected facts, else the one right-clicked, else every shown fact', () => {
    const element = pane(), menu = planPropertiesMenu()
    // A closed section's facts are hidden, so they are not copied.
    expect(menu.target(element)).toEqual({ kind: 'planProperties', facts: [['Node ID', '3'], ['Logical operation', 'Seek'], ['Ordered', 'True']] })
    // A fact's own menu (a right-click on it) copies that fact.
    expect(menu.target(element, fact(element, 'Logical operation'))?.facts).toEqual([['Logical operation', 'Seek']])
    // Selected text wins over the fact under the pointer.
    const range = document.createRange()
    range.selectNodeContents(fact(element, 'Node ID'))
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
    expect(menu.target(element, fact(element, 'Ordered'))?.facts).toEqual([['Node ID', '3']])
    expect(menu.target(document.createElement('div'))).toBeNull()
  })

  it('reads the selection as a press began while it is down, then live once it ends', () => {
    const element = pane(), menu = planPropertiesMenu()
    // macOS selects the word under a right-click before the menu opens: the press saw no selection, so the fact clicked.
    menu.press(element)
    const range = document.createRange()
    range.selectNodeContents(fact(element, 'Node ID'))
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
    expect(menu.target(element, fact(element, 'Ordered'))?.facts).toEqual([['Ordered', 'True']])
    // Once the press ends, the selection as it is.
    menu.press(element)
    document.dispatchEvent(new Event('pointerup'))
    expect(menu.target(element, fact(element, 'Ordered'))?.facts).toEqual([['Node ID', '3']])
  })
})

describe('plan copy commands', () => {
  function setup(target: MenuTarget | undefined, values: Partial<typeof defaultSettings> = {}) {
    const commands = new CommandService(), writeClipboardText = vi.fn(async (_text: string) => ({ ok: true as const, value: undefined }))
    const settings = { get: (key: keyof typeof defaultSettings) => ({ ...defaultSettings, ...values })[key] }
    const menuTargets = { targetFor: () => target ? { target, element: document.body } : undefined }
    plansContribution({ commands, settings, menuTargets, platform: 'linux' } as unknown as Workbench, { writeClipboardText })
    return { commands, writeClipboardText }
  }
  const outline = (copy?: (headers: boolean) => Promise<string>): MenuTarget => ({ kind: 'planOutline', ...copy ? { copy } : {} })

  it('copies the focused outline\'s operator with Ctrl+C, headers as Include column headers when copying the results says', async () => {
    const copy = vi.fn(async (headers: boolean) => headers ? 'H\nrow' : 'row')
    const off = setup(outline(copy))
    expect(await off.commands.execute('plan.copyOperator', undefined, 'keybinding')).toBe(true)
    expect(copy).toHaveBeenLastCalledWith(false)
    expect(off.writeClipboardText).toHaveBeenLastCalledWith('row')
    // The save setting does not decide a copy.
    const on = setup(outline(copy), { 'queryResults.grid.copyColumnHeaders': true, 'queryResults.grid.saveColumnHeaders': false })
    expect(await on.commands.execute('plan.copyOperator', { target: outline(copy) }, 'menu')).toBe(true)
    expect(copy).toHaveBeenLastCalledWith(true)
    expect(on.writeClipboardText).toHaveBeenLastCalledWith('H\nrow')
    // No selected operator, or focus elsewhere: nothing to copy.
    expect(setup(outline()).commands.isEnabled('plan.copyOperator')).toBe(false)
    expect(setup(undefined).commands.isEnabled('plan.copyOperator')).toBe(false)
  })

  it('copies the properties the menu was opened on, as names and values or values', async () => {
    const target: MenuTarget = { kind: 'planProperties', facts: [['Node ID', '3'], ['Ordered', 'True']] }
    const { commands, writeClipboardText } = setup(undefined)
    expect(await commands.execute('plan.copyProperties', { target }, 'menu')).toBe(true)
    expect(writeClipboardText).toHaveBeenLastCalledWith('Node ID\t3\nOrdered\tTrue')
    expect(await commands.execute('plan.copyPropertyValues', { target }, 'menu')).toBe(true)
    expect(writeClipboardText).toHaveBeenLastCalledWith('3\nTrue')
    expect(commands.isEnabled('plan.copyProperties', { target: { kind: 'planProperties', facts: [] } })).toBe(false)
  })
})
